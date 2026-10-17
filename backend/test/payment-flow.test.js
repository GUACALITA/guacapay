// Pay by email (prompt 22): sender wallet to custody, claim, custody to recipient. Fake Open Payments calls; no network.
// NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const CUSTODY_WALLET_ID = 'custody-wallet-test';
const CUSTODY_ADDRESS = 'https://wallet.example.test/custody';
const GOOD_DESTINATION = 'https://ilp.interledger-test.dev/71dd8185';
const AUTH = 'https://auth.example.test';

const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-payment-flow-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.PAYMENT_CURRENCIES = 'EUR';
process.env.BASE_URL = 'https://guacapay.test';
process.env.CUSTODY_WALLET_ID = CUSTODY_WALLET_ID;
process.env.CUSTODY_WALLET_ADDRESS = CUSTODY_ADDRESS;

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { seal } = await import('../src/grants/seal.js');
const { createPayment } = await import('../src/payments/service.js');
const { payFromWallet, payoutToRecipient } = await import('../src/transfers/payments.js');
const { issueClaim, verifyClaimEmail, confirmClaim } = await import('../src/claims/service.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeUser() {
  const id = randomUUID();
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@example.com`);
  return id;
}

// A wallet row with an active permission. Each wallet URL is unique.
function makeWallet(userId, { id = randomUUID(), status = 'linked' } = {}) {
  const db = getDb();
  const url = `${AUTH}/wallet-${id}`;
  db.prepare(
    `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
     VALUES (?, ?, ?, 'EUR', 2, ?, ?)`,
  ).run(id, userId, url, status, new Date().toISOString());
  db.prepare(
    `INSERT INTO grants (id, wallet_id, purpose, status, nonce_hash, access_token_enc, granted_at)
     VALUES (?, ?, 'link', 'granted', 'x', ?, ?)`,
  ).run(randomUUID(), id, seal('access-token'), new Date().toISOString());
  return id;
}

const systemUser = makeUser();
makeWallet(systemUser, { id: CUSTODY_WALLET_ID });

// Records what the fake network was asked to do. Outgoing payments are numbered in creation order.
// outgoingPlan gives each one's state by number: COMPLETED, FAILED or SENDING. Missing entries mean COMPLETED.
function fakeNetwork({ outgoingPlan = [], pollTimeoutMs = 1000 } = {}) {
  const calls = { incoming: 0, quote: 0, outgoing: 0 };
  const deps = {
    async readWallet(url) {
      return { id: url, assetCode: 'EUR', assetScale: 2, authServer: AUTH, resourceServer: `${AUTH}/rs` };
    },
    async requestGrant() {
      return 'token';
    },
    async createIncoming() {
      calls.incoming += 1;
      return { id: `incoming-${calls.incoming}` };
    },
    async createQuote() {
      calls.quote += 1;
      return { id: `quote-${calls.quote}` };
    },
    async createOutgoing() {
      calls.outgoing += 1;
      return { id: `outgoing-${calls.outgoing}` };
    },
    async getOutgoing({ url }) {
      const number = Number(url.split('-').pop());
      return { state: outgoingPlan[number - 1] ?? 'COMPLETED' };
    },
    sleep: async () => {},
    now: () => Date.now(),
    pollTimeoutMs,
    pollIntervalMs: 1000,
  };
  return { calls, deps };
}

function fakeMailer() {
  const sent = { codes: [], links: [], confirmations: [] };
  return {
    sent,
    async sendLoginCode(email, code) {
      sent.codes.push({ email, code });
    },
    async sendClaimLink(email, link) {
      sent.links.push({ email, link });
    },
    async sendPaymentConfirmation(email) {
      sent.confirmations.push({ email });
    },
  };
}

function newPayment(senderId, amountCents = 2500) {
  const recipient = `recipient-${randomUUID()}@example.com`;
  const { payment } = createPayment({
    senderId,
    body: { recipient_email: recipient, amount_cents: amountCents, currency: 'EUR' },
  });
  return { id: payment.id, recipient };
}

function statusOf(paymentId) {
  return getDb().prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status;
}

function transfersOf(paymentId) {
  return getDb()
    .prepare('SELECT direction, status FROM transfers WHERE payment_id = ? ORDER BY rowid')
    .all(paymentId);
}

function recordedEvents(paymentId) {
  return getDb()
    .prepare("SELECT payload_json FROM payment_events WHERE payment_id = ? AND type = 'transfer.recorded' ORDER BY id")
    .all(paymentId)
    .map((row) => JSON.parse(row.payload_json));
}

// Issues the claim link, verifies the recipient by email, and confirms the claim with a destination.
async function claimAs(recipient, paymentId, net, mailer) {
  await issueClaim(paymentId, { mailer });
  const token = new URL(mailer.sent.links.at(-1).link).searchParams.get('token');
  await verifyClaimEmail({ token, email: recipient, mailer });
  const code = mailer.sent.codes.at(-1).code;
  return confirmClaim({
    token,
    code,
    destination: GOOD_DESTINATION,
    transfer: (input) => payoutToRecipient({ ...input, deps: net.deps }),
    mailer,
  });
}

test('a payment goes from the sender wallet to custody, then to the recipient, and completes', async () => {
  const alice = makeUser();
  const sender = makeWallet(alice);
  const payment = newPayment(alice);
  const net = fakeNetwork();
  const mailer = fakeMailer();

  const paid = await payFromWallet({ paymentId: payment.id, userId: alice, walletId: sender, deps: net.deps });
  assert.equal(paid.status, 'paid');
  assert.equal(statusOf(payment.id), 'paid');

  const result = await claimAs(payment.recipient, payment.id, net, mailer);
  assert.equal(result.status, 'completed');
  assert.equal(statusOf(payment.id), 'completed');

  assert.deepEqual(transfersOf(payment.id), [
    { direction: 'in', status: 'completed' },
    { direction: 'out', status: 'completed' },
  ]);
  assert.equal(recordedEvents(payment.id).length, 2, 'both transfers are in the event log');
  assert.equal(net.calls.outgoing, 2, 'one outgoing payment per transfer');
  assert.equal(mailer.sent.confirmations.length, 1);
});

test('a failed second transfer marks the payment failed; the first transfer stays completed', async () => {
  const alice = makeUser();
  const sender = makeWallet(alice);
  const payment = newPayment(alice);
  const net = fakeNetwork({ outgoingPlan: ['COMPLETED', 'FAILED'] });
  const mailer = fakeMailer();

  await payFromWallet({ paymentId: payment.id, userId: alice, walletId: sender, deps: net.deps });
  const result = await claimAs(payment.recipient, payment.id, net, mailer);

  assert.equal(result.status, 'failed');
  assert.equal(statusOf(payment.id), 'failed');
  assert.deepEqual(transfersOf(payment.id), [
    { direction: 'in', status: 'completed' },
    { direction: 'out', status: 'failed' },
  ]);
  assert.equal(mailer.sent.confirmations.length, 0, 'no completion email for a failed payment');
});

test('a payment is not paid until its first transfer completes, and a retry resumes it without a second send', async () => {
  const alice = makeUser();
  const sender = makeWallet(alice);
  const payment = newPayment(alice);

  const slow = fakeNetwork({ outgoingPlan: ['SENDING'], pollTimeoutMs: 0 });
  const first = await payFromWallet({ paymentId: payment.id, userId: alice, walletId: sender, deps: slow.deps });
  assert.equal(first.status, 'awaiting_payment');
  assert.equal(statusOf(payment.id), 'awaiting_payment', 'not paid while the transfer is still running');

  const later = fakeNetwork();
  const second = await payFromWallet({ paymentId: payment.id, userId: alice, walletId: sender, deps: later.deps });
  assert.equal(second.status, 'paid');
  assert.equal(statusOf(payment.id), 'paid');
  assert.equal(slow.calls.outgoing + later.calls.outgoing, 1, 'only one outgoing payment was ever created');
});

test('a wallet that is not linked to the sender is refused before any money call', async () => {
  const alice = makeUser();
  const payment = newPayment(alice);
  const net = fakeNetwork();

  await assert.rejects(
    () => payFromWallet({ paymentId: payment.id, userId: alice, walletId: randomUUID(), deps: net.deps }),
    (err) => err.code === 'wallet_not_linked',
  );
  assert.equal(net.calls.incoming, 0);
  assert.equal(statusOf(payment.id), 'created');
});
