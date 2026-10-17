// Deposits and withdrawals (prompt 28). Temporary database, fake Open Payments calls, no network. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const AUTH = 'https://auth.example.test';
const CUSTODY_ID = 'custody-withdrawals-test';
const CUSTODY_ADDRESS = 'https://wallet.example.test/custody-withdrawals';

const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-withdrawals-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.PAYMENT_CURRENCIES = 'EUR';
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.BASE_URL = 'https://guacapay.test';
process.env.CUSTODY_WALLET_ID = CUSTODY_ID;
process.env.CUSTODY_WALLET_ADDRESS = CUSTODY_ADDRESS;

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { seal } = await import('../src/grants/seal.js');
const { createDeposit, createWithdrawal, resumeMovements, withdrawableCents } = await import('../src/balance/movements.js');
const { credit, balanceFor } = await import('../src/balance/service.js');
const { userBacking } = await import('../src/custody/service.js');
const { AppError } = await import('../src/errors.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeUser() {
  const id = randomUUID();
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@example.com`);
  return id;
}

// A wallet of the user. With withGrant, it has an active permission (needed to deposit from it).
function makeWallet(userId, { id = randomUUID(), status = 'linked', withGrant = true } = {}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
     VALUES (?, ?, ?, 'EUR', 2, ?, ?)`,
  ).run(id, userId, id === CUSTODY_ID ? CUSTODY_ADDRESS : `${AUTH}/wallet-${id}`, status, new Date().toISOString());
  if (withGrant) {
    db.prepare(
      `INSERT INTO grants (id, wallet_id, purpose, status, nonce_hash, access_token_enc, granted_at)
       VALUES (?, ?, 'link', 'granted', 'x', ?, ?)`,
    ).run(randomUUID(), id, seal('access-token'), new Date().toISOString());
  }
  return id;
}

// The custody wallet, so deposits and withdrawals have a counterpart.
makeWallet(makeUser(), { id: CUSTODY_ID });

// Counts calls to the fake network. outgoingPlan gives each outgoing payment's state by number; missing entries mean COMPLETED.
function fakeNetwork({ outgoingPlan = [], pollTimeoutMs = 1000 } = {}) {
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
    pollTimeoutMs,
    pollIntervalMs: 1000,
  };
  return { calls, deps };
}

// A user with a wallet to deposit from, and one of their own wallets to withdraw to. Funds the balance with a completed deposit.
async function fundedUser(amountCents) {
  const user = makeUser();
  const source = makeWallet(user);
  const destination = makeWallet(user);
  const deposit = await createDeposit({ userId: user, walletId: source, body: { amount_cents: amountCents, currency: 'EUR' }, deps: fakeNetwork().deps });
  assert.equal(deposit.status, 'completed');
  return { user, destination };
}

function balance(user) {
  return balanceFor(user, 'EUR');
}

function withdrawalRows(user) {
  return getDb().prepare('SELECT status FROM withdrawals WHERE user_id = ? ORDER BY created_at').all(user);
}

test('a successful withdrawal debits the balance once, after the transfer completes', async () => {
  const { user, destination } = await fundedUser(1000);
  assert.equal(balance(user), 1000);
  assert.equal(userBacking(user, 'EUR'), 1000);

  // The transfer is still running: nothing is debited yet.
  const slow = fakeNetwork({ outgoingPlan: ['SENDING'], pollTimeoutMs: 0 });
  const pending = await createWithdrawal({ userId: user, walletId: destination, body: { amount_cents: 400, currency: 'EUR' }, deps: slow.deps });
  assert.equal(pending.status, 'pending');
  assert.equal(balance(user), 1000, 'not debited while the transfer runs');
  assert.equal(userBacking(user, 'EUR'), 1000);

  // When it completes, the balance is debited exactly once.
  const later = fakeNetwork();
  const resumed = await resumeMovements({ deps: later.deps });
  assert.equal(resumed.settled, 1);
  assert.equal(balance(user), 600);
  assert.equal(userBacking(user, 'EUR'), 600);
  assert.equal(withdrawalRows(user)[0].status, 'completed');

  await resumeMovements({ deps: later.deps });
  assert.equal(balance(user), 600, 'a second resume does not debit again');
});

test('a failed transfer leaves the balance unchanged', async () => {
  const { user, destination } = await fundedUser(500);

  const failing = fakeNetwork({ outgoingPlan: ['FAILED'] });
  const result = await createWithdrawal({ userId: user, walletId: destination, body: { amount_cents: 200, currency: 'EUR' }, deps: failing.deps });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure_code, 'outgoing_failed');
  assert.equal(balance(user), 500);
  assert.equal(userBacking(user, 'EUR'), 500);
});

test('a withdrawal above the balance is refused before any transfer call', async () => {
  const { user, destination } = await fundedUser(300);
  const net = fakeNetwork();

  await assert.rejects(
    () => createWithdrawal({ userId: user, walletId: destination, body: { amount_cents: 500, currency: 'EUR' }, deps: net.deps }),
    (err) => err instanceof AppError && err.code === 'withdrawal_exceeds_balance',
  );
  assert.equal(net.calls.outgoing, 0, 'no transfer was attempted');
  assert.equal(net.calls.incoming, 0);
  assert.equal(withdrawalRows(user).length, 0, 'no withdrawal was recorded');
  assert.equal(balance(user), 300);
});

test('a withdrawal in progress reserves its amount, so a second one cannot overdraw', async () => {
  const { user, destination } = await fundedUser(1000);

  const slow = fakeNetwork({ outgoingPlan: ['SENDING'], pollTimeoutMs: 0 });
  await createWithdrawal({ userId: user, walletId: destination, body: { amount_cents: 800, currency: 'EUR' }, deps: slow.deps });
  assert.equal(withdrawableCents(user, 'EUR'), 200);

  await assert.rejects(
    () => createWithdrawal({ userId: user, walletId: destination, body: { amount_cents: 300, currency: 'EUR' }, deps: fakeNetwork().deps }),
    (err) => err.code === 'withdrawal_exceeds_balance',
  );
});

test('balance that is not backed in custody cannot be withdrawn', async () => {
  // A recharge credits the balance without any money entering custody.
  const user = makeUser();
  const destination = makeWallet(user);
  credit(user, 'EUR', 5000, 'recharge', null);

  assert.equal(balance(user), 5000);
  assert.equal(userBacking(user, 'EUR'), 0);
  assert.equal(withdrawableCents(user, 'EUR'), 0);

  const net = fakeNetwork();
  await assert.rejects(
    () => createWithdrawal({ userId: user, walletId: destination, body: { amount_cents: 100, currency: 'EUR' }, deps: net.deps }),
    (err) => err.code === 'withdrawal_exceeds_balance',
  );
  assert.equal(net.calls.outgoing, 0);
});

test('a revoked wallet cannot receive a withdrawal', async () => {
  const { user } = await fundedUser(700);
  const revoked = makeWallet(user, { status: 'revoked' });

  await assert.rejects(
    () => createWithdrawal({ userId: user, walletId: revoked, body: { amount_cents: 100, currency: 'EUR' }, deps: fakeNetwork().deps }),
    (err) => err.code === 'wallet_not_linked',
  );
});
