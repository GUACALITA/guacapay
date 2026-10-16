// Rapyd adapter checks (prompt 06). A local fake server stands in for Rapyd; no network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { createRapydClient, signRequest } from '../src/providers/rapyd.js';
import { AppError } from '../src/errors.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-0123456789';
const PAYMENT_ID = '3f6b2a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const RETURN_URL = 'https://app.example.com/payment.html?id=3f6b2a4e';

// Fake Rapyd: records every request and answers with what `reply` returns.
async function fakeRapyd(reply) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const { status = 200, json } = reply(req, body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function clientFor(baseUrl, extra = {}) {
  return createRapydClient({
    baseUrl,
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    country: 'CO',
    retryDelayMs: 1,
    ...extra,
  });
}

const checkoutOk = {
  status: { status: 'SUCCESS' },
  data: { id: 'checkout_abc123', redirect_url: 'https://sandboxcheckout.rapyd.net/?token=x', status: 'NEW' },
};

test('signature follows the documented formula', () => {
  const hex = createHmac('sha256', SECRET_KEY)
    .update(`post/v1/checkout${'abcd1234'}${'1700000000'}${ACCESS_KEY}${SECRET_KEY}{"a":1}`)
    .digest('hex');

  const signature = signRequest({
    method: 'POST',
    urlPath: '/v1/checkout',
    salt: 'abcd1234',
    timestamp: '1700000000',
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    bodyString: '{"a":1}',
  });

  assert.equal(signature, Buffer.from(hex).toString('base64'));
});

test('an empty body and "{}" give different signatures', () => {
  const base = { method: 'GET', urlPath: '/v1/checkout/checkout_x', salt: 's', timestamp: 't', accessKey: ACCESS_KEY, secretKey: SECRET_KEY };
  assert.notEqual(signRequest({ ...base, bodyString: '' }), signRequest({ ...base, bodyString: '{}' }));
});

test('createCheckout sends signed headers and the documented body, then returns the redirect', async () => {
  const fake = await fakeRapyd(() => ({ json: checkoutOk }));
  try {
    const result = await clientFor(fake.baseUrl).createCheckout({
      paymentId: PAYMENT_ID,
      amountCents: 1500,
      currency: 'USD',
      returnUrl: RETURN_URL,
    });

    assert.deepEqual(result, {
      checkoutId: 'checkout_abc123',
      redirectUrl: 'https://sandboxcheckout.rapyd.net/?token=x',
      status: 'pending',
    });

    const [request] = fake.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/checkout');
    assert.equal(request.headers.access_key, ACCESS_KEY);
    assert.equal(request.headers.idempotency, PAYMENT_ID);
    assert.match(request.headers.salt, /^[0-9a-f]{16}$/);
    assert.ok(Math.abs(Number(request.headers.timestamp) - Date.now() / 1000) < 60, 'timestamp is current');

    // The server recomputes the signature from what it received.
    assert.equal(
      request.headers.signature,
      signRequest({
        method: 'POST',
        urlPath: '/v1/checkout',
        salt: request.headers.salt,
        timestamp: request.headers.timestamp,
        accessKey: ACCESS_KEY,
        secretKey: SECRET_KEY,
        bodyString: request.body,
      }),
    );

    assert.deepEqual(JSON.parse(request.body), {
      amount: 15,
      currency: 'USD',
      country: 'CO',
      complete_checkout_url: RETURN_URL,
      cancel_checkout_url: RETURN_URL,
      merchant_reference_id: PAYMENT_ID,
    });
  } finally {
    fake.close();
  }
});

test('getCheckoutStatus maps Rapyd status DON to paid and sends no body', async () => {
  const fake = await fakeRapyd(() => ({
    json: { status: { status: 'SUCCESS' }, data: { id: 'checkout_abc123', status: 'DON' } },
  }));
  try {
    const result = await clientFor(fake.baseUrl).getCheckoutStatus('checkout_abc123');

    assert.deepEqual(result, { checkoutId: 'checkout_abc123', status: 'paid', providerStatus: 'DON' });
    assert.equal(fake.requests[0].method, 'GET');
    assert.equal(fake.requests[0].url, '/v1/checkout/checkout_abc123');
    assert.equal(fake.requests[0].body, '');
  } finally {
    fake.close();
  }
});

test('every documented Rapyd status has a mapping', async () => {
  const expected = { NEW: 'pending', INP: 'pending', DON: 'paid', EXP: 'expired', DEC: 'declined' };
  for (const [providerStatus, internal] of Object.entries(expected)) {
    const fake = await fakeRapyd(() => ({
      json: { status: { status: 'SUCCESS' }, data: { id: 'checkout_m1', status: providerStatus } },
    }));
    try {
      const result = await clientFor(fake.baseUrl).getCheckoutStatus('checkout_m1');
      assert.equal(result.status, internal, providerStatus);
    } finally {
      fake.close();
    }
  }
});

test('an invalid checkout ID is refused before any network call', async () => {
  let calls = 0;
  const client = clientFor('http://127.0.0.1:1', {
    fetchImpl: async () => {
      calls += 1;
      throw new Error('should not be called');
    },
  });

  await assert.rejects(
    () => client.getCheckoutStatus('../v1/payments'),
    (err) => err instanceof AppError && err.code === 'invalid_checkout_id' && err.status === 400,
  );
  assert.equal(calls, 0);
});

test('HTTP 401 from Rapyd becomes provider_auth_failed and is not retried', async () => {
  const fake = await fakeRapyd(() => ({ status: 401, json: { status: { status: 'ERROR', error_code: 'INVALID_SIGNATURE' } } }));
  try {
    await assert.rejects(
      () => clientFor(fake.baseUrl).createCheckout({ paymentId: PAYMENT_ID, amountCents: 100, currency: 'USD', returnUrl: RETURN_URL }),
      (err) => err.code === 'provider_auth_failed' && err.status === 502 && err.providerCode === 'INVALID_SIGNATURE',
    );
    assert.equal(fake.requests.length, 1);
  } finally {
    fake.close();
  }
});

test('a rejected request becomes provider_rejected and keeps the Rapyd text out of the message', async () => {
  const fake = await fakeRapyd(() => ({
    status: 400,
    json: { status: { status: 'ERROR', error_code: 'ERROR_CREATE_CHECKOUT', message: 'internal detail' } },
  }));
  try {
    await assert.rejects(
      () => clientFor(fake.baseUrl).createCheckout({ paymentId: PAYMENT_ID, amountCents: 100, currency: 'USD', returnUrl: RETURN_URL }),
      (err) => {
        assert.equal(err.code, 'provider_rejected');
        assert.equal(err.providerCode, 'ERROR_CREATE_CHECKOUT');
        assert.ok(!err.message.includes('internal detail'));
        return true;
      },
    );
  } finally {
    fake.close();
  }
});

test('HTTP 500 becomes provider_unavailable and is not retried', async () => {
  const fake = await fakeRapyd(() => ({ status: 500, json: { status: { status: 'ERROR' } } }));
  try {
    await assert.rejects(
      () => clientFor(fake.baseUrl).getCheckoutStatus('checkout_abc123'),
      (err) => err.code === 'provider_unavailable',
    );
    assert.equal(fake.requests.length, 1);
  } finally {
    fake.close();
  }
});

test('network failures are retried twice, then provider_unavailable', async () => {
  let calls = 0;
  const client = clientFor('http://127.0.0.1:1', {
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    () => client.createCheckout({ paymentId: PAYMENT_ID, amountCents: 100, currency: 'USD', returnUrl: RETURN_URL }),
    (err) => err.code === 'provider_unavailable',
  );
  assert.equal(calls, 3, 'one attempt plus two retries');
});

test('a retry after a network error uses a new salt and keeps the idempotency key', async () => {
  const fake = await fakeRapyd(() => ({ json: checkoutOk }));
  const seen = [];
  let calls = 0;
  try {
    const client = clientFor(fake.baseUrl, {
      fetchImpl: async (url, options) => {
        calls += 1;
        seen.push(options.headers);
        if (calls === 1) throw new TypeError('fetch failed');
        return fetch(url, options);
      },
    });

    const result = await client.createCheckout({ paymentId: PAYMENT_ID, amountCents: 100, currency: 'USD', returnUrl: RETURN_URL });

    assert.equal(result.checkoutId, 'checkout_abc123');
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].salt, seen[1].salt);
    assert.equal(seen[0].idempotency, seen[1].idempotency);
  } finally {
    fake.close();
  }
});
