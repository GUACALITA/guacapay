// Group pools (prompt 26). Temporary database, fake Open Payments calls, no network. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const AUTH = 'https://auth.example.test';
const CUSTODY_ID = 'custody-pools-test';
const CUSTODY_ADDRESS = 'https://wallet.example.test/custody-pools';

const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-pools-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.PAYMENT_CURRENCIES = 'EUR';
process.env.BASE_URL = 'https://guacapay.test';
process.env.CUSTODY_WALLET_ID = CUSTODY_ID;
process.env.CUSTODY_WALLET_ADDRESS = CUSTODY_ADDRESS;

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { seal } = await import('../src/grants/seal.js');
const { createPool, joinPool, startPool, contribute, viewPool } = await import('../src/pools/service.js');
const { AppError } = await import('../src/errors.js');

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

function makeWallet(userId, id = randomUUID()) {
  getDb()
    .prepare(
      `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
       VALUES (?, ?, ?, 'EUR', 2, 'linked', ?)`,
    )
    .run(id, userId, id === CUSTODY_ID ? CUSTODY_ADDRESS : `${AUTH}/wallet-${id}`, new Date().toISOString());
  return id;
}

// The custody wallet: linked, with a permission, so it can pay out.
const operator = makeUser();
makeWallet(operator, CUSTODY_ID);
getDb()
  .prepare(
    `INSERT INTO grants (id, wallet_id, purpose, status, nonce_hash, access_token_enc, granted_at)
     VALUES (?, ?, 'link', 'granted', 'x', ?, ?)`,
  )
  .run(randomUUID(), CUSTODY_ID, seal('custody-token'), new Date().toISOString());

function tokenOf(link) {
  return new URL(link).searchParams.get('token');
}

// Consent is answered at once; the permission lasts 90 days.
function grantDeps() {
  return {
    readWallet: async (url) => ({ id: url, assetCode: 'EUR', assetScale: 2, authServer: AUTH, resourceServer: `${AUTH}/rs` }),
    startGrant: async () => ({ access_token: { value: `access-${randomUUID()}`, expires_in: 90 * 24 * 60 * 60 } }),
    continueGrant: async () => {
      throw new Error('not expected: consent is answered at once');
    },
  };
}

// Counts the calls to the fake network. Every outgoing payment completes.
function fakeNetwork() {
  const calls = { outgoing: 0 };
  const deps = {
    async readWallet(url) {
      return { id: url, assetCode: 'EUR', assetScale: 2, authServer: AUTH, resourceServer: `${AUTH}/rs` };
    },
    async requestGrant() {
      return 'token';
    },
    async createIncoming() {
      return { id: `incoming-${randomUUID()}` };
    },
    async createQuote() {
      return { id: `quote-${randomUUID()}` };
    },
    async createOutgoing() {
      calls.outgoing += 1;
      return { id: `outgoing-${calls.outgoing}` };
    },
    async getOutgoing() {
      return { state: 'COMPLETED' };
    },
    sleep: async () => {},
    now: () => Date.now(),
    pollTimeoutMs: 1000,
    pollIntervalMs: 1000,
  };
  return { calls, deps };
}

// A pool with the organizer and members who have all joined (consent granted).
async function poolWith({ kind, members, shareCents, goalCents, period }) {
  const organizer = makeUser('Marta');
  const organizerWallet = makeWallet(organizer);
  const body = { kind, share_cents: shareCents, currency: 'EUR', organizer_wallet_id: organizerWallet };
  if (kind === 'collection') body.goal_cents = goalCents;
  else body.period = period;
  const { pool, link } = createPool({ organizerId: organizer, body });

  const people = [];
  for (let i = 0; i < members; i += 1) {
    const user = makeUser(`Member${i + 1}`);
    const wallet = makeWallet(user);
    await joinPool({ token: tokenOf(link), memberId: user, walletId: wallet, grantDeps: grantDeps() });
    people.push({ user, wallet });
  }
  startPool({ organizerId: organizer, poolId: pool.id });
  return { poolId: pool.id, organizer, organizerWallet, people };
}

function payoutsOf(poolId) {
  return getDb().prepare('SELECT period, wallet_id, amount_cents, status FROM pool_payouts WHERE pool_id = ? ORDER BY period').all(poolId);
}

function custodySum(poolId, direction) {
  return getDb()
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM custody_entries WHERE pool_id = ? AND direction = ?')
    .get(poolId, direction).total;
}

test('a collection reaches its goal and pays the organizer exactly the total collected', async () => {
  const pool = await poolWith({ kind: 'collection', members: 3, shareCents: 1000, goalCents: 3000 });
  const net = fakeNetwork();

  await contribute({ memberId: pool.people[0].user, poolId: pool.poolId, deps: net.deps });
  await contribute({ memberId: pool.people[1].user, poolId: pool.poolId, deps: net.deps });
  assert.deepEqual(payoutsOf(pool.poolId), [], 'nothing is paid before the goal');

  await contribute({ memberId: pool.people[2].user, poolId: pool.poolId, deps: net.deps });

  const payouts = payoutsOf(pool.poolId);
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].amount_cents, 3000, 'the organizer receives exactly the total');
  assert.equal(payouts[0].wallet_id, pool.organizerWallet);
  assert.equal(payouts[0].status, 'completed');
  assert.equal(getDb().prepare('SELECT status FROM pools WHERE id = ?').get(pool.poolId).status, 'completed');
  assert.equal(custodySum(pool.poolId, 'in'), 3000);
  assert.equal(custodySum(pool.poolId, 'out'), 3000, 'the payout total equals the contributions recorded');
  assert.equal(net.calls.outgoing, 4, 'three contributions and one payout');
});

test('a tanda does not pay out until every member has paid for the period', async () => {
  const pool = await poolWith({ kind: 'tanda', members: 3, shareCents: 500, period: 'P1M' });
  const net = fakeNetwork();

  await contribute({ memberId: pool.people[0].user, poolId: pool.poolId, deps: net.deps });
  await contribute({ memberId: pool.people[1].user, poolId: pool.poolId, deps: net.deps });
  assert.equal(payoutsOf(pool.poolId).length, 0, 'two of three paid: no payout');
  assert.equal(getDb().prepare('SELECT current_period FROM pools WHERE id = ?').get(pool.poolId).current_period, 1);

  // The overdue period shows the member who has not paid as late.
  getDb().prepare('UPDATE pools SET period_due_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), pool.poolId);
  const view = viewPool({ userId: pool.organizer, poolId: pool.poolId });
  assert.deepEqual(
    view.members.map((m) => m.late),
    [false, false, true],
  );

  await contribute({ memberId: pool.people[2].user, poolId: pool.poolId, deps: net.deps });

  const payouts = payoutsOf(pool.poolId);
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].period, 1);
  assert.equal(payouts[0].amount_cents, 1500, 'the whole period pool');
  assert.equal(payouts[0].wallet_id, pool.people[0].wallet, 'paid to the member at position 1');
  assert.equal(getDb().prepare('SELECT current_period FROM pools WHERE id = ?').get(pool.poolId).current_period, 2);
});

test('a member cannot contribute twice for the same period', async () => {
  const pool = await poolWith({ kind: 'tanda', members: 2, shareCents: 700, period: 'P1W' });
  const net = fakeNetwork();

  await contribute({ memberId: pool.people[0].user, poolId: pool.poolId, deps: net.deps });

  await assert.rejects(
    () => contribute({ memberId: pool.people[0].user, poolId: pool.poolId, deps: net.deps }),
    (err) => err instanceof AppError && err.code === 'already_contributed',
  );
  const count = getDb()
    .prepare('SELECT COUNT(*) AS n FROM pool_contributions WHERE pool_id = ? AND user_id = ? AND period = 1')
    .get(pool.poolId, pool.people[0].user).n;
  assert.equal(count, 1);
  assert.equal(net.calls.outgoing, 1, 'the second attempt sent nothing');
});
