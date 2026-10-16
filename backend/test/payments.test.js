// Payments (prompt 05). Runs the app in-process on a temporary database; no network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-payments-'));

process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.PAYMENT_CURRENCIES = 'USD';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { STATUS, InvalidTransitionError, canTransition } = await import('../src/payments/states.js');
const { transitionPayment, createPayment } = await import('../src/payments/service.js');

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

async function withServer(callback) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(base);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function api(base, method, path, { token, body, headers = {} } = {}) {
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

const validBody = (overrides = {}) => ({
  recipient_email: 'recipient@example.com',
  amount_cents: 1500,
  currency: 'USD',
  message: 'Lunch',
  ...overrides,
});

function eventCount(paymentId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM payment_events WHERE payment_id = ?').get(paymentId).n;
}

test('allowed transitions pass and forbidden ones are rejected', () => {
  assert.equal(canTransition(STATUS.CREATED, STATUS.AWAITING_PAYMENT), true);
  assert.equal(canTransition(STATUS.PAID, STATUS.CLAIMABLE), true);
  assert.equal(canTransition(STATUS.CLAIMED, STATUS.CREATED), false);

  // Terminal states have no way out.
  for (const terminal of [STATUS.COMPLETED, STATUS.EXPIRED, STATUS.FAILED]) {
    for (const target of Object.values(STATUS)) {
      assert.equal(canTransition(terminal, target), false, `${terminal} -> ${target}`);
    }
  }
});

test('creating a payment returns 201, starts in created, and writes one event', async () => {
  const alice = makeUser();
  await withServer(async (base) => {
    const result = await api(base, 'POST', '/api/payments', { token: alice.token, body: validBody() });

    assert.equal(result.status, 201);
    assert.equal(result.body.status, 'created');
    assert.equal(result.body.recipient_email, 'recipient@example.com');
    assert.equal(result.body.amount_cents, 1500);
    assert.equal(result.body.currency, 'USD');
    assert.equal(result.body.message, 'Lunch');
    assert.equal(result.body.sender_id, undefined, 'sender ID is not returned');
    assert.equal(result.body.rapyd_checkout_id, undefined, 'internal columns are not returned');

    assert.equal(eventCount(result.body.id), 1);
    const event = getDb().prepare('SELECT payload_json FROM payment_events WHERE payment_id = ?').get(result.body.id);
    assert.deepEqual(JSON.parse(event.payload_json), { from: null, to: 'created' });
  });
});

test('invalid input is rejected with a specific error code', async () => {
  const alice = makeUser();
  const cases = [
    ['amount zero', validBody({ amount_cents: 0 }), 'invalid_amount'],
    ['amount below minimum', validBody({ amount_cents: 99 }), 'invalid_amount'],
    ['amount above maximum', validBody({ amount_cents: 1000001 }), 'invalid_amount'],
    ['fractional amount', validBody({ amount_cents: 12.5 }), 'invalid_amount'],
    ['amount as text', validBody({ amount_cents: '100' }), 'invalid_amount'],
    ['unsupported currency', validBody({ currency: 'EUR' }), 'invalid_currency'],
    ['invalid recipient', validBody({ recipient_email: 'not-an-email' }), 'invalid_email'],
    ['message too long', validBody({ message: 'x'.repeat(501) }), 'invalid_message'],
  ];

  await withServer(async (base) => {
    for (const [label, body, code] of cases) {
      const result = await api(base, 'POST', '/api/payments', { token: alice.token, body });
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error.code, code, label);
    }

    const badKey = await api(base, 'POST', '/api/payments', {
      token: alice.token,
      body: validBody(),
      headers: { 'Idempotency-Key': 'short' },
    });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.body.error.code, 'invalid_idempotency_key');
  });
});

test('the same Idempotency-Key returns the same payment and creates one row', async () => {
  const alice = makeUser();
  const key = `key-${randomUUID()}`;
  await withServer(async (base) => {
    const first = await api(base, 'POST', '/api/payments', {
      token: alice.token,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    const second = await api(base, 'POST', '/api/payments', {
      token: alice.token,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);

    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM payments WHERE sender_id = ? AND idempotency_key = ?')
      .get(alice.id, key).n;
    assert.equal(rows, 1);
    assert.equal(eventCount(first.body.id), 1, 'a replay adds no event');
  });
});

test('reusing an Idempotency-Key with a different request is a conflict', async () => {
  const alice = makeUser();
  const key = `key-${randomUUID()}`;
  await withServer(async (base) => {
    await api(base, 'POST', '/api/payments', {
      token: alice.token,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    const different = await api(base, 'POST', '/api/payments', {
      token: alice.token,
      body: validBody({ amount_cents: 2000 }),
      headers: { 'Idempotency-Key': key },
    });

    assert.equal(different.status, 409);
    assert.equal(different.body.error.code, 'idempotency_conflict');
  });
});

test('the same key from two different users creates two payments', async () => {
  const alice = makeUser();
  const bob = makeUser();
  const key = `key-${randomUUID()}`;
  await withServer(async (base) => {
    const a = await api(base, 'POST', '/api/payments', {
      token: alice.token,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });
    const b = await api(base, 'POST', '/api/payments', {
      token: bob.token,
      body: validBody(),
      headers: { 'Idempotency-Key': key },
    });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id);
  });
});

test('creating and reading payments requires a signed-in user', async () => {
  await withServer(async (base) => {
    const create = await api(base, 'POST', '/api/payments', { body: validBody() });
    assert.equal(create.status, 401);

    const list = await api(base, 'GET', '/api/payments');
    assert.equal(list.status, 401);
  });
});

test('a user can read their own payments and gets 404 for someone else\'s', async () => {
  const alice = makeUser();
  const bob = makeUser();
  await withServer(async (base) => {
    const mine = await api(base, 'POST', '/api/payments', { token: alice.token, body: validBody() });
    await api(base, 'POST', '/api/payments', { token: alice.token, body: validBody({ amount_cents: 700 }) });
    await api(base, 'POST', '/api/payments', { token: bob.token, body: validBody({ amount_cents: 900 }) });

    const own = await api(base, 'GET', `/api/payments/${mine.body.id}`, { token: alice.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.id, mine.body.id);

    const notMine = await api(base, 'GET', `/api/payments/${mine.body.id}`, { token: bob.token });
    assert.equal(notMine.status, 404);
    assert.equal(notMine.body.error.code, 'payment_not_found');

    const missing = await api(base, 'GET', `/api/payments/${randomUUID()}`, { token: alice.token });
    assert.equal(missing.status, 404, 'a missing payment looks the same as someone else\'s');

    const list = await api(base, 'GET', '/api/payments', { token: alice.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.payments.length, 2);
    assert.ok(list.body.payments.every((p) => p.amount_cents !== 900), 'bob\'s payment is not listed');
  });
});

test('every state change writes exactly one event, and a forbidden change writes none', () => {
  const alice = makeUser();
  const { payment } = createPayment({ senderId: alice.id, body: validBody() });
  assert.equal(eventCount(payment.id), 1);

  const lifecycle = [
    STATUS.AWAITING_PAYMENT,
    STATUS.PAID,
    STATUS.CLAIMABLE,
    STATUS.CLAIMED,
    STATUS.COMPLETED,
  ];
  let expectedEvents = 1;
  for (const next of lifecycle) {
    transitionPayment(payment.id, next);
    expectedEvents += 1;
    assert.equal(eventCount(payment.id), expectedEvents, `after moving to ${next}`);
  }

  assert.throws(() => transitionPayment(payment.id, STATUS.CREATED), InvalidTransitionError);
  const row = getDb().prepare('SELECT status FROM payments WHERE id = ?').get(payment.id);
  assert.equal(row.status, STATUS.COMPLETED, 'status is unchanged after a rejected move');
  assert.equal(eventCount(payment.id), expectedEvents, 'a rejected move writes no event');
});

test('a rejected transition throws and leaves the payment unchanged', () => {
  const alice = makeUser();
  const { payment } = createPayment({ senderId: alice.id, body: validBody() });

  assert.throws(
    () => transitionPayment(payment.id, STATUS.CLAIMED),
    (err) => err instanceof InvalidTransitionError && err.from === 'created' && err.to === 'claimed',
  );
  const row = getDb().prepare('SELECT status FROM payments WHERE id = ?').get(payment.id);
  assert.equal(row.status, STATUS.CREATED);
});
