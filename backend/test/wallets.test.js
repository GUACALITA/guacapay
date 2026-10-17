// Wallet linking (prompt 19). A fake wallet reader stands in for the test network; no network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-wallets-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { markWalletLinked } = await import('../src/wallets/service.js');
const { AppError } = await import('../src/errors.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

// Stands in for the public wallet document. Only addresses under this prefix exist.
const PREFIX = 'https://ilp.example.test/wallet/';
async function fakeReader(url) {
  if (!url.startsWith(PREFIX)) {
    throw new AppError('wallet_not_found', 404, 'That wallet address was not found on the test network.');
  }
  return {
    id: url,
    publicName: 'Owner',
    assetCode: 'EUR',
    assetScale: 2,
    authServer: 'https://ilp.example.test/auth',
    resourceServer: 'https://ilp.example.test/rs',
  };
}

function makeUser() {
  const id = randomUUID();
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@example.com`);
  return { id, token: issueToken(id) };
}

async function withServer(callback) {
  const server = createApp({ walletReader: fakeReader }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function call(base, method, path, { token, body } = {}) {
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

test('a user adds a wallet, it is listed, and it stays pending until consent', async () => {
  const alice = makeUser();
  const url = `${PREFIX}${randomUUID()}`;

  await withServer(async (base) => {
    const added = await call(base, 'POST', '/api/wallets', { token: alice.token, body: { wallet_url: url } });
    assert.equal(added.status, 201);
    assert.equal(added.body.status, 'pending');
    assert.equal(added.body.asset_code, 'EUR');
    assert.equal(added.body.asset_scale, 2);
    assert.equal(added.body.wallet_url, url);
    assert.equal(added.body.key_id, undefined, 'no key data is returned');

    const listed = await call(base, 'GET', '/api/wallets', { token: alice.token });
    assert.equal(listed.body.wallets.length, 1);
    assert.equal(listed.body.wallets[0].id, added.body.id);
  });
});

test('adding the same wallet again by the same user returns the existing one', async () => {
  const alice = makeUser();
  const url = `${PREFIX}${randomUUID()}`;

  await withServer(async (base) => {
    const first = await call(base, 'POST', '/api/wallets', { token: alice.token, body: { wallet_url: url } });
    const again = await call(base, 'POST', '/api/wallets', { token: alice.token, body: { wallet_url: url } });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
  });
});

test('a wallet already linked to another user is refused with wallet_in_use', async () => {
  const owner = makeUser();
  const other = makeUser();
  const url = `${PREFIX}${randomUUID()}`;

  await withServer(async (base) => {
    await call(base, 'POST', '/api/wallets', { token: owner.token, body: { wallet_url: url } });
    const taken = await call(base, 'POST', '/api/wallets', { token: other.token, body: { wallet_url: url } });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'wallet_in_use');
  });
});

test('another user cannot see or revoke a wallet (both answer 404)', async () => {
  const owner = makeUser();
  const other = makeUser();
  const url = `${PREFIX}${randomUUID()}`;

  await withServer(async (base) => {
    const added = await call(base, 'POST', '/api/wallets', { token: owner.token, body: { wallet_url: url } });

    const listed = await call(base, 'GET', '/api/wallets', { token: other.token });
    assert.equal(listed.body.wallets.length, 0);

    const revoked = await call(base, 'POST', `/api/wallets/${added.body.id}/revoke`, { token: other.token });
    assert.equal(revoked.status, 404);
    assert.equal(revoked.body.error.code, 'wallet_not_found');
  });
});

test('the owner revokes a wallet, and then another user may link it', async () => {
  const owner = makeUser();
  const other = makeUser();
  const url = `${PREFIX}${randomUUID()}`;

  await withServer(async (base) => {
    const added = await call(base, 'POST', '/api/wallets', { token: owner.token, body: { wallet_url: url } });
    const revoked = await call(base, 'POST', `/api/wallets/${added.body.id}/revoke`, { token: owner.token });
    assert.equal(revoked.body.status, 'revoked');

    const relinked = await call(base, 'POST', '/api/wallets', { token: other.token, body: { wallet_url: url } });
    assert.equal(relinked.status, 201);
  });
});

test('a wallet becomes linked only through the consent step', async () => {
  const alice = makeUser();
  const url = `${PREFIX}${randomUUID()}`;

  await withServer(async (base) => {
    const added = await call(base, 'POST', '/api/wallets', { token: alice.token, body: { wallet_url: url } });
    assert.equal(added.body.status, 'pending');

    const linked = markWalletLinked(added.body.id);
    assert.equal(linked.status, 'linked');
    assert.ok(linked.linked_at);
  });
});

test('a wallet address must start with https; the real reader refuses http before any call', async () => {
  const alice = makeUser();
  const { createApp: createRealApp } = await import('../src/app.js');
  const server = createRealApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await call(base, 'POST', '/api/wallets', {
      token: alice.token,
      body: { wallet_url: 'http://ilp.example.test/wallet/x' },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_wallet_address');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('wallet routes need a signed-in user', async () => {
  await withServer(async (base) => {
    const result = await call(base, 'GET', '/api/wallets');
    assert.equal(result.status, 401);
  });
});
