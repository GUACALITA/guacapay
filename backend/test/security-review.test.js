// Security review (prompt 32): regression checks for the findings fixed in this review. Offline: each refusal happens
// before any request is sent, so no network is needed. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-security-review-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { assertAllowedHost, getWalletAddress, startGrant } = await import('../src/providers/openpayments.js');
const { addWallet } = await import('../src/wallets/service.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

// F9: the server must not contact hosts a user chose. Hosts from the test network are the only ones allowed.
test('F9: a wallet address on a host the app does not call is refused before any request', async () => {
  await assert.rejects(
    () => getWalletAddress('https://evil.example.com/wallet/x'),
    (err) => err.code === 'wallet_host_not_allowed',
  );
});

test('F9: an authorization server named by a wallet document on another host is refused', async () => {
  await assert.rejects(
    () => startGrant({ authServer: 'https://evil.example.com/auth', access: [], finishUri: 'https://guacapay.test/cb', nonce: 'n' }),
    (err) => err.code === 'wallet_host_not_allowed',
  );
});

test('F9: linking a wallet on another host is refused, and nothing is stored', async () => {
  const user = randomUUID();
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(user, `${user}@example.com`);

  await assert.rejects(
    () => addWallet(user, 'https://evil.example.com/wallet/x'),
    (err) => err.code === 'wallet_host_not_allowed',
  );
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(user).n, 0);
});

test('F9: the test network hosts used by the wallet and its servers are allowed', () => {
  assert.equal(assertAllowedHost('https://ilp.interledger-test.dev/71dd8185'), 'https://ilp.interledger-test.dev/71dd8185');
  assert.equal(
    assertAllowedHost('https://auth.interledger-test.dev/f537937b-0000-0000-0000-000000000000'),
    'https://auth.interledger-test.dev/f537937b-0000-0000-0000-000000000000',
  );
});

test('F9: a host that only looks like an allowed one is refused', () => {
  for (const url of ['https://ilp.interledger-test.dev.evil.example.com/x', 'https://evil.example.com/ilp.interledger-test.dev']) {
    assert.throws(() => assertAllowedHost(url), (err) => err.code === 'wallet_host_not_allowed', url);
  }
});
