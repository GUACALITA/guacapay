// Split payments (prompt 27). Temporary database, fake Open Payments calls and fake mail, no network. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const AUTH = 'https://auth.example.test';
const CUSTODY_ID = 'custody-splits-test';
const CUSTODY_ADDRESS = 'https://wallet.example.test/custody-splits';

const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-splits-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.PAYMENT_CURRENCIES = 'EUR';
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.BASE_URL = 'https://guacapay.test';
process.env.CUSTODY_WALLET_ID = CUSTODY_ID;
process.env.CUSTODY_WALLET_ADDRESS = CUSTODY_ADDRESS;

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { seal } = await import('../src/grants/seal.js');
const { createSplit, getSplit } = await import('../src/splits/service.js');
const { AppError } = await import('../src/errors.js');

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

// A linked wallet with an active permission (the payer's wallet must have one to pay).
function makeWallet(userId, id = randomUUID(), { withGrant = true } = {}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
     VALUES (?, ?, ?, 'EUR', 2, 'linked', ?)`,
  ).run(id, userId, id === CUSTODY_ID ? CUSTODY_ADDRESS : `${AUTH}/wallet-${id}`, new Date().toISOString());
  if (withGrant) {
    db.prepare(
      `INSERT INTO grants (id, wallet_id, purpose, status, nonce_hash, access_token_enc, granted_at)
       VALUES (?, ?, 'link', 'granted', 'x', ?, ?)`,
    ).run(randomUUID(), id, seal('access-token'), new Date().toISOString());
  }
  return id;
}

// The custody wallet, so the parts can be paid into it.
makeWallet(makeUser(), CUSTODY_ID);

// Counts outgoing payments. outgoingPlan gives each one's state by number; missing entries mean COMPLETED.
function fakeNetwork({ outgoingPlan = [] } = {}) {
  const calls = { outgoing: 0 };
  const deps = {
    async readWallet(url) {
      return { id: url, assetCode: 'EUR', assetScale: 2, authServer: AUTH, resourceServer: `${AUTH}/rs` };
    },
    async requestGrant() {
      return 'token';
    },
    async createIncoming() {
      return { id: `incoming-${randomUUID()}` };
    },
    async createQuote() {
      return { id: `quote-${randomUUID()}` };
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
    pollTimeoutMs: 1000,
    pollIntervalMs: 1000,
  };
  return { calls, deps };
}

function fakeMailer() {
  const sent = { links: [] };
  return {
    sent,
    async sendLoginCode() {},
    async sendClaimLink(email, link) {
      sent.links.push({ email, link });
    },
    async sendPaymentConfirmation() {},
  };
}

function parts(...amounts) {
  return amounts.map((amount, i) => ({ recipient_email: `friend${i + 1}-${randomUUID()}@example.com`, amount_cents: amount }));
}

function countFor(payerId) {
  const db = getDb();
  return {
    splits: db.prepare('SELECT COUNT(*) AS n FROM split_payments WHERE payer_user_id = ?').get(payerId).n,
    children: db
      .prepare('SELECT COUNT(*) AS n FROM payments WHERE sender_id = ? AND parent_split_id IS NOT NULL')
      .get(payerId).n,
  };
}

test('parts that add up create one child payment per recipient, each paid and ready to claim', async () => {
  const payer = makeUser();
  const wallet = makeWallet(payer);
  const mailer = fakeMailer();
  const list = parts(1200, 800, 500);

  const { split, created } = await createSplit({
    payerId: payer,
    body: { total_cents: 2500, currency: 'EUR', parts: list },
    walletId: wallet,
    mailer,
    deps: fakeNetwork().deps,
  });

  assert.equal(created, true);
  assert.equal(split.children.length, 3);
  assert.deepEqual(
    split.children.map((c) => [c.recipient_email, c.amount_cents]),
    list.map((p) => [p.recipient_email, p.amount_cents]),
  );
  assert.ok(split.children.every((c) => c.status === 'claimable'), 'each part is paid and ready to claim');
  assert.equal(split.status, 'pending', 'the split waits for the claims');
  assert.equal(mailer.sent.links.length, 3, 'one claim link per recipient');
});

test('parts that do not add up are refused, and nothing is created', async () => {
  const payer = makeUser();
  const wallet = makeWallet(payer);
  const before = countFor(payer);

  await assert.rejects(
    () => createSplit({ payerId: payer, body: { total_cents: 2500, currency: 'EUR', parts: parts(1200, 800) }, walletId: wallet, deps: fakeNetwork().deps }),
    (err) => err instanceof AppError && err.code === 'split_mismatch',
  );
  assert.deepEqual(countFor(payer), before, 'no split and no child payment was created');
});

test('a split is limited to 20 recipients, and a recipient cannot appear twice', async () => {
  const payer = makeUser();
  const wallet = makeWallet(payer);
  const twentyOne = Array.from({ length: 21 }, (_, i) => ({ recipient_email: `r${i}-${randomUUID()}@example.com`, amount_cents: 100 }));

  await assert.rejects(
    () => createSplit({ payerId: payer, body: { total_cents: 2100, currency: 'EUR', parts: twentyOne }, walletId: wallet, deps: fakeNetwork().deps }),
    (err) => err.code === 'too_many_recipients',
  );

  const same = 'twice@example.com';
  await assert.rejects(
    () =>
      createSplit({
        payerId: payer,
        body: { total_cents: 200, currency: 'EUR', parts: [{ recipient_email: same, amount_cents: 100 }, { recipient_email: same, amount_cents: 100 }] },
        walletId: wallet,
        deps: fakeNetwork().deps,
      }),
    (err) => err.code === 'duplicate_recipient',
  );
  assert.equal(countFor(payer).children, 0);
});

test('one failed part leaves the others unaffected, and the split reports which part failed', async () => {
  const payer = makeUser();
  const wallet = makeWallet(payer);
  const list = parts(1000, 1000, 1000);

  const { split } = await createSplit({
    payerId: payer,
    body: { total_cents: 3000, currency: 'EUR', parts: list },
    walletId: wallet,
    mailer: fakeMailer(),
    deps: fakeNetwork({ outgoingPlan: ['COMPLETED', 'FAILED', 'COMPLETED'] }).deps,
  });

  assert.deepEqual(
    split.children.map((c) => c.status),
    ['claimable', 'failed', 'claimable'],
    'the failed part is the middle one; the others go ahead',
  );
  assert.equal(split.children[1].failure_reason, 'outgoing_failed');

  const shown = getSplit(payer, split.id);
  assert.equal(shown.children[1].status, 'failed');
  assert.equal(shown.children[0].status, 'claimable');
});

test('a repeated request with the same key returns the first split and pays nothing again', async () => {
  const payer = makeUser();
  const wallet = makeWallet(payer);
  const body = { total_cents: 1000, currency: 'EUR', parts: parts(600, 400) };
  const net = fakeNetwork();

  const first = await createSplit({ payerId: payer, body, walletId: wallet, idempotencyKey: 'split-key-001', mailer: fakeMailer(), deps: net.deps });
  const again = await createSplit({ payerId: payer, body, walletId: wallet, idempotencyKey: 'split-key-001', mailer: fakeMailer(), deps: net.deps });

  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.split.id, first.split.id);
  assert.equal(net.calls.outgoing, 2, 'the parts were paid once');

  await assert.rejects(
    () =>
      createSplit({
        payerId: payer,
        body: { total_cents: 1000, currency: 'EUR', parts: parts(500, 500) },
        walletId: wallet,
        idempotencyKey: 'split-key-001',
        deps: net.deps,
      }),
    (err) => err.code === 'idempotency_conflict',
  );
});
