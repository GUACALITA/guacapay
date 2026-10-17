// Card rail switch (decision 017). With the default rail, card payments are refused and nothing is created.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-rails-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.PAYMENT_CURRENCIES = 'USD';
delete process.env.PAYMENT_RAILS;

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { config } = await import('../src/config.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeUser() {
  const id = randomUUID();
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@example.com`);
  return { id, token: issueToken(id) };
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

const gateway = {
  async createCheckout() {
    throw new Error('must not be called when the card rail is off');
  },
  async getCheckoutStatus() {
    throw new Error('must not be called when the card rail is off');
  },
};

test('the default rail is Open Payments', () => {
  assert.equal(config.paymentRails, 'openpayments');
});

test('card recharges and checkouts are refused with rail_not_available, and nothing is created', async () => {
  const user = makeUser();
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM payments WHERE sender_id = ?').get(user.id).n;

  await withServer(createApp({ gateway }), async (base) => {
    const recharge = await fetch(`${base}/api/balance/recharges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ amount_cents: 1000, currency: 'USD' }),
    });
    const body = await recharge.json();
    assert.equal(recharge.status, 503);
    assert.equal(body.error.code, 'rail_not_available');

    const created = await fetch(`${base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ recipient_email: `r-${randomUUID()}@example.com`, amount_cents: 1000, currency: 'USD' }),
    });
    const payment = await created.json();

    const checkout = await fetch(`${base}/api/payments/${payment.id}/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    assert.equal(checkout.status, 503);
    assert.equal((await checkout.json()).error.code, 'rail_not_available');

    const status = getDb().prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status;
    assert.equal(status, 'created', 'the payment did not move');
  });

  const after = getDb().prepare('SELECT COUNT(*) AS n FROM payments WHERE sender_id = ?').get(user.id).n;
  assert.equal(after - before, 1, 'only the transfer row was created; no recharge row');
});
