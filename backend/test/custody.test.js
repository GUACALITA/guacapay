// Custody ledger (prompt 23). Temporary database, no network: the wallet reads are fakes. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const CUSTODY_ID = 'custody-ledger-test';
const CUSTODY_ADDRESS = 'https://wallet.example.test/custody-ledger';
const GATEWAY_TOKEN = 'gateway-token-for-tests-0123456789abcdef';

const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-custody-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = GATEWAY_TOKEN;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.PAYMENT_CURRENCIES = 'EUR,USD';
process.env.CUSTODY_WALLET_ID = CUSTODY_ID;
process.env.CUSTODY_WALLET_ADDRESS = CUSTODY_ADDRESS;

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { createPayment } = await import('../src/payments/service.js');
const { recordIn, recordOut, custodyBalances, assertCustodyHolds, reconcile, checkCustodyWallet } = await import(
  '../src/custody/service.js'
);
const { AppError } = await import('../src/errors.js');
const { seal } = await import('../src/grants/seal.js');

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

// The custody wallet: linked, with a granted permission. Created once for the whole file.
const operator = makeUser();
getDb()
  .prepare(
    `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
     VALUES (?, ?, ?, 'EUR', 2, 'linked', ?)`,
  )
  .run(CUSTODY_ID, operator, CUSTODY_ADDRESS, new Date().toISOString());
getDb()
  .prepare(
    `INSERT INTO grants (id, wallet_id, purpose, status, nonce_hash, access_token_enc, granted_at)
     VALUES (?, ?, 'link', 'granted', 'x', ?, ?)`,
  )
  .run(randomUUID(), CUSTODY_ID, seal('custody-access-token'), new Date().toISOString());

function makePayment(amountCents = 2500, currency = 'EUR') {
  const { payment } = createPayment({
    senderId: makeUser(),
    body: { recipient_email: `recipient-${randomUUID()}@example.com`, amount_cents: amountCents, currency },
  });
  return payment;
}

// A transfer row to point entries at, as the engine would have written it.
function makeTransfer(paymentId, direction, amountCents, currency) {
  const db = getDb();
  const walletId = randomUUID();
  db.prepare(
    `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
     VALUES (?, ?, ?, ?, 2, 'linked', ?)`,
  ).run(walletId, operator, `https://wallet.example.test/${walletId}`, currency, new Date().toISOString());
  const id = randomUUID();
  db.prepare(
    `INSERT INTO transfers (id, payment_id, from_wallet_id, to_wallet_url, amount_cents, currency, status, direction)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
  ).run(id, paymentId, walletId, CUSTODY_ADDRESS, amountCents, currency, direction);
  return id;
}

function balanceFor(currency) {
  return custodyBalances().find((row) => row.currency === currency)?.balance_cents ?? 0;
}

test('money in and then out leaves the payment at zero in custody', () => {
  const payment = makePayment(2500, 'EUR');
  const db = getDb();
  recordIn(db, { paymentId: payment.id, transferId: makeTransfer(payment.id, 'in', 2500, 'EUR'), amountCents: 2500, currency: 'EUR' });
  recordOut(db, { paymentId: payment.id, transferId: makeTransfer(payment.id, 'out', 2500, 'EUR'), amountCents: 2500, currency: 'EUR' });

  const held = db
    .prepare("SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount_cents ELSE -amount_cents END), 0) AS held FROM custody_entries WHERE payment_id = ?")
    .get(payment.id).held;
  assert.equal(held, 0);
});

test('an out entry larger than the in entries for its payment is refused by the service', () => {
  const payment = makePayment(2500, 'EUR');
  const db = getDb();
  recordIn(db, { paymentId: payment.id, transferId: makeTransfer(payment.id, 'in', 2500, 'EUR'), amountCents: 2500, currency: 'EUR' });

  assert.throws(
    () => recordOut(db, { paymentId: payment.id, transferId: makeTransfer(payment.id, 'out', 3000, 'EUR'), amountCents: 3000, currency: 'EUR' }),
    (err) => err instanceof AppError && err.code === 'custody_out_exceeds_in',
  );
});

test('the database itself refuses an out entry larger than the in entries, even without the service', () => {
  const payment = makePayment(1000, 'EUR');
  const db = getDb();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO custody_entries (id, payment_id, amount_cents, currency, direction, transfer_id)
           VALUES (?, ?, 1000, 'EUR', 'out', NULL)`,
        )
        .run(randomUUID(), payment.id),
    /custody_out_exceeds_in/,
  );
});

test('a payout the ledger cannot cover is refused before any money moves', () => {
  const payment = makePayment(4000, 'EUR');
  assert.throws(
    () => assertCustodyHolds(payment.id),
    (err) => err.code === 'custody_out_exceeds_in',
  );
});

test('the custody balance is never negative', () => {
  const payment = makePayment(700, 'USD');
  const db = getDb();
  recordIn(db, { paymentId: payment.id, transferId: makeTransfer(payment.id, 'in', 700, 'USD'), amountCents: 700, currency: 'USD' });
  recordOut(db, { paymentId: payment.id, transferId: makeTransfer(payment.id, 'out', 700, 'USD'), amountCents: 700, currency: 'USD' });
  assert.ok(balanceFor('USD') >= 0);
});

test('the operator endpoint needs the gateway token; a user sign-in is refused', async () => {
  const app = createApp({ gatewayToken: GATEWAY_TOKEN });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const userToken = issueToken(makeUser());
  try {
    const asUser = await fetch(`${base}/api/custody`, { headers: { Authorization: `Bearer ${userToken}` } });
    assert.equal(asUser.status, 401);

    const asOperator = await fetch(`${base}/api/custody`, { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } });
    assert.equal(asOperator.status, 200);
    const body = await asOperator.json();
    assert.ok(Array.isArray(body.balances));
    assert.equal(body.reconcile.comparison, 'not_available_from_api');
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /access_token|continue_token|private|key_id|OPEN_PAYMENTS/i, 'no private material in the response');
  } finally {
    server.close();
  }
});

test('reconcile says clearly when the API cannot show a balance, and compares when it can', async () => {
  const unavailable = await reconcile();
  assert.equal(unavailable.comparison, 'not_available_from_api');

  const matching = await reconcile({
    readBalance: async () => ({ available: true, currency: 'USD', balanceCents: balanceFor('USD') }),
  });
  assert.equal(matching.comparison, 'match');

  const off = await reconcile({
    readBalance: async () => ({ available: true, currency: 'USD', balanceCents: balanceFor('USD') + 1 }),
  });
  assert.equal(off.comparison, 'mismatch');
});

test('the start-up check reports a wallet that cannot be read, without stopping', async () => {
  const ok = await checkCustodyWallet({ readWallet: async () => ({}) });
  assert.deepEqual(ok, { ok: true });

  const unreachable = await checkCustodyWallet({
    readWallet: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.reason, 'wallet_unreachable');
});
