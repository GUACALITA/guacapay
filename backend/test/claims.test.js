// Claims (prompt 12). Runs the app in-process on a temporary database with fake mail and transfer. No network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-claims-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.PAYMENT_CURRENCIES = 'USD';
process.env.BASE_URL = 'https://guacapay.test';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { hashSecret } = await import('../src/hash.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { AppError } = await import('../src/errors.js');
const { createPayment, transitionPayment } = await import('../src/payments/service.js');
const { attachCheckout } = await import('../src/payments/checkout.js');
const { STATUS } = await import('../src/payments/states.js');
const { issueClaim, issuePendingClaims, validateDestination, CLAIM_STATUS } = await import('../src/claims/service.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

const GOOD_DESTINATION = 'https://ilp.interledger-test.dev/71dd8185';

function makeUser() {
  const id = randomUUID();
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@example.com`);
  return { id, token: issueToken(id) };
}

// A payment that has been paid, with no claim yet.
function makePaidPayment(senderId) {
  const recipient = `recipient-${randomUUID()}@example.com`;
  const { payment } = createPayment({
    senderId,
    body: { recipient_email: recipient, amount_cents: 2500, currency: 'USD' },
  });
  attachCheckout(payment.id, `checkout_${randomUUID().replace(/-/g, '')}`);
  transitionPayment(payment.id, STATUS.PAID);
  return { id: payment.id, recipient };
}

function fakeMailer({ failClaimLinks = false } = {}) {
  const sent = { codes: [], links: [] };
  return {
    sent,
    async sendLoginCode(email, code) {
      sent.codes.push({ email, code });
    },
    async sendClaimLink(email, link) {
      if (failClaimLinks) throw new AppError('email_not_configured', 503, 'x');
      sent.links.push({ email, link });
    },
  };
}

function tokenFrom(link) {
  return new URL(link).searchParams.get('token');
}

function fakeTransfer({ fail } = {}) {
  const calls = [];
  const transfer = async (input) => {
    calls.push(input);
    if (fail) throw fail;
    return { transferId: 'tx-1' };
  };
  return { calls, transfer };
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

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function claimRow(paymentId) {
  return getDb().prepare('SELECT * FROM claims WHERE payment_id = ?').get(paymentId);
}

function paymentStatus(paymentId) {
  return getDb().prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status;
}

// Issues a claim and returns the token from the link that was sent.
async function issuedToken(paymentId, mailer) {
  await issueClaim(paymentId, { mailer });
  return tokenFrom(mailer.sent.links.at(-1).link);
}

test('a paid payment gets a claim link by email, and the payment becomes claimable', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();

  const result = await issueClaim(payment.id, { mailer });

  assert.deepEqual(result, { issued: true });
  assert.equal(mailer.sent.links.length, 1);
  assert.equal(mailer.sent.links[0].email, payment.recipient);
  assert.match(mailer.sent.links[0].link, /^https:\/\/guacapay\.test\/claim\.html\?token=/);
  assert.equal(paymentStatus(payment.id), 'claimable');
});

test('only a hash of the link token is stored', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);

  const row = claimRow(payment.id);
  assert.equal(row.token_hash, hashSecret(token));
  assert.ok(!JSON.stringify(row).includes(token), 'the raw token appears nowhere in the row');
  assert.ok(token.length >= 43, 'token is at least 32 random bytes, base64url');
});

test('if the email cannot be sent, no claim is kept and the payment stays paid until a later attempt', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);

  const failed = await issueClaim(payment.id, { mailer: fakeMailer({ failClaimLinks: true }) });
  assert.deepEqual(failed, { issued: false, reason: 'email_failed' });
  assert.equal(claimRow(payment.id), undefined);
  assert.equal(paymentStatus(payment.id), 'paid');

  const mailer = fakeMailer();
  const sweep = await issuePendingClaims({ mailer });
  assert.ok(sweep.issued >= 1);
  assert.equal(paymentStatus(payment.id), 'claimable');
  assert.equal(mailer.sent.links.length >= 1, true);
});

test('verifying the email with the wrong token or wrong address is refused', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);

  await withServer(createApp({ mailer }), async (base) => {
    const unknown = await post(base, '/api/claims/verify-email', { token: 'x'.repeat(43), email: payment.recipient });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'claim_not_found');

    const wrongEmail = await post(base, '/api/claims/verify-email', { token, email: 'someone-else@example.com' });
    assert.equal(wrongEmail.status, 400);
    assert.equal(wrongEmail.body.error.code, 'email_mismatch');
    assert.equal(mailer.sent.codes.length, 0, 'no code is sent to a wrong address');

    const right = await post(base, '/api/claims/verify-email', { token, email: payment.recipient.toUpperCase() });
    assert.equal(right.status, 202);
    assert.equal(mailer.sent.codes.at(-1).email, payment.recipient);
  });
});

test('a wrong destination is refused before the code is used, so the code still works', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);
  const { transfer, calls } = fakeTransfer();

  await withServer(createApp({ mailer, transfer }), async (base) => {
    await post(base, '/api/claims/verify-email', { token, email: payment.recipient });
    const { code } = mailer.sent.codes.at(-1);

    const badDestination = await post(base, '/api/claims/confirm', {
      token,
      code,
      destinationWalletAddress: 'http://ilp.interledger-test.dev/71dd8185',
    });
    assert.equal(badDestination.status, 400);
    assert.equal(badDestination.body.error.code, 'invalid_destination');
    assert.equal(calls.length, 0);

    const good = await post(base, '/api/claims/confirm', { token, code, destinationWalletAddress: GOOD_DESTINATION });
    assert.equal(good.status, 200);
  });
});

test('a wrong code is refused', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);
  const { transfer, calls } = fakeTransfer();

  await withServer(createApp({ mailer, transfer }), async (base) => {
    await post(base, '/api/claims/verify-email', { token, email: payment.recipient });
    const real = mailer.sent.codes.at(-1).code;
    const wrong = real === '000000' ? '111111' : '000000';

    const result = await post(base, '/api/claims/confirm', { token, code: wrong, destinationWalletAddress: GOOD_DESTINATION });
    assert.equal(result.status, 401);
    assert.equal(calls.length, 0, 'no transfer without the right code');
  });
});

test('a valid claim transfers once, completes the payment, and cannot be used again', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);
  const { transfer, calls } = fakeTransfer();

  await withServer(createApp({ mailer, transfer }), async (base) => {
    await post(base, '/api/claims/verify-email', { token, email: payment.recipient });
    const { code } = mailer.sent.codes.at(-1);

    const first = await post(base, '/api/claims/confirm', { token, code, destinationWalletAddress: GOOD_DESTINATION });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { status: 'completed' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      paymentId: payment.id,
      amountCents: 2500,
      currency: 'USD',
      destination: GOOD_DESTINATION,
    });

    assert.equal(paymentStatus(payment.id), 'completed');
    const row = claimRow(payment.id);
    assert.equal(row.status, CLAIM_STATUS.CLAIMED);
    assert.equal(row.destination, GOOD_DESTINATION);

    const again = await post(base, '/api/claims/confirm', { token, code, destinationWalletAddress: GOOD_DESTINATION });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'claim_used');
    assert.equal(calls.length, 1, 'no second transfer');
  });
});

test('when transfers are not available yet, the claim stays open so it can be tried later', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);

  await withServer(createApp({ mailer }), async (base) => {
    await post(base, '/api/claims/verify-email', { token, email: payment.recipient });
    const first = mailer.sent.codes.at(-1).code;

    const notReady = await post(base, '/api/claims/confirm', {
      token,
      code: first,
      destinationWalletAddress: GOOD_DESTINATION,
    });
    assert.equal(notReady.status, 503);
    assert.equal(notReady.body.error.code, 'transfer_not_configured');
    assert.equal(claimRow(payment.id).status, CLAIM_STATUS.OPEN);
    assert.equal(paymentStatus(payment.id), 'claimable');

    // The code was used, so a new one is needed. Once transfers are available, the same link works.
    await post(base, '/api/claims/verify-email', { token, email: payment.recipient });
    const second = mailer.sent.codes.at(-1).code;
    const { transfer } = fakeTransfer();

    await withServer(createApp({ mailer, transfer }), async (readyBase) => {
      const result = await post(readyBase, '/api/claims/confirm', {
        token,
        code: second,
        destinationWalletAddress: GOOD_DESTINATION,
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { status: 'completed' });
    });
  });
});

test('a transfer that fails marks the payment failed, records why, and does not reopen the claim', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);
  const { transfer } = fakeTransfer({ fail: new AppError('provider_rejected', 422, 'x') });

  await withServer(createApp({ mailer, transfer }), async (base) => {
    await post(base, '/api/claims/verify-email', { token, email: payment.recipient });
    const { code } = mailer.sent.codes.at(-1);

    const result = await post(base, '/api/claims/confirm', { token, code, destinationWalletAddress: GOOD_DESTINATION });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { status: 'failed' });
  });

  assert.equal(paymentStatus(payment.id), 'failed');
  assert.equal(claimRow(payment.id).status, CLAIM_STATUS.CLAIMED);
  const event = getDb()
    .prepare("SELECT payload_json FROM payment_events WHERE payment_id = ? AND type = 'transfer.failed'")
    .get(payment.id);
  assert.deepEqual(JSON.parse(event.payload_json), { reason: 'provider_rejected' });
});

test('a claim that is already being processed cannot start a second transfer', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);
  const { transfer, calls } = fakeTransfer();

  getDb().prepare('UPDATE claims SET status = ? WHERE payment_id = ?').run(CLAIM_STATUS.CLAIMING, payment.id);

  await withServer(createApp({ mailer, transfer }), async (base) => {
    const result = await post(base, '/api/claims/confirm', { token, code: '123456', destinationWalletAddress: GOOD_DESTINATION });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'claim_in_progress');
    assert.equal(calls.length, 0);
  });
});

test('an expired claim cannot be opened', async () => {
  const alice = makeUser();
  const payment = makePaidPayment(alice.id);
  const mailer = fakeMailer();
  const token = await issuedToken(payment.id, mailer);

  getDb()
    .prepare('UPDATE claims SET expires_at = ? WHERE payment_id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), payment.id);

  await withServer(createApp({ mailer }), async (base) => {
    const result = await post(base, '/api/claims/verify-email', { token, email: payment.recipient });
    assert.equal(result.status, 410);
    assert.equal(result.body.error.code, 'claim_expired');
  });
});

test('destinations must be https addresses on a configured wallet host', () => {
  assert.equal(validateDestination(GOOD_DESTINATION), GOOD_DESTINATION);
  assert.equal(validateDestination('  https://ilp.interledger-test.dev/abc  '), 'https://ilp.interledger-test.dev/abc');

  for (const bad of [
    'http://ilp.interledger-test.dev/71dd8185',
    'https://evil.example.com/71dd8185',
    'https://ilp.interledger-test.dev/',
    'https://ilp.interledger-test.dev/71dd8185?x=1',
    'https://user:pass@ilp.interledger-test.dev/71dd8185',
    'https://ilp.interledger-test.dev/71dd8185#frag',
    'javascript:alert(1)',
    'not a url',
    '',
  ]) {
    assert.throws(
      () => validateDestination(bad),
      (err) => err.code === 'invalid_destination',
      `"${bad}" should be refused`,
    );
  }
});
