// End-to-end flow in one process: sign in, pay, webhook, claim, transfer, completed.
// Rapyd, the gateway and the transfer are stubs; the database is a temporary file. No network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-integration-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.PAYMENT_CURRENCIES = 'USD';
process.env.PAYMENT_RAILS = 'rapyd';
process.env.BASE_URL = 'https://guacapay.test';
process.env.SMTP_HOST = '';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { reconcilePending } = await import('../src/payments/reconcile.js');
const { issuePendingClaims } = await import('../src/claims/service.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

const TOKEN = PLACEHOLDER_SECRET;
const GOOD_DESTINATION = 'https://ilp.interledger-test.dev/71dd8185';

// Stub Rapyd through the gateway: one checkout, paid when asked.
function gatewayStub(statusFor = { checkout_int1: 'paid' }) {
  return {
    async createCheckout({ paymentId }) {
      return { checkoutId: 'checkout_int1', redirectUrl: `https://sandboxcheckout.rapyd.net/int1?ref=${paymentId}`, status: 'pending' };
    },
    async getCheckoutStatus(checkoutId) {
      return { checkoutId, status: statusFor[checkoutId] ?? 'pending', providerStatus: 'DON' };
    },
  };
}

function fakeMailer() {
  const sent = { codes: [], links: [], confirmations: [] };
  return {
    sent,
    async sendLoginCode(email, code) {
      sent.codes.push({ email, code });
    },
    async sendClaimLink(email, link, details) {
      sent.links.push({ email, link, details });
    },
    async sendPaymentConfirmation(email, details) {
      sent.confirmations.push({ email, details });
    },
  };
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function call(base, method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function paymentRow(id) {
  return getDb().prepare('SELECT status FROM payments WHERE id = ?').get(id);
}

test('a payment goes from sign-in to completed, with a lost webhook and a retry on the same claim link', async () => {
  const mailer = fakeMailer();
  const transfers = [];
  const transfer = async (input) => {
    transfers.push(input);
    return { transferId: 'tx-int-1' };
  };
  const app = createApp({ mailer, gateway: gatewayStub(), gatewayToken: TOKEN, transfer });

  await withServer(app, async (base) => {
    // 1. Sign in as the sender with the emailed code.
    const alice = 'alice-int@example.com';
    assert.equal((await call(base, 'POST', '/api/auth/request-code', { body: { email: alice } })).status, 202);
    const aliceCode = mailer.sent.codes.at(-1).code;
    const signIn = await call(base, 'POST', '/api/auth/verify-code', { body: { email: alice, code: aliceCode } });
    assert.equal(signIn.status, 200);
    const aliceToken = signIn.body.token;

    // 2. Create the payment, then start its checkout.
    const bob = 'bob-int@example.com';
    const key = `int-${randomUUID()}`;
    const created = await call(base, 'POST', '/api/payments', {
      token: aliceToken,
      headers: { 'Idempotency-Key': key },
      body: { recipient_email: bob, amount_cents: 2500, currency: 'USD', message: 'Lunch' },
    });
    assert.equal(created.status, 201);
    const paymentId = created.body.id;

    const again = await call(base, 'POST', '/api/payments', {
      token: aliceToken,
      headers: { 'Idempotency-Key': key },
      body: { recipient_email: bob, amount_cents: 2500, currency: 'USD', message: 'Lunch' },
    });
    assert.equal(again.body.id, paymentId, 'a retry with the same key is the same payment');

    const checkout = await call(base, 'POST', `/api/payments/${paymentId}/checkout`, { token: aliceToken });
    assert.equal(checkout.status, 200);
    assert.match(checkout.body.redirectUrl, /sandboxcheckout/);
    assert.equal(paymentRow(paymentId).status, 'awaiting_payment');

    // 3. Rapyd's webhook arrives through the gateway and reports the payment as paid.
    const event = { eventId: 'wh_int_1', type: 'PAYMENT_COMPLETED', paymentReference: paymentId };
    const applied = await call(base, 'POST', '/internal/payment-events', { token: TOKEN, body: event });
    assert.equal(applied.body.outcome, 'applied');
    assert.equal(paymentRow(paymentId).status, 'claimable', 'paid, then claimable with a link');
    assert.equal(mailer.sent.links.length, 1);
    assert.equal(mailer.sent.links[0].email, bob);

    // The same webhook sent again changes nothing.
    const repeated = await call(base, 'POST', '/internal/payment-events', { token: TOKEN, body: event });
    assert.notEqual(repeated.body.outcome, 'applied');
    assert.equal(mailer.sent.links.length, 1, 'no second link');

    // 4. Bob opens the link, proves his email, and confirms with a wallet address.
    const token = new URL(mailer.sent.links[0].link).searchParams.get('token');
    assert.equal((await call(base, 'POST', '/api/claims/verify-email', { body: { token, email: bob } })).status, 202);
    const bobCode = mailer.sent.codes.at(-1).code;

    const claimed = await call(base, 'POST', '/api/claims/confirm', {
      body: { token, code: bobCode, destinationWalletAddress: GOOD_DESTINATION },
    });
    assert.deepEqual(claimed.body, { status: 'completed' });

    // 5. The transfer ran once, the sender was told, and the payment is completed.
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].amountCents, 2500);
    assert.equal(transfers[0].destination, GOOD_DESTINATION);
    assert.equal(paymentRow(paymentId).status, 'completed');
    assert.equal(mailer.sent.confirmations.length, 1);
    assert.equal(mailer.sent.confirmations[0].email, alice);

    const replay = await call(base, 'POST', '/api/claims/confirm', {
      body: { token, code: bobCode, destinationWalletAddress: GOOD_DESTINATION },
    });
    assert.equal(replay.status, 409);
    assert.equal(transfers.length, 1, 'no second transfer');

    // Alice sees the final state on her own payment.
    const seen = await call(base, 'GET', `/api/payments/${paymentId}`, { token: aliceToken });
    assert.equal(seen.body.status, 'completed');
  });
});

test('a payment whose webhook was lost is recovered by the poller, and its claim link is still issued', async () => {
  const mailer = fakeMailer();
  const gateway = gatewayStub({ checkout_poll: 'paid' });
  const app = createApp({ mailer, gateway, gatewayToken: TOKEN });

  await withServer(app, async (base) => {
    const carol = 'carol-int@example.com';
    await call(base, 'POST', '/api/auth/request-code', { body: { email: carol } });
    const signIn = await call(base, 'POST', '/api/auth/verify-code', {
      body: { email: carol, code: mailer.sent.codes.at(-1).code },
    });

    const created = await call(base, 'POST', '/api/payments', {
      token: signIn.body.token,
      body: { recipient_email: 'dan-int@example.com', amount_cents: 900, currency: 'USD' },
    });
    const paymentId = created.body.id;
    getDb().prepare("UPDATE payments SET status = 'awaiting_payment', rapyd_checkout_id = 'checkout_poll' WHERE id = ?").run(paymentId);

    // Two minutes pass with no webhook.
    getDb()
      .prepare('UPDATE payments SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), paymentId);

    const polled = await reconcilePending({ gateway });
    assert.deepEqual(polled, { checked: 1, applied: 1 });
    assert.equal(paymentRow(paymentId).status, 'paid');

    const swept = await issuePendingClaims({ mailer });
    assert.equal(swept.issued >= 1, true);
    assert.equal(paymentRow(paymentId).status, 'claimable');
    assert.equal(mailer.sent.links.filter((link) => link.email === 'dan-int@example.com').length, 1);
  });
});
