// Payment flow in the browser (prompt 11). Tests the logic the pages use, with a fake API client.
// Runs with the whole repository mounted, since the frontend lives outside backend/.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-flow-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_CURRENCIES = 'USD,EUR';

const { parseAmountToCents, formatCents } = await import('../../frontend/js/money.js');
const { validatePaymentForm, newIdempotencyKey } = await import('../../frontend/js/payment-form.js');
const { messageForError, messageForStatus } = await import('../../frontend/js/messages.js');
const { requestLoginCode, verifyLoginCode, startPayment, fetchCurrencies } = await import('../../frontend/js/flows.js');
const { ApiError } = await import('../../frontend/js/api.js');
const { createApp } = await import('../src/app.js');

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(here, '..', '..', 'frontend');

after(() => rmSync(tempDir, { recursive: true, force: true }));

// Records every call so tests can check what the pages sent.
function fakeClient(handler = async () => ({})) {
  const calls = [];
  let token = null;
  return {
    calls,
    getToken: () => token,
    setToken: (value) => {
      token = value;
    },
    isSignedIn: () => token !== null,
    get: async (path, options) => {
      calls.push({ method: 'GET', path, options });
      return handler('GET', path, undefined, options);
    },
    post: async (path, body, options) => {
      calls.push({ method: 'POST', path, body, options });
      return handler('POST', path, body, options);
    },
  };
}

test('amounts become whole cents without floating-point error', () => {
  assert.equal(parseAmountToCents('12'), 1200);
  assert.equal(parseAmountToCents('12.5'), 1250);
  assert.equal(parseAmountToCents('12.50'), 1250);
  assert.equal(parseAmountToCents(' 0.01 '), 1);
  assert.equal(parseAmountToCents('0.1'), 10);
  assert.equal(parseAmountToCents('19.99'), 1999);
});

test('amounts that are not valid money are rejected', () => {
  for (const text of ['', '0', '0.00', '-1', '1.234', '1,50', '12.', '.5', 'abc', '1e3', '99999999999999999999']) {
    assert.equal(parseAmountToCents(text), null, `"${text}"`);
  }
  assert.equal(parseAmountToCents(undefined), null);
});

test('formatCents shows two decimals and the currency', () => {
  assert.equal(formatCents(1550, 'USD'), '15.50 USD');
});

test('a valid form becomes the request body, with cents and an uppercase currency', () => {
  const result = validatePaymentForm(
    { recipientEmail: ' Bob@Example.com ', amount: '15.5', currency: 'eur', message: '  Lunch  ' },
    { currencies: ['USD', 'EUR'] },
  );

  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.body, {
    recipient_email: 'bob@example.com',
    amount_cents: 1550,
    currency: 'EUR',
    message: 'Lunch',
  });
});

test('an empty message is left out of the body', () => {
  const { body } = validatePaymentForm(
    { recipientEmail: 'bob@example.com', amount: '1', currency: 'USD', message: '   ' },
    { currencies: ['USD'] },
  );
  assert.equal('message' in body, false);
});

test('each invalid field gets its own message, and no body is produced', () => {
  const { errors, body } = validatePaymentForm(
    { recipientEmail: 'nope', amount: '0', currency: 'GBP', message: 'x'.repeat(501) },
    { currencies: ['USD'] },
  );

  assert.equal(body, null);
  assert.deepEqual(Object.keys(errors).sort(), ['amount', 'currency', 'message', 'recipientEmail']);
});

test('idempotency keys are long enough, use only allowed characters, and differ between attempts', () => {
  const keys = new Set();
  for (let i = 0; i < 200; i += 1) {
    const key = newIdempotencyKey();
    assert.match(key, /^[a-z0-9]{24}$/);
    keys.add(key);
  }
  assert.equal(keys.size, 200);
});

test('the key uses getRandomValues, so it works where randomUUID is unavailable', () => {
  const source = { getRandomValues: (bytes) => bytes.fill(7) };
  assert.equal(newIdempotencyKey(source), newIdempotencyKey(source));
  assert.equal(typeof source.randomUUID, 'undefined');
});

test('error messages come from a fixed list, never from raw text the server did not choose', () => {
  assert.equal(messageForError(new ApiError({ code: 'rate_limited', message: 'x', status: 429 })), 'Too many attempts. Wait a few minutes and try again.');
  assert.equal(
    messageForError(new ApiError({ code: 'something_new', message: '<script>bad()</script>', status: 500 })),
    'Something went wrong. Please try again.',
  );
});

test('every payment status has plain-language text, and an unknown one gets a safe fallback', () => {
  for (const status of ['created', 'awaiting_payment', 'paid', 'claimable', 'claimed', 'completed', 'expired', 'failed']) {
    assert.ok(messageForStatus(status).length > 0, status);
  }
  assert.equal(messageForStatus('mystery'), 'Status unknown. Refresh the page.');
});

test('requesting a code sends only the email, without a token', async () => {
  const client = fakeClient();
  await requestLoginCode(client, 'alice@example.com');

  assert.equal(client.calls[0].path, '/api/auth/request-code');
  assert.deepEqual(client.calls[0].body, { email: 'alice@example.com' });
  assert.equal(client.calls[0].options.auth, false);
});

test('a correct code stores the session token through the client', async () => {
  const client = fakeClient(async () => ({ token: 'session.token.value' }));
  await verifyLoginCode(client, 'alice@example.com', '123456');

  assert.equal(client.getToken(), 'session.token.value');
  assert.deepEqual(client.calls[0].body, { email: 'alice@example.com', code: '123456' });
});

test('starting a payment sends the Idempotency-Key header, then the checkout request', async () => {
  const key = 'abcdefgh12345678';
  const client = fakeClient(async (method, path) => {
    if (path === '/api/payments') return { id: 'pay-1', status: 'created' };
    return { redirectUrl: 'https://checkout.example/x' };
  });

  const result = await startPayment(client, { recipient_email: 'b@example.com', amount_cents: 100, currency: 'USD' }, key);

  assert.deepEqual(result, { paymentId: 'pay-1', redirectUrl: 'https://checkout.example/x' });
  assert.equal(client.calls[0].options.headers['Idempotency-Key'], key);
  assert.equal(client.calls[1].path, '/api/payments/pay-1/checkout');
});

test('when the checkout was already started, the payment page is used instead of a redirect', async () => {
  const client = fakeClient(async (method, path) => {
    if (path === '/api/payments') return { id: 'pay-2', status: 'awaiting_payment' };
    throw new ApiError({ code: 'checkout_not_available', message: 'x', status: 409 });
  });

  const result = await startPayment(client, { recipient_email: 'b@example.com', amount_cents: 100, currency: 'USD' }, 'k'.repeat(10));
  assert.deepEqual(result, { paymentId: 'pay-2', redirectUrl: null });
});

test('other errors while starting a payment are passed to the page', async () => {
  const client = fakeClient(async () => {
    throw new ApiError({ code: 'idempotency_conflict', message: 'x', status: 409 });
  });

  await assert.rejects(
    () => startPayment(client, { recipient_email: 'b@example.com', amount_cents: 100, currency: 'USD' }, 'k'.repeat(10)),
    (err) => err.code === 'idempotency_conflict',
  );
});

test('currencies come from the server, with USD as the fallback', async () => {
  const withList = fakeClient(async () => ({ sandbox: true, currencies: ['USD', 'EUR'] }));
  assert.deepEqual(await fetchCurrencies(withList), ['USD', 'EUR']);

  const withoutList = fakeClient(async () => ({ sandbox: true }));
  assert.deepEqual(await fetchCurrencies(withoutList), ['USD']);
});

test('the server reports the accepted currencies in /api/config', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config`);
    const body = await response.json();
    assert.deepEqual(body.currencies, ['USD', 'EUR']);
    assert.equal(typeof body.sandbox, 'boolean');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('claim steps send the token from the link, not the sign-in token', async () => {
  const { sendClaimCode, confirmClaim } = await import('../../frontend/js/flows.js');
  const client = fakeClient(async () => ({ status: 'completed' }));

  await sendClaimCode(client, 'link-token-value-0123456789abcdef', 'bob@example.com');
  assert.equal(client.calls[0].path, '/api/claims/verify-email');
  assert.deepEqual(client.calls[0].body, { token: 'link-token-value-0123456789abcdef', email: 'bob@example.com' });
  assert.equal(client.calls[0].options.auth, false);

  const result = await confirmClaim(client, {
    token: 'link-token-value-0123456789abcdef',
    code: '123456',
    destinationWalletAddress: 'https://ilp.interledger-test.dev/71dd8185',
  });
  assert.deepEqual(result, { status: 'completed' });
  assert.equal(client.calls[1].path, '/api/claims/confirm');
  assert.equal(client.calls[1].options.auth, false);
});

test('claim outcomes and errors have plain text, with no internal detail', async () => {
  const { messageForClaimResult } = await import('../../frontend/js/messages.js');
  assert.match(messageForClaimResult('completed'), /on its way/);
  assert.match(messageForClaimResult('failed'), /did not go through/);

  assert.equal(
    messageForError(new ApiError({ code: 'claim_used', message: 'raw', status: 409 })),
    'This claim has already been used.',
  );
  assert.equal(
    messageForError(new ApiError({ code: 'transfer_not_configured', message: 'raw', status: 503 })),
    'Transfers are not available yet. Your claim is still open. Try again later.',
  );
});

test('the claim page has its three steps and loads its page script', () => {
  const claim = readFileSync(join(frontendDir, 'claim.html'), 'utf8');
  for (const id of ['claim-email-form', 'claim-code-form', 'claim-destination-form', 'claim-result']) {
    assert.match(claim, new RegExp(`id="${id}"`));
  }
  assert.match(claim, /js\/pages\/claim\.js/);
  assert.equal(/<script type="module">/.test(claim), false, 'page logic lives in js/pages/');
});

test('pages keep their forms and load their page scripts', () => {
  const index = readFileSync(join(frontendDir, 'index.html'), 'utf8');
  assert.match(index, /id="email-form"/);
  assert.match(index, /id="code-form"/);
  assert.match(index, /js\/pages\/login\.js/);

  const newPage = readFileSync(join(frontendDir, 'new.html'), 'utf8');
  assert.match(newPage, /id="payment-form"/);
  assert.match(newPage, /id="currency"/);
  assert.match(newPage, /js\/pages\/new-payment\.js/);

  const payment = readFileSync(join(frontendDir, 'payment.html'), 'utf8');
  assert.match(payment, /js\/pages\/payment\.js/);
  assert.equal(/<script type="module">/.test(payment), false, 'page logic lives in js/pages/');
});

test('no frontend code writes HTML from strings, so server text cannot inject markup', () => {
  const walk = (dir) =>
    readdirSyncRecursive(dir).filter((file) => /\.(js|html)$/.test(file));
  for (const file of walk(frontendDir)) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(source), false, file);
  }
});

function readdirSyncRecursive(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...readdirSyncRecursive(path));
    else out.push(path);
  }
  return out;
}
