// Open Payments client wrapper (prompt 18). A local fake wallet server stands in for the test network; no internet needed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-openpayments-'));
const KEY_ID = '11111111-2222-4333-8444-555555555555';

// A throwaway Ed25519 key, generated for this test only.
const { privateKey: privatePem } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const keyPath = join(tempDir, 'test-key.pem');
writeFileSync(keyPath, privatePem);

let hits = {};
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits[path] = (hits[path] ?? 0) + 1;

  if (path === '/wallet/alice') {
    const body = {
      id: `${baseUrl}/wallet/alice`,
      publicName: 'Alice',
      assetCode: 'EUR',
      assetScale: 2,
      authServer: `${baseUrl}/auth`,
      resourceServer: `${baseUrl}/rs`,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  if (path === '/wallet/broken') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"boom"}');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

let baseUrl = '';
let mod;

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Set the environment before the config module is loaded.
  process.env.JWT_SECRET = PLACEHOLDER_SECRET;
  process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
  process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
  process.env.DATABASE_PATH = join(tempDir, 'test.db');
  process.env.OPEN_PAYMENTS_WALLET_ADDRESS = `${baseUrl}/wallet/alice`;
  process.env.OPEN_PAYMENTS_KEY_ID = KEY_ID;
  process.env.OPEN_PAYMENTS_PRIVATE_KEY_PATH = keyPath;

  mod = await import('../src/providers/openpayments.js');
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('a public wallet document is read without any key', async () => {
  const wallet = await mod.getWalletAddress(`${baseUrl}/wallet/alice`, { allowHttp: true });
  assert.equal(wallet.id, `${baseUrl}/wallet/alice`);
  assert.equal(wallet.assetCode, 'EUR');
  assert.equal(wallet.assetScale, 2);
  assert.ok(wallet.authServer);
  assert.ok(wallet.resourceServer);
});

test('a wallet address must start with https unless the test explicitly allows http', async () => {
  await assert.rejects(
    () => mod.getWalletAddress(`${baseUrl}/wallet/alice`),
    (err) => err.code === 'invalid_wallet_address' && err.status === 400,
  );
  await assert.rejects(
    () => mod.getWalletAddress('not a url'),
    (err) => err.code === 'invalid_wallet_address',
  );
});

test('an unknown wallet is wallet_not_found, and it is not retried', async () => {
  hits = {};
  await assert.rejects(
    () => mod.getWalletAddress(`${baseUrl}/wallet/missing`, { allowHttp: true }),
    (err) => err.code === 'wallet_not_found' && err.status === 404,
  );
  assert.equal(hits['/wallet/missing'], 1, 'a rejected request is not retried');
});

test('a server failure is openpayments_unavailable', async () => {
  await assert.rejects(
    () => mod.getWalletAddress(`${baseUrl}/wallet/broken`, { allowHttp: true }),
    (err) => err.code === 'openpayments_unavailable' && err.status === 502,
  );
});

test('a connection that cannot be opened is retried, then reported as unavailable', async () => {
  await assert.rejects(
    () => mod.getWalletAddress('http://127.0.0.1:1/wallet/alice', { allowHttp: true }),
    (err) => err.code === 'openpayments_unavailable',
  );
});

test('the authenticated client is created from the key file and reused', async () => {
  mod.resetClient();
  const first = await mod.getClient();
  const second = await mod.getClient();
  assert.equal(first, second, 'the client is created once');
  assert.equal(typeof first.walletAddress.get, 'function');
});

test('a missing key file names the variable and does not reveal the path', async () => {
  mod.resetClient();
  const { config } = await import('../src/config.js');
  const original = config.openPayments.privateKeyPath;
  config.openPayments.privateKeyPath = join(tempDir, 'does-not-exist.pem');
  try {
    await assert.rejects(
      () => mod.getClient(),
      (err) => {
        assert.equal(err.code, 'openpayments_key_missing');
        assert.match(err.message, /OPEN_PAYMENTS_PRIVATE_KEY_PATH/);
        assert.ok(!err.message.includes('does-not-exist'), 'the path is not revealed');
        return true;
      },
    );
  } finally {
    config.openPayments.privateKeyPath = original;
    mod.resetClient();
  }
});

test('missing configuration says which variables to set', async () => {
  mod.resetClient();
  const { config } = await import('../src/config.js');
  const saved = { ...config.openPayments };
  config.openPayments.walletAddress = '';
  try {
    await assert.rejects(
      () => mod.getClient(),
      (err) => err.code === 'openpayments_not_configured' && /OPEN_PAYMENTS_WALLET_ADDRESS/.test(err.message),
    );
  } finally {
    Object.assign(config.openPayments, saved);
    mod.resetClient();
  }
});
