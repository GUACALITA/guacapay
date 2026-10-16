// Rapyd webhook checks (prompt 07). No network needed: the forwarder is a stub or a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGatewayApp } from '../src/app.js';
import { createRapydWebhooks, parseWebhookEvent, webhookSignatureCandidates } from '../src/providers/rapyd.js';
import { createForwarder } from '../src/forward.js';
import { AppError } from '../src/errors.js';

const TOKEN = 'gateway-test-token-0123456789abcdef0123';
const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-0123456789';
const WEBHOOK_URL = 'https://guacapay.example.com/webhooks/rapyd';
const PAYMENT_ID = '3f6b2a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

const webhooks = createRapydWebhooks({ url: WEBHOOK_URL, accessKey: ACCESS_KEY, secretKey: SECRET_KEY });

const eventBody = JSON.stringify({
  id: 'wh_test123',
  type: 'PAYMENT_COMPLETED',
  data: { id: 'payment_abc', status: 'CLO', merchant_reference_id: PAYMENT_ID },
});

function signedHeaders(body, { encoding = 0, salt = 's1a2b3c4d5e6f708', timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const signature = webhookSignatureCandidates({
    url: WEBHOOK_URL,
    salt,
    timestamp,
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    bodyString: body,
  })[encoding];
  return { salt, timestamp, signature };
}

async function withServer(forwarded, callback) {
  const app = createGatewayApp({
    rapyd: {},
    gatewayToken: TOKEN,
    webhooks,
    forward: async (event) => {
      forwarded.push(event);
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function postWebhook(base, body, headers = {}) {
  const response = await fetch(`${base}/webhooks/rapyd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, body: await response.json() };
}

// The response is sent before forwarding, so give the background step a moment.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a correctly signed webhook is acknowledged and forwarded in normalized form', async () => {
  const forwarded = [];
  await withServer(forwarded, async (base) => {
    const result = await postWebhook(base, eventBody, signedHeaders(eventBody));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { received: true });
    await settle();
  });

  assert.deepEqual(forwarded, [
    {
      eventId: 'wh_test123',
      type: 'PAYMENT_COMPLETED',
      paymentReference: PAYMENT_ID,
      providerPaymentId: 'payment_abc',
    },
  ]);
});

test('both signature encodings are accepted', async () => {
  for (const encoding of [0, 1]) {
    const forwarded = [];
    await withServer(forwarded, async (base) => {
      const result = await postWebhook(base, eventBody, signedHeaders(eventBody, { encoding }));
      assert.equal(result.status, 200, `encoding ${encoding}`);
      await settle();
    });
    assert.equal(forwarded.length, 1, `encoding ${encoding}`);
  }
});

test('a wrong signature is refused and nothing is forwarded', async () => {
  const forwarded = [];
  await withServer(forwarded, async (base) => {
    const headers = { ...signedHeaders(eventBody), signature: 'bm90LXRoZS1zaWduYXR1cmU=' };
    const result = await postWebhook(base, eventBody, headers);
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'invalid_signature');
    await settle();
  });
  assert.equal(forwarded.length, 0);
});

test('a body changed after signing is refused', async () => {
  const forwarded = [];
  const tampered = eventBody.replace('CLO', 'NEW');
  await withServer(forwarded, async (base) => {
    const result = await postWebhook(base, tampered, signedHeaders(eventBody));
    assert.equal(result.status, 401);
    await settle();
  });
  assert.equal(forwarded.length, 0);
});

test('missing signature headers are refused', async () => {
  const forwarded = [];
  await withServer(forwarded, async (base) => {
    const result = await postWebhook(base, eventBody);
    assert.equal(result.status, 401);
    await settle();
  });
  assert.equal(forwarded.length, 0);
});

test('a signed body that is not JSON is rejected with 400', async () => {
  const forwarded = [];
  const notJson = 'not json at all';
  await withServer(forwarded, async (base) => {
    const result = await postWebhook(base, notJson, signedHeaders(notJson));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_webhook');
    await settle();
  });
  assert.equal(forwarded.length, 0);
});

test('parseWebhookEvent keeps only the fields the system uses', () => {
  const event = parseWebhookEvent(eventBody);
  assert.deepEqual(event, {
    eventId: 'wh_test123',
    type: 'PAYMENT_COMPLETED',
    paymentReference: PAYMENT_ID,
    providerPaymentId: 'payment_abc',
  });

  const noReference = parseWebhookEvent(JSON.stringify({ id: 'wh_2', type: 'PAYMENT_COMPLETED', data: { id: 'p' } }));
  assert.equal(noReference.paymentReference, null);
});

test('parseWebhookEvent refuses a body without an ID or type', () => {
  assert.throws(() => parseWebhookEvent('{"data":{}}'), (err) => err instanceof AppError && err.code === 'invalid_webhook');
});

test('forwarder retries server errors and succeeds on the second attempt', async () => {
  let calls = 0;
  const forward = createForwarder({
    appUrl: 'http://app.test',
    token: TOKEN,
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: calls === 1 ? 500 : 200 });
    },
  });

  await forward({ eventId: 'wh_1', type: 'PAYMENT_COMPLETED', paymentReference: PAYMENT_ID });
  assert.equal(calls, 2);
});

test('forwarder gives up after three attempts and reports the failure', async () => {
  let calls = 0;
  const failures = [];
  const forward = createForwarder({
    appUrl: 'http://app.test',
    token: TOKEN,
    retryDelayMs: 1,
    onFailure: (eventId, reason) => failures.push({ eventId, reason }),
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
  });

  await forward({ eventId: 'wh_2', type: 'PAYMENT_COMPLETED', paymentReference: PAYMENT_ID });
  assert.equal(calls, 3);
  assert.deepEqual(failures, [{ eventId: 'wh_2', reason: 'gave up after retries' }]);
});

test('forwarder does not retry a client error', async () => {
  let calls = 0;
  const failures = [];
  const forward = createForwarder({
    appUrl: 'http://app.test',
    token: TOKEN,
    retryDelayMs: 1,
    onFailure: (eventId, reason) => failures.push(reason),
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 401 });
    },
  });

  await forward({ eventId: 'wh_3', type: 'PAYMENT_COMPLETED', paymentReference: null });
  assert.equal(calls, 1);
  assert.deepEqual(failures, ['app answered 401']);
});
