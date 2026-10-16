// Webhook reconciliation, polling, checkout start (prompt 07 and the checkout step of prompt 11).
// Runs the app in-process on a temporary database; the gateway is a stub. No network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-reconcile-'));

process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.PAYMENT_CURRENCIES = 'USD';
process.env.BASE_URL = 'http://localhost:3202';
process.env.RETURN_BASE_URL = 'https://return.guacapay.test';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { createGatewayClient } = await import('../src/gateway-client.js');
const { AppError } = await import('../src/errors.js');
const { createPayment } = await import('../src/payments/service.js');
const { attachCheckout } = await import('../src/payments/checkout.js');
const { handleProviderEvent, reconcilePending } = await import('../src/payments/reconcile.js');

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

// A payment that has a checkout and is waiting for payment.
function makeAwaitingPayment(senderId, checkoutId = `checkout_${randomUUID().replace(/-/g, '')}`) {
  const { payment } = createPayment({
    senderId,
    body: { recipient_email: 'recipient@example.com', amount_cents: 1500, currency: 'USD' },
  });
  attachCheckout(payment.id, checkoutId);
  return { id: payment.id, checkoutId };
}

function statusOf(paymentId) {
  return getDb().prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status;
}

function eventCount(paymentId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM payment_events WHERE payment_id = ?').get(paymentId).n;
}

// Stub gateway: status per checkout ID, and records every call.
function gatewayStub(statusByCheckout = {}) {
  const calls = [];
  return {
    calls,
    async getCheckoutStatus(checkoutId) {
      calls.push(checkoutId);
      return { checkoutId, status: statusByCheckout[checkoutId] ?? 'pending', providerStatus: 'NEW' };
    },
    async createCheckout(input) {
      calls.push(['createCheckout', input.paymentId, input.returnUrl]);
      return { checkoutId: 'checkout_new1', redirectUrl: 'https://sandboxcheckout.rapyd.net/new1', status: 'pending' };
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

async function request(base, method, path, { token, body, headers = {} } = {}) {
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

test('a paid webhook moves an awaiting payment to paid, once', async () => {
  const alice = makeUser();
  const payment = makeAwaitingPayment(alice.id, 'checkout_paid1');
  const gateway = gatewayStub({ checkout_paid1: 'paid' });
  const before = eventCount(payment.id);

  const first = await handleProviderEvent(
    { eventId: 'wh_paid_1', type: 'PAYMENT_COMPLETED', paymentReference: payment.id },
    { gateway },
  );
  assert.deepEqual(first, { outcome: 'applied', providerStatus: 'paid' });
  assert.equal(statusOf(payment.id), 'paid');
  assert.equal(eventCount(payment.id), before + 1, 'exactly one new event for the change');

  const second = await handleProviderEvent(
    { eventId: 'wh_paid_1', type: 'PAYMENT_COMPLETED', paymentReference: payment.id },
    { gateway },
  );
  assert.equal(second.outcome, 'ignored', 'the same event does nothing the second time');
  assert.equal(eventCount(payment.id), before + 1);
});

test('the status comes from the checkout status check, so a repeated webhook cannot push a paid payment back', async () => {
  const alice = makeUser();
  const payment = makeAwaitingPayment(alice.id, 'checkout_paid2');
  const gateway = gatewayStub({ checkout_paid2: 'paid' });

  await handleProviderEvent({ eventId: 'wh_p2_a', type: 'PAYMENT_COMPLETED', paymentReference: payment.id }, { gateway });
  const callsAfterPaid = gateway.calls.length;

  const later = await handleProviderEvent({ eventId: 'wh_p2_b', type: 'PAYMENT_FAILED', paymentReference: payment.id }, { gateway });
  assert.equal(later.outcome, 'ignored');
  assert.equal(later.reason, 'not_awaiting');
  assert.equal(gateway.calls.length, callsAfterPaid, 'no provider call for a payment that is already final');
  assert.equal(statusOf(payment.id), 'paid');
});

test('a pending checkout changes nothing and is not recorded as processed', async () => {
  const alice = makeUser();
  const payment = makeAwaitingPayment(alice.id, 'checkout_pending1');
  const gateway = gatewayStub({ checkout_pending1: 'pending' });

  const result = await handleProviderEvent(
    { eventId: 'wh_pending_1', type: 'PAYMENT_COMPLETED', paymentReference: payment.id },
    { gateway },
  );
  assert.equal(result.outcome, 'no_change');
  assert.equal(statusOf(payment.id), 'awaiting_payment');
  assert.equal(getDb().prepare('SELECT 1 FROM processed_events WHERE event_id = ?').get('wh_pending_1'), undefined);
});

test('expired and declined checkouts move the payment to expired and failed', async () => {
  const alice = makeUser();
  const expiring = makeAwaitingPayment(alice.id, 'checkout_exp1');
  const declining = makeAwaitingPayment(alice.id, 'checkout_dec1');
  const gateway = gatewayStub({ checkout_exp1: 'expired', checkout_dec1: 'declined' });

  await handleProviderEvent({ eventId: 'wh_exp', type: 'PAYMENT_FAILED', paymentReference: expiring.id }, { gateway });
  await handleProviderEvent({ eventId: 'wh_dec', type: 'PAYMENT_FAILED', paymentReference: declining.id }, { gateway });

  assert.equal(statusOf(expiring.id), 'expired');
  assert.equal(statusOf(declining.id), 'failed');
});

test('events that match no payment are ignored, not treated as errors', async () => {
  const gateway = gatewayStub();

  const unknown = await handleProviderEvent(
    { eventId: 'wh_unknown', type: 'PAYMENT_COMPLETED', paymentReference: randomUUID() },
    { gateway },
  );
  assert.deepEqual(unknown, { outcome: 'ignored', reason: 'unknown_payment' });

  const noReference = await handleProviderEvent({ eventId: 'wh_none', type: 'PAYMENT_COMPLETED', paymentReference: null }, { gateway });
  assert.deepEqual(noReference, { outcome: 'ignored', reason: 'no_reference' });
  assert.equal(gateway.calls.length, 0);
});

test('polling checks only payments that have waited two minutes, and applies their status', async () => {
  const alice = makeUser();
  const old = makeAwaitingPayment(alice.id, 'checkout_old1');
  const fresh = makeAwaitingPayment(alice.id, 'checkout_fresh1');

  getDb()
    .prepare('UPDATE payments SET updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), old.id);

  const gateway = gatewayStub({ checkout_old1: 'paid', checkout_fresh1: 'paid' });
  const result = await reconcilePending({ gateway });

  assert.deepEqual(result, { checked: 1, applied: 1 });
  assert.deepEqual(gateway.calls, ['checkout_old1']);
  assert.equal(statusOf(old.id), 'paid');
  assert.equal(statusOf(fresh.id), 'awaiting_payment');
});

test('the internal endpoint needs the gateway token and answers 200 for well-formed events', async () => {
  const alice = makeUser();
  const payment = makeAwaitingPayment(alice.id, 'checkout_http1');
  const gateway = gatewayStub({ checkout_http1: 'paid' });
  const app = createApp({ gateway, gatewayToken: PLACEHOLDER_SECRET });

  await withServer(app, async (base) => {
    const body = { eventId: 'wh_http_1', type: 'PAYMENT_COMPLETED', paymentReference: payment.id };

    const noToken = await request(base, 'POST', '/internal/payment-events', { body });
    assert.equal(noToken.status, 401);

    const wrongToken = await request(base, 'POST', '/internal/payment-events', {
      token: 'x'.repeat(40),
      body,
    });
    assert.equal(wrongToken.status, 401);
    assert.equal(statusOf(payment.id), 'awaiting_payment', 'nothing changed without a valid token');

    const applied = await request(base, 'POST', '/internal/payment-events', { token: PLACEHOLDER_SECRET, body });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.outcome, 'applied');

    const unknown = await request(base, 'POST', '/internal/payment-events', {
      token: PLACEHOLDER_SECRET,
      body: { eventId: 'wh_http_2', type: 'PAYMENT_COMPLETED', paymentReference: randomUUID() },
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.outcome, 'ignored');

    const malformed = await request(base, 'POST', '/internal/payment-events', {
      token: PLACEHOLDER_SECRET,
      body: { type: 'PAYMENT_COMPLETED' },
    });
    assert.equal(malformed.status, 400);
  });
});

test('starting a checkout attaches it and moves the payment to awaiting_payment', async () => {
  const alice = makeUser();
  const bob = makeUser();
  const { payment } = createPayment({
    senderId: alice.id,
    body: { recipient_email: 'recipient@example.com', amount_cents: 2500, currency: 'USD' },
  });
  const gateway = gatewayStub();
  const app = createApp({ gateway, gatewayToken: PLACEHOLDER_SECRET });

  await withServer(app, async (base) => {
    const notMine = await request(base, 'POST', `/api/payments/${payment.id}/checkout`, { token: bob.token });
    assert.equal(notMine.status, 404);

    const started = await request(base, 'POST', `/api/payments/${payment.id}/checkout`, { token: alice.token });
    assert.equal(started.status, 200);
    assert.equal(started.body.redirectUrl, 'https://sandboxcheckout.rapyd.net/new1');

    // Rapyd gets the public return address; email links elsewhere keep using BASE_URL (localhost).
    const sent = gateway.calls.find((call) => call[0] === 'createCheckout');
    assert.ok(sent[2].startsWith('https://return.guacapay.test/payment.html?id='), sent[2]);

    const row = getDb().prepare('SELECT status, rapyd_checkout_id FROM payments WHERE id = ?').get(payment.id);
    assert.equal(row.status, 'awaiting_payment');
    assert.equal(row.rapyd_checkout_id, 'checkout_new1');

    const again = await request(base, 'POST', `/api/payments/${payment.id}/checkout`, { token: alice.token });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'checkout_not_available');
  });
});

test('checkout start reports a missing gateway clearly', async () => {
  const alice = makeUser();
  const { payment } = createPayment({
    senderId: alice.id,
    body: { recipient_email: 'recipient@example.com', amount_cents: 2500, currency: 'USD' },
  });
  await withServer(createApp({ gatewayToken: PLACEHOLDER_SECRET }), async (base) => {
    const result = await request(base, 'POST', `/api/payments/${payment.id}/checkout`, { token: alice.token });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'gateway_not_configured');
  });
});

test('the gateway client turns gateway errors and outages into app errors', async () => {
  const refused = createGatewayClient({
    baseUrl: 'http://gateway.test',
    token: PLACEHOLDER_SECRET,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), { status: 401 }),
  });
  await assert.rejects(
    () => refused.getCheckoutStatus('checkout_x'),
    (err) => err instanceof AppError && err.code === 'unauthorized' && err.status === 401,
  );

  const broken = createGatewayClient({
    baseUrl: 'http://gateway.test',
    token: PLACEHOLDER_SECRET,
    fetchImpl: async () => new Response('', { status: 500 }),
  });
  await assert.rejects(
    () => broken.getCheckoutStatus('checkout_x'),
    (err) => err.code === 'gateway_error' && err.status === 502,
  );

  const down = createGatewayClient({
    baseUrl: 'http://gateway.test',
    token: PLACEHOLDER_SECRET,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    () => down.getCheckoutStatus('checkout_x'),
    (err) => err.code === 'gateway_unavailable' && err.status === 502,
  );
});
