// Gateway HTTP checks (prompt 06). The Rapyd client is a stub; no network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGatewayApp } from '../src/app.js';
import { AppError } from '../src/errors.js';

const TOKEN = 'gateway-test-token-0123456789abcdef0123';
const PAYMENT_ID = '3f6b2a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const RETURN_URL = 'https://app.example.com/payment.html?id=3f6b2a4e';

function stubRapyd(overrides = {}) {
  const calls = [];
  return {
    calls,
    async createCheckout(input) {
      calls.push(['createCheckout', input]);
      return { checkoutId: 'checkout_x1', redirectUrl: 'https://sandboxcheckout.rapyd.net/x', status: 'pending' };
    },
    async getCheckoutStatus(id) {
      calls.push(['getCheckoutStatus', id]);
      return { checkoutId: id, status: 'paid', providerStatus: 'DON' };
    },
    ...overrides,
  };
}

async function withServer(rapyd, callback) {
  const server = createGatewayApp({ rapyd, gatewayToken: TOKEN }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function call(base, method, path, { token = TOKEN, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const validBody = (overrides = {}) => ({
  paymentId: PAYMENT_ID,
  amountCents: 1500,
  currency: 'USD',
  returnUrl: RETURN_URL,
  ...overrides,
});

test('health answers without a token', async () => {
  await withServer(stubRapyd(), async (base) => {
    const result = await call(base, 'GET', '/health', { token: null });
    assert.equal(result.status, 200);
    assert.equal(result.body.service, 'gateway');
  });
});

test('checkout routes refuse a missing or wrong token', async () => {
  const rapyd = stubRapyd();
  await withServer(rapyd, async (base) => {
    const none = await call(base, 'POST', '/checkout', { token: null, body: validBody() });
    assert.equal(none.status, 401);

    const wrong = await call(base, 'POST', '/checkout', { token: 'x'.repeat(40), body: validBody() });
    assert.equal(wrong.status, 401);

    const status = await call(base, 'GET', '/checkout/status/checkout_x1', { token: null });
    assert.equal(status.status, 401);
  });
  assert.equal(rapyd.calls.length, 0, 'nothing reached Rapyd');
});

test('a valid request creates a checkout and returns 201', async () => {
  const rapyd = stubRapyd();
  await withServer(rapyd, async (base) => {
    const result = await call(base, 'POST', '/checkout', { body: validBody() });

    assert.equal(result.status, 201);
    assert.deepEqual(result.body, {
      checkoutId: 'checkout_x1',
      redirectUrl: 'https://sandboxcheckout.rapyd.net/x',
      status: 'pending',
    });
    assert.deepEqual(rapyd.calls[0], [
      'createCheckout',
      { paymentId: PAYMENT_ID, amountCents: 1500, currency: 'USD', returnUrl: RETURN_URL },
    ]);
  });
});

test('invalid input is rejected before Rapyd is called', async () => {
  const cases = [
    ['payment ID not a UUID', validBody({ paymentId: 'abc' }), 'invalid_payment_id'],
    ['amount zero', validBody({ amountCents: 0 }), 'invalid_amount'],
    ['amount as text', validBody({ amountCents: '1500' }), 'invalid_amount'],
    ['lowercase currency', validBody({ currency: 'usd' }), 'invalid_currency'],
    ['javascript URL', validBody({ returnUrl: 'javascript:alert(1)' }), 'invalid_return_url'],
    ['relative URL', validBody({ returnUrl: '/payment.html' }), 'invalid_return_url'],
  ];

  const rapyd = stubRapyd();
  await withServer(rapyd, async (base) => {
    for (const [label, body, code] of cases) {
      const result = await call(base, 'POST', '/checkout', { body });
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error.code, code, label);
    }
  });
  assert.equal(rapyd.calls.length, 0);
});

test('checkout status is returned for a valid token', async () => {
  const rapyd = stubRapyd();
  await withServer(rapyd, async (base) => {
    const result = await call(base, 'GET', '/checkout/status/checkout_x1');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { checkoutId: 'checkout_x1', status: 'paid', providerStatus: 'DON' });
  });
});

test('provider errors reach the app with their code, but without provider detail', async () => {
  const rapyd = stubRapyd({
    async createCheckout() {
      throw new AppError('provider_auth_failed', 502, 'The payment provider rejected our credentials.', {
        providerCode: 'INVALID_SIGNATURE',
      });
    },
  });
  await withServer(rapyd, async (base) => {
    const result = await call(base, 'POST', '/checkout', { body: validBody() });
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'provider_auth_failed');
    assert.equal(result.body.error.providerCode, undefined, 'provider code is for logs only');
  });
});

test('unknown routes return JSON', async () => {
  await withServer(stubRapyd(), async (base) => {
    const result = await call(base, 'GET', '/nope');
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'not_found');
  });
});
