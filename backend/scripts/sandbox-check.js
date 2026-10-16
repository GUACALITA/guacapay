// Manual check against the real Rapyd sandbox and the Interledger test wallet.
// Creates one sandbox checkout (never paid). Not part of `npm test`. Never prints secret values.
//
// Needs the gateway running (docker compose, or `npm start` in gateway/) and these in the repo-root .env:
//   GATEWAY_URL (default http://localhost:3203), GATEWAY_TOKEN, BASE_URL, OPEN_PAYMENTS_WALLET_ADDRESS
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '..', '..', '.env') });

const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:3203').replace(/\/+$/, '');
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const WALLET_URL = (process.env.OPEN_PAYMENTS_WALLET_ADDRESS || '').replace(/\/+$/, '');

let stepNumber = 0;

function pass(name, detail = '') {
  stepNumber += 1;
  console.log(`PASS ${stepNumber}. ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, reason) {
  stepNumber += 1;
  console.log(`FAIL ${stepNumber}. ${name} — ${reason}`);
  process.exit(1);
}

async function request(method, url, { token, body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { status: 0, body: null };
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

if (!GATEWAY_TOKEN) fail('configuration', 'GATEWAY_TOKEN is not set in .env');
if (!WALLET_URL) fail('configuration', 'OPEN_PAYMENTS_WALLET_ADDRESS is not set in .env');
if (!BASE_URL) fail('configuration', 'BASE_URL is not set in .env');

// 1. The gateway is up.
const health = await request('GET', `${GATEWAY_URL}/health`);
if (health.status !== 200) {
  fail('gateway is reachable', `no answer from ${GATEWAY_URL} (start the gateway first)`);
}
pass('gateway is reachable', `${GATEWAY_URL}/health`);

// 2. The gateway refuses calls without its token.
const refused = await request('POST', `${GATEWAY_URL}/checkout`, { body: {} });
if (refused.status !== 401) {
  fail('gateway refuses calls without a token', `expected 401, got ${refused.status}`);
}
pass('gateway refuses calls without a token');

// 3. A sandbox checkout is created through the gateway.
// Rapyd does not accept localhost return URLs, so BASE_URL must be a public address.
if (/localhost|127\.0\.0\.1/.test(BASE_URL)) {
  fail('return URL is public', 'BASE_URL points to localhost; Rapyd rejects localhost return URLs');
}
const paymentId = randomUUID();
const checkout = await request('POST', `${GATEWAY_URL}/checkout`, {
  token: GATEWAY_TOKEN,
  body: {
    paymentId,
    amountCents: 100,
    currency: 'USD',
    returnUrl: `${BASE_URL}/payment.html?id=${paymentId}`,
  },
});
if (checkout.status !== 201) {
  const code = checkout.body?.error?.code ?? `HTTP ${checkout.status}`;
  fail('sandbox checkout is created', `${code}: ${checkout.body?.error?.message ?? 'no detail'}`);
}
if (!checkout.body.redirectUrl || !checkout.body.checkoutId) {
  fail('sandbox checkout is created', 'the response has no redirect URL or checkout ID');
}
pass('sandbox checkout is created', `status ${checkout.body.status}`);

// 4. The checkout status can be read back as pending (nobody has paid it).
const status = await request('GET', `${GATEWAY_URL}/checkout/status/${checkout.body.checkoutId}`, { token: GATEWAY_TOKEN });
if (status.status !== 200) {
  fail('checkout status is readable', `HTTP ${status.status}`);
}
if (status.body.status !== 'pending') {
  fail('checkout status is readable', `expected pending, got ${status.body.status}`);
}
pass('checkout status is readable', 'pending, as expected for an unpaid checkout');

// 5. The Interledger test wallet answers and reports its asset.
const wallet = await request('GET', WALLET_URL);
if (wallet.status !== 200 || !wallet.body?.assetCode) {
  fail('testnet sender wallet answers', `HTTP ${wallet.status}, no asset code`);
}
pass('testnet sender wallet answers', `asset ${wallet.body.assetCode}`);

console.log(`\nAll ${stepNumber} checks passed. The sandbox checkout ${checkout.body.checkoutId} was created and is unpaid.`);
