// Consent grants (prompt 20). Fake wallet calls and a test-only encryption key; no network. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-grants-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.BASE_URL = 'http://localhost:3202';
// Test-only key: 64 hexadecimal characters, generated for this run.
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { requestConsent, finishConsent, getAccessToken, revokeGrant } = await import('../src/grants/service.js');
const { AppError } = await import('../src/errors.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

const AUTH = 'https://auth.example.test';

function fakeDeps({ instant = false } = {}) {
  return {
    async readWallet() {
      return { assetCode: 'EUR', assetScale: 2, authServer: AUTH };
    },
    async startGrant({ finishUri }) {
      if (instant) return { access_token: { value: 'instant-access', expires_in: 3600 } };
      return {
        interact: { redirect: `${AUTH}/approve/${randomUUID()}?finish=${encodeURIComponent(finishUri)}` },
        continue: { uri: `${AUTH}/continue/${randomUUID()}`, access_token: { value: 'continue-secret-value' } },
      };
    },
    async continueGrant() {
      return { access_token: { value: 'access-secret-value', expires_in: 3600 } };
    },
  };
}

function makeUserWithWallet(status = 'pending') {
  const db = getDb();
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@example.com`);
  const walletId = randomUUID();
  db.prepare(
    `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
     VALUES (?, ?, ?, 'EUR', 2, ?, ?)`,
  ).run(walletId, id, `https://wallet.example.test/${randomUUID()}`, status, new Date().toISOString());
  return { id, token: issueToken(id), walletId };
}

function grantRow(id) {
  return getDb().prepare('SELECT * FROM grants WHERE id = ?').get(id);
}

test('a link grant starts pending and returns an approval URL; the continue token is stored encrypted', async () => {
  const user = makeUserWithWallet();
  const deps = fakeDeps();
  const started = await requestConsent({ userId: user.id, walletId: user.walletId, purpose: 'link', limitCents: 5000, deps });

  assert.equal(started.status, 'pending');
  assert.match(started.approvalUrl, /^https:\/\/auth\.example\.test\/approve\//);

  const row = grantRow(started.id);
  assert.equal(row.status, 'pending');
  assert.ok(!row.continue_token_enc.includes('continue-secret-value'), 'the token is not stored in plain text');
  assert.ok(!JSON.stringify(row).includes('continue-secret-value'));
});

test('a recurring grant needs a valid interval, and a bad one is refused before any call', async () => {
  const user = makeUserWithWallet();
  let called = false;
  const deps = { ...fakeDeps(), async startGrant() { called = true; return {}; } };

  await assert.rejects(
    () => requestConsent({ userId: user.id, walletId: user.walletId, purpose: 'recurring', limitCents: 500, deps }),
    (err) => err instanceof AppError && err.code === 'invalid_interval',
  );
  await assert.rejects(
    () => requestConsent({ userId: user.id, walletId: user.walletId, purpose: 'recurring', limitCents: 500, interval: 'monthly', deps }),
    (err) => err.code === 'invalid_interval',
  );
  assert.equal(called, false, 'no wallet call for an invalid request');
});

test('finishing with the right nonce grants the permission and links the wallet', async () => {
  const user = makeUserWithWallet();
  const deps = fakeDeps();
  const started = await requestConsent({ userId: user.id, walletId: user.walletId, purpose: 'link', limitCents: 5000, deps });

  const finishUri = new URL(new URL(started.approvalUrl).searchParams.get('finish'));
  const storedNonce = finishUri.searchParams.get('nonce');

  const done = await finishConsent({ grantId: started.id, nonce: storedNonce, interactRef: 'ref-123', deps });
  assert.equal(done.status, 'granted');

  const wallet = getDb().prepare('SELECT status FROM wallets WHERE id = ?').get(user.walletId);
  assert.equal(wallet.status, 'linked');
  assert.equal(getAccessToken(started.id), 'access-secret-value');
});

test('a wrong nonce is refused, and an approval finishes only once', async () => {
  const user = makeUserWithWallet();
  const deps = fakeDeps();
  const started = await requestConsent({ userId: user.id, walletId: user.walletId, purpose: 'link', limitCents: 5000, deps });

  await assert.rejects(
    () => finishConsent({ grantId: started.id, nonce: 'not-the-nonce', interactRef: 'ref', deps }),
    (err) => err.code === 'invalid_nonce',
  );

  const storedNonce = new URL(new URL(started.approvalUrl).searchParams.get('finish')).searchParams.get('nonce');
  await finishConsent({ grantId: started.id, nonce: storedNonce, interactRef: 'ref', deps });
  await assert.rejects(
    () => finishConsent({ grantId: started.id, nonce: storedNonce, interactRef: 'ref', deps }),
    (err) => err.code === 'grant_not_pending',
  );
});

test('a grant the wallet gives without asking is stored at once', async () => {
  const user = makeUserWithWallet();
  const result = await requestConsent({
    userId: user.id,
    walletId: user.walletId,
    purpose: 'link',
    limitCents: 1000,
    deps: fakeDeps({ instant: true }),
  });
  assert.equal(result.status, 'granted');
  assert.equal(result.approvalUrl, null);
  assert.equal(getAccessToken(result.id), 'instant-access');
});

test('an expired access token is refused and the grant is marked expired', async () => {
  const user = makeUserWithWallet();
  const result = await requestConsent({
    userId: user.id,
    walletId: user.walletId,
    purpose: 'link',
    limitCents: 1000,
    deps: fakeDeps({ instant: true }),
  });
  getDb().prepare('UPDATE grants SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), result.id);

  assert.throws(
    () => getAccessToken(result.id),
    (err) => err.code === 'grant_expired',
  );
  assert.equal(grantRow(result.id).status, 'expired');
});

test('another user cannot start a grant on a wallet they do not own, or revoke one', async () => {
  const owner = makeUserWithWallet();
  const other = makeUserWithWallet();
  const deps = fakeDeps();

  await assert.rejects(
    () => requestConsent({ userId: other.id, walletId: owner.walletId, purpose: 'link', limitCents: 1000, deps }),
    (err) => err.code === 'wallet_not_found',
  );

  const granted = await requestConsent({
    userId: owner.id,
    walletId: owner.walletId,
    purpose: 'link',
    limitCents: 1000,
    deps: fakeDeps({ instant: true }),
  });
  assert.throws(
    () => revokeGrant(other.id, granted.id),
    (err) => err.code === 'grant_not_found',
  );
});

test('revoking removes the stored token', async () => {
  const user = makeUserWithWallet();
  const granted = await requestConsent({
    userId: user.id,
    walletId: user.walletId,
    purpose: 'link',
    limitCents: 1000,
    deps: fakeDeps({ instant: true }),
  });
  const revoked = revokeGrant(user.id, granted.id);
  assert.equal(revoked.status, 'revoked');
  assert.equal(grantRow(granted.id).access_token_enc, null);
  assert.throws(() => getAccessToken(granted.id), (err) => err.code === 'grant_not_granted');
});
