// Transfer engine (prompt 21). Fake Open Payments calls and a test-only encryption key; no network. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-transfers-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { seal } = await import('../src/grants/seal.js');
const { createTransfer, runTransfer, getTransfer } = await import('../src/transfers/engine.js');
const { AppError } = await import('../src/errors.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

const AUTH = 'https://auth.example.test';
const SENDER_URL = 'https://wallet.example.test/sender';
const RECEIVER_URL = 'https://wallet.example.test/receiver';

// A linked sender wallet with an active permission.
function makeSender({ withGrant = true } = {}) {
  const db = getDb();
  const userId = randomUUID();
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(userId, `${userId}@example.com`);
  const walletId = randomUUID();
  db.prepare(
    `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
     VALUES (?, ?, ?, 'EUR', 2, 'linked', ?)`,
  ).run(walletId, userId, `${SENDER_URL}-${walletId}`, new Date().toISOString());
  if (withGrant) {
    db.prepare(
      `INSERT INTO grants (id, wallet_id, purpose, status, nonce_hash, access_token_enc, granted_at)
       VALUES (?, ?, 'link', 'granted', 'x', ?, ?)`,
    ).run(randomUUID(), walletId, seal('sender-access-token'), new Date().toISOString());
  }
  return { walletId, walletUrl: `${SENDER_URL}-${walletId}` };
}

function fakeDeps({ receiverCurrency = 'EUR', outgoingStates = ['COMPLETED'], outgoingError = null } = {}) {
  const calls = { incoming: 0, quote: 0, outgoing: 0, polls: 0 };
  let clock = 0;
  return {
    calls,
    async readWallet(url) {
      const isReceiver = url === RECEIVER_URL;
      return {
        id: url,
        assetCode: isReceiver ? receiverCurrency : 'EUR',
        assetScale: 2,
        authServer: AUTH,
        resourceServer: `${AUTH}/rs`,
      };
    },
    async requestGrant({ access }) {
      return `token-for-${access[0].type}`;
    },
    async createIncoming() {
      calls.incoming += 1;
      return { id: `incoming-${calls.incoming}` };
    },
    async createQuote() {
      calls.quote += 1;
      return { id: `quote-${calls.quote}` };
    },
    async createOutgoing() {
      calls.outgoing += 1;
      if (outgoingError) throw outgoingError;
      return { id: `outgoing-${calls.outgoing}` };
    },
    async getOutgoing() {
      const state = outgoingStates[Math.min(calls.polls, outgoingStates.length - 1)];
      calls.polls += 1;
      return { state };
    },
    sleep: async () => {},
    now: () => {
      clock += 1000;
      return clock;
    },
    pollTimeoutMs: 5000,
    pollIntervalMs: 1000,
  };
}

function newTransfer(sender, amountCents = 1500) {
  return createTransfer({
    fromWalletId: sender.walletId,
    toWalletUrl: RECEIVER_URL,
    amountCents,
    currency: 'EUR',
  });
}

function legs(transferId) {
  return getDb().prepare('SELECT kind, status, remote_id FROM transfer_legs WHERE transfer_id = ? ORDER BY kind').all(transferId);
}

test('a full transfer runs three legs and completes', async () => {
  const sender = makeSender();
  const transfer = newTransfer(sender);
  const deps = fakeDeps();

  const result = await runTransfer(transfer.id, { deps });

  assert.equal(result.status, 'completed');
  assert.equal(result.failure_code, null);
  assert.deepEqual(
    legs(transfer.id).map((leg) => [leg.kind, leg.status]),
    [
      ['incoming', 'created'],
      ['outgoing', 'completed'],
      ['quote', 'created'],
    ],
  );
});

test('running the same transfer twice creates one outgoing payment', async () => {
  const sender = makeSender();
  const transfer = newTransfer(sender);
  const deps = fakeDeps();

  await runTransfer(transfer.id, { deps });
  await runTransfer(transfer.id, { deps });

  assert.equal(deps.calls.outgoing, 1);
  assert.equal(deps.calls.incoming, 1);
});

test('a receiving wallet in another currency is refused before any money call', async () => {
  const sender = makeSender();
  const transfer = newTransfer(sender);
  const deps = fakeDeps({ receiverCurrency: 'USD' });

  const result = await runTransfer(transfer.id, { deps });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure_code, 'asset_mismatch');
  assert.equal(deps.calls.incoming, 0);
  assert.equal(deps.calls.outgoing, 0);
});

test('an outgoing payment that never finishes stays pending, not failed', async () => {
  const sender = makeSender();
  const transfer = newTransfer(sender);
  const deps = fakeDeps({ outgoingStates: ['SENDING'] });

  const result = await runTransfer(transfer.id, { deps });

  assert.equal(result.status, 'pending');
  assert.equal(result.failure_code, 'leg_timeout');
});

test('an outgoing payment the network reports as failed fails the transfer', async () => {
  const sender = makeSender();
  const transfer = newTransfer(sender);
  const deps = fakeDeps({ outgoingStates: ['FAILED'] });

  const result = await runTransfer(transfer.id, { deps });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure_code, 'outgoing_failed');
});

test('a rejected outgoing request fails the transfer and a retry does not send again', async () => {
  const sender = makeSender();
  const transfer = newTransfer(sender);
  const deps = fakeDeps({ outgoingError: new AppError('openpayments_rejected', 422, 'rejected') });

  const first = await runTransfer(transfer.id, { deps });
  const second = await runTransfer(transfer.id, { deps });

  assert.equal(first.status, 'failed');
  assert.equal(second.status, 'failed');
  assert.equal(deps.calls.outgoing, 1);
});

test('a sender without a permission stays pending with the reason', async () => {
  const sender = makeSender({ withGrant: false });
  const transfer = newTransfer(sender);

  const result = await runTransfer(transfer.id, { deps: fakeDeps() });

  assert.equal(result.status, 'pending');
  assert.equal(result.failure_code, 'no_active_grant');
});

test('an unknown transfer is reported as not found', async () => {
  await assert.rejects(
    () => runTransfer(randomUUID(), { deps: fakeDeps() }),
    (err) => err.code === 'transfer_not_found',
  );
  assert.equal(getTransfer(randomUUID()), undefined);
});
