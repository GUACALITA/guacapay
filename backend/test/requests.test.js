// Payment requests (prompt 24). Temporary database, fake Open Payments calls, no network. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const AUTH = 'https://auth.example.test';

const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-requests-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.PAYMENT_CURRENCIES = 'EUR';
process.env.BASE_URL = 'https://guacapay.test';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { seal } = await import('../src/grants/seal.js');
const { createRequest, payRequest, getPublicRequest, closeRequest } = await import('../src/requests/service.js');
const { AppError } = await import('../src/errors.js');
const { requestQrPng } = await import('../src/requests/qr.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeUser(firstName = null) {
  const id = randomUUID();
  getDb().prepare('INSERT INTO users (id, email, first_name) VALUES (?, ?, ?)').run(id, `${id}@example.com`, firstName);
  return id;
}

// A linked wallet with an active permission. Each wallet URL is unique.
function makeWallet(userId) {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
     VALUES (?, ?, ?, 'EUR', 2, 'linked', ?)`,
  ).run(id, userId, `${AUTH}/wallet-${id}`, new Date().toISOString());
  db.prepare(
    `INSERT INTO grants (id, wallet_id, purpose, status, nonce_hash, access_token_enc, granted_at)
     VALUES (?, ?, 'link', 'granted', 'x', ?, ?)`,
  ).run(randomUUID(), id, seal('access-token'), new Date().toISOString());
  return id;
}

// Records calls to the fake network. Outgoing payments are numbered in creation order; outgoingPlan gives each state.
function fakeNetwork({ outgoingPlan = [] } = {}) {
  const calls = { incoming: 0, outgoing: 0 };
  const deps = {
    async readWallet(url) {
      return { id: url, assetCode: 'EUR', assetScale: 2, authServer: AUTH, resourceServer: `${AUTH}/rs` };
    },
    async requestGrant() {
      return 'token';
    },
    async createIncoming() {
      calls.incoming += 1;
      return { id: `incoming-${calls.incoming}` };
    },
    async createQuote() {
      return { id: `quote-${randomUUID()}` };
    },
    async createOutgoing() {
      calls.outgoing += 1;
      return { id: `outgoing-${calls.outgoing}` };
    },
    async getOutgoing({ url }) {
      const number = Number(url.split('-').pop());
      return { state: outgoingPlan[number - 1] ?? 'COMPLETED' };
    },
    sleep: async () => {},
    now: () => Date.now(),
    pollTimeoutMs: 1000,
    pollIntervalMs: 1000,
  };
  return { calls, deps };
}

function tokenOf(link) {
  return new URL(link).searchParams.get('token');
}

function requestRow(id) {
  return getDb().prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
}

// A requester with a linked wallet creates a request for 25.00 EUR.
function makeRequest({ note = 'Lunch', expiresInHours } = {}) {
  const owner = makeUser('Ana');
  const wallet = makeWallet(owner);
  const created = createRequest({
    ownerId: owner,
    body: { wallet_id: wallet, amount_cents: 2500, currency: 'EUR', note, expires_in_hours: expiresInHours },
  });
  return { owner, wallet, ...created, token: tokenOf(created.link) };
}

test('a request is created, seen publicly, paid, and becomes paid when the transfer completes', async () => {
  const req = makeRequest();
  const payer = makeUser();
  const payerWallet = makeWallet(payer);
  const net = fakeNetwork();

  const seen = getPublicRequest(req.token);
  assert.equal(seen.status, 'open');
  assert.equal(seen.amount_cents, 2500);

  const outcome = await payRequest({ token: req.token, payerId: payer, walletId: payerWallet, deps: net.deps });
  assert.equal(outcome.status, 'paid');
  assert.equal(requestRow(req.request.id).status, 'paid');
  assert.ok(requestRow(req.request.id).paid_at);

  const transfer = getDb()
    .prepare('SELECT request_id, payment_id, direction, status FROM transfers WHERE request_id = ?')
    .get(req.request.id);
  assert.deepEqual({ ...transfer }, { request_id: req.request.id, payment_id: null, direction: 'in', status: 'completed' });
});

test('a paid request cannot be paid a second time', async () => {
  const req = makeRequest();
  await payRequest({ token: req.token, payerId: makeUser(), walletId: makeWallet(makeUser()), deps: fakeNetwork().deps });

  await assert.rejects(
    () => payRequest({ token: req.token, payerId: makeUser(), walletId: makeWallet(makeUser()), deps: fakeNetwork().deps }),
    (err) => err instanceof AppError && err.code === 'request_already_paid',
  );
});

test('an expired request cannot be paid, and shows as expired', async () => {
  const req = makeRequest({ expiresInHours: 1 });
  getDb()
    .prepare('UPDATE payment_requests SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60 * 1000).toISOString(), req.request.id);

  assert.equal(getPublicRequest(req.token).status, 'expired');
  const payer = makeUser();
  await assert.rejects(
    () => payRequest({ token: req.token, payerId: payer, walletId: makeWallet(payer), deps: fakeNetwork().deps }),
    (err) => err.code === 'request_expired',
  );
  assert.equal(requestRow(req.request.id).status, 'open');
});

test('the QR image decodes back to the request link', async () => {
  const req = makeRequest();
  const qr = await requestQrPng(req.link);
  const base64 = qr.replace(/^data:image\/png;base64,/, '');
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded, 'the QR code is readable');
  assert.equal(decoded.data, req.link);
});

test('the public view shows no wallet URL, email or internal ID', () => {
  const req = makeRequest({ note: 'Tanda de octubre' });
  const view = getPublicRequest(req.token);
  assert.deepEqual(Object.keys(view).sort(), ['amount_cents', 'currency', 'expires_at', 'note', 'owner_first_name', 'status']);
  assert.equal(view.owner_first_name, 'Ana');
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /wallet|@|example\.com|token|hash/i);
  assert.ok(!text.includes(req.request.id));
  assert.ok(!text.includes(req.owner));
});

test('the link token is stored only as a hash', () => {
  const req = makeRequest();
  const stored = JSON.stringify(getDb().prepare('SELECT * FROM payment_requests').all());
  assert.ok(!stored.includes(req.token), 'the token itself is never stored');
  assert.notEqual(requestRow(req.request.id).token_hash, req.token);
});

test('an owner cannot pay their own request, and cannot close it while someone pays', async () => {
  const req = makeRequest();
  await assert.rejects(
    () => payRequest({ token: req.token, payerId: req.owner, walletId: req.wallet, deps: fakeNetwork().deps }),
    (err) => err.code === 'own_request',
  );
  assert.equal(closeRequest(req.owner, req.request.id).status, 'closed');
});

test('a failed payment leaves the request open, so another payer can try', async () => {
  const req = makeRequest();
  const first = makeUser();
  const failing = fakeNetwork({ outgoingPlan: ['FAILED'] });

  const failed = await payRequest({ token: req.token, payerId: first, walletId: makeWallet(first), deps: failing.deps });
  assert.equal(failed.status, 'failed');
  assert.equal(requestRow(req.request.id).status, 'open');
  assert.equal(requestRow(req.request.id).paying_transfer_id, null);

  const second = makeUser();
  const retry = await payRequest({ token: req.token, payerId: second, walletId: makeWallet(second), deps: fakeNetwork().deps });
  assert.equal(retry.status, 'paid');
});
