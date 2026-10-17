// App balance (recharge with Rapyd, pay with balance, testnet option). In-process app, temporary database, stub gateway. No network.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-balance-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.PAYMENT_CURRENCIES = 'USD';
process.env.PAYMENT_RAILS = 'rapyd';
process.env.BASE_URL = 'http://localhost:3202';
process.env.RETURN_BASE_URL = 'https://return.guacapay.test';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { issueToken } = await import('../src/auth/tokens.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeUser() {
  const id = randomUUID();
  const email = `${id}@example.com`;
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, email);
  return { id, email, token: issueToken(id) };
}

function gatewayStub() {
  return {
    async createCheckout() {
      return { checkoutId: `checkout_${randomUUID().replace(/-/g, '')}`, redirectUrl: 'https://sandboxcheckout.rapyd.net/x', status: 'pending' };
    },
    async getCheckoutStatus(checkoutId) {
      return { checkoutId, status: 'paid', providerStatus: 'DON' };
    },
  };
}

function fakeMailer() {
  const links = [];
  return {
    links,
    async sendLoginCode() {},
    async sendClaimLink(email, link) {
      links.push({ email, link });
    },
    async sendPaymentConfirmation() {},
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

function balanceOf(userId) {
  const row = getDb().prepare("SELECT balance_cents FROM balances WHERE user_id = ? AND currency = 'USD'").get(userId);
  return row ? row.balance_cents : 0;
}

function transferBody(amount) {
  return { recipient_email: `recipient-${randomUUID()}@example.com`, amount_cents: amount, currency: 'USD' };
}

test('a new user has no balance', async () => {
  const user = makeUser();
  await withServer(createApp({ gateway: gatewayStub() }), async (base) => {
    const result = await call(base, 'GET', '/api/balance', { token: user.token });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.balances, []);
  });
});

test('a recharge is paid with Rapyd, then the amount is added to the app balance', async () => {
  const user = makeUser();
  const gateway = gatewayStub();
  const app = createApp({ gateway, mailer: fakeMailer() });

  await withServer(app, async (base) => {
    const started = await call(base, 'POST', '/api/balance/recharges', {
      token: user.token,
      body: { amount_cents: 5000, currency: 'USD' },
    });
    assert.equal(started.status, 201);
    assert.match(started.body.redirectUrl, /sandboxcheckout/);
    assert.equal(balanceOf(user.id), 0, 'nothing is credited before Rapyd confirms');

    const paymentId = started.body.payment.id;
    const checkoutId = getDb().prepare('SELECT rapyd_checkout_id FROM payments WHERE id = ?').get(paymentId).rapyd_checkout_id;
    assert.ok(checkoutId);

    const applied = await call(base, 'POST', '/internal/payment-events', {
      token: PLACEHOLDER_SECRET,
      body: { eventId: `wh_${randomUUID()}`, type: 'PAYMENT_COMPLETED', paymentReference: paymentId },
    });
    assert.equal(applied.body.outcome, 'applied');
  });

  assert.equal(balanceOf(user.id), 5000);
  const status = getDb().prepare('SELECT status FROM payments WHERE sender_id = ? AND purpose = ?').get(user.id, 'recharge').status;
  assert.equal(status, 'completed');
  const entry = getDb().prepare("SELECT amount_cents, reason FROM ledger_entries WHERE user_id = ? AND reason = 'recharge'").get(user.id);
  assert.deepEqual({ ...entry }, { amount_cents: 5000, reason: 'recharge' });
});

test('a transfer is paid from the app balance, which goes down, and its claim link is issued', async () => {
  const user = makeUser();
  const mailer = fakeMailer();
  getDb().prepare("INSERT INTO balances (user_id, currency, balance_cents) VALUES (?, 'USD', 3000)").run(user.id);

  await withServer(createApp({ gateway: gatewayStub(), mailer }), async (base) => {
    const created = await call(base, 'POST', '/api/payments', { token: user.token, body: transferBody(2000) });
    assert.equal(created.status, 201);

    const paid = await call(base, 'POST', `/api/payments/${created.body.id}/pay-with-balance`, { token: user.token });
    assert.equal(paid.status, 200);
    assert.deepEqual(paid.body, { status: 'paid' });
  });

  assert.equal(balanceOf(user.id), 1000);
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id = ? AND amount_cents = -2000 AND reason = 'payment'").get(user.id).n,
    1,
  );
  assert.equal(mailer.links.length, 1, 'the recipient gets the claim link');
  assert.match(mailer.links[0].link, /^http:\/\/localhost:3202\/claim\.html\?token=/);
});

test('when the app balance is not enough, the payment is refused and nothing moves', async () => {
  const user = makeUser();
  getDb().prepare("INSERT INTO balances (user_id, currency, balance_cents) VALUES (?, 'USD', 500)").run(user.id);

  await withServer(createApp({ gateway: gatewayStub(), mailer: fakeMailer() }), async (base) => {
    const created = await call(base, 'POST', '/api/payments', { token: user.token, body: transferBody(2000) });

    const refused = await call(base, 'POST', `/api/payments/${created.body.id}/pay-with-balance`, { token: user.token });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'insufficient_balance');

    const still = getDb().prepare('SELECT status FROM payments WHERE id = ?').get(created.body.id).status;
    assert.equal(still, 'created');
  });

  assert.equal(balanceOf(user.id), 500);
});

test('a user cannot pay with someone else\'s balance or payment', async () => {
  const owner = makeUser();
  const other = makeUser();
  getDb().prepare("INSERT INTO balances (user_id, currency, balance_cents) VALUES (?, 'USD', 9000)").run(other.id);

  await withServer(createApp({ gateway: gatewayStub(), mailer: fakeMailer() }), async (base) => {
    const created = await call(base, 'POST', '/api/payments', { token: owner.token, body: transferBody(1000) });
    const result = await call(base, 'POST', `/api/payments/${created.body.id}/pay-with-balance`, { token: other.token });
    assert.equal(result.status, 404);
  });

  assert.equal(balanceOf(other.id), 9000);
});

test('a recharge must have a valid amount', async () => {
  const user = makeUser();
  await withServer(createApp({ gateway: gatewayStub(), mailer: fakeMailer() }), async (base) => {
    const result = await call(base, 'POST', '/api/balance/recharges', { token: user.token, body: { amount_cents: 5, currency: 'USD' } });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_amount');
  });
});
