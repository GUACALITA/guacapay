// Subscriptions (prompt 25). Temporary database, fake Open Payments calls, no network. NOT RUN yet, at the user's request.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const AUTH = 'https://auth.example.test';
const DAY_MS = 24 * 60 * 60 * 1000;

const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-subscriptions-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.GRANT_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.PAYMENT_CURRENCIES = 'EUR';
process.env.BASE_URL = 'https://guacapay.test';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createOffer, acceptOffer, runDueCharges, cancelSubscription, addPeriod } = await import(
  '../src/subscriptions/service.js'
);
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

function makeWallet(userId) {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
       VALUES (?, ?, ?, 'EUR', 2, 'linked', ?)`,
    )
    .run(id, userId, `${AUTH}/wallet-${id}`, new Date().toISOString());
  return id;
}

function tokenOf(link) {
  return new URL(link).searchParams.get('token');
}

// Consent is answered at once (no approval screen), and the permission lasts 90 days.
// startArgs records the access asked for, so tests can check the limit and interval.
function grantDeps() {
  const startArgs = [];
  return {
    startArgs,
    readWallet: async (url) => ({ id: url, assetCode: 'EUR', assetScale: 2, authServer: AUTH, resourceServer: `${AUTH}/rs` }),
    startGrant: async ({ access }) => {
      startArgs.push(access);
      return { access_token: { value: `access-${randomUUID()}`, expires_in: 90 * 24 * 60 * 60 } };
    },
    continueGrant: async () => {
      throw new Error('not expected: consent is answered at once in these tests');
    },
  };
}

// Records calls to the fake network. Outgoing payments are numbered in creation order; outgoingPlan gives each state.
function fakeNetwork({ outgoingPlan = [] } = {}) {
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

// A payee offers 12.00 EUR monthly; a payer accepts it. Returns the subscription and the consent deps used.
async function activeSubscription() {
  const payee = makeUser('Luis');
  const payeeWallet = makeWallet(payee);
  const { subscription, link } = createOffer({
    payeeId: payee,
    body: { payee_wallet_id: payeeWallet, amount_cents: 1200, currency: 'EUR', interval: 'P1M' },
  });

  const payer = makeUser();
  const payerWallet = makeWallet(payer);
  const consent = grantDeps();
  const accepted = await acceptOffer({ token: tokenOf(link), payerId: payer, walletId: payerWallet, grantDeps: consent });
  assert.equal(accepted.status, 'active');
  return { subscriptionId: subscription.id, payer, consent };
}

function row(id) {
  return getDb().prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
}

function chargesOf(id) {
  return getDb().prepare('SELECT status FROM subscription_charges WHERE subscription_id = ? ORDER BY period_start').all(id);
}

test('the consent limit equals one period, and a subscription charges once per period, even when the job runs twice', async () => {
  const { subscriptionId, consent } = await activeSubscription();
  const access = consent.startArgs[0][0];
  assert.equal(access.limits.debitAmount.value, '1200', 'the limit is one period');
  assert.match(access.limits.interval, /^R\/.+\/P1M$/, 'the interval is monthly');

  const net = fakeNetwork();
  const start = Date.now();

  const first = await runDueCharges({ deps: net.deps, now: start });
  assert.equal(first.completed, 1);
  assert.equal(net.calls.outgoing, 1);
  assert.ok(Date.parse(row(subscriptionId).next_charge_at) > start + 27 * DAY_MS, 'the next period is about a month away');

  // The job runs again straight away: nothing is due, so nothing is charged.
  const second = await runDueCharges({ deps: net.deps, now: start });
  assert.equal(second.checked, 0);
  assert.equal(net.calls.outgoing, 1, 'no extra charge');
  assert.equal(chargesOf(subscriptionId).length, 1);

  // A month later, the next period is charged once.
  await runDueCharges({ deps: net.deps, now: start + 40 * DAY_MS });
  assert.equal(net.calls.outgoing, 2);
  assert.equal(chargesOf(subscriptionId).length, 2);
});

test('three failed charges in a row pause the subscription', async () => {
  const { subscriptionId } = await activeSubscription();
  const net = fakeNetwork({ outgoingPlan: ['FAILED', 'FAILED', 'FAILED'] });
  const now = Date.now();

  await runDueCharges({ deps: net.deps, now });
  assert.equal(row(subscriptionId).failure_count, 1);
  assert.equal(row(subscriptionId).status, 'active');

  await runDueCharges({ deps: net.deps, now });
  assert.equal(row(subscriptionId).failure_count, 2);

  await runDueCharges({ deps: net.deps, now });
  assert.equal(row(subscriptionId).status, 'paused');
  assert.equal(row(subscriptionId).failure_count, 3);

  // The same period was tried each time, so there is one charge row; a paused subscription is not charged again.
  assert.equal(chargesOf(subscriptionId).length, 1);
  const after3 = await runDueCharges({ deps: net.deps, now });
  assert.equal(after3.checked, 0);
  assert.equal(net.calls.outgoing, 3);
});

test('cancelling revokes the grant and stops charges', async () => {
  const { subscriptionId, payer, consent } = await activeSubscription();
  const grantId = row(subscriptionId).grant_id;
  const net = fakeNetwork();

  const cancelled = cancelSubscription({ userId: payer, subscriptionId });
  assert.equal(cancelled.status, 'cancelled');

  const grant = getDb().prepare('SELECT status, access_token_enc FROM grants WHERE id = ?').get(grantId);
  assert.equal(grant.status, 'revoked');
  assert.equal(grant.access_token_enc, null);

  const later = await runDueCharges({ deps: net.deps, now: Date.now() + 40 * DAY_MS });
  assert.equal(later.checked, 0);
  assert.equal(net.calls.outgoing, 0, 'no charge after cancelling');
  assert.ok(consent.startArgs.length >= 1);
});

test('a payee cannot accept their own offer, and an accepted offer cannot be taken again', async () => {
  const payee = makeUser();
  const payeeWallet = makeWallet(payee);
  const { link } = createOffer({
    payeeId: payee,
    body: { payee_wallet_id: payeeWallet, amount_cents: 500, currency: 'EUR', interval: 'P1W' },
  });
  await assert.rejects(
    () => acceptOffer({ token: tokenOf(link), payerId: payee, walletId: payeeWallet, grantDeps: grantDeps() }),
    (err) => err instanceof AppError && err.code === 'own_subscription',
  );

  const payer = makeUser();
  await acceptOffer({ token: tokenOf(link), payerId: payer, walletId: makeWallet(payer), grantDeps: grantDeps() });
  const other = makeUser();
  await assert.rejects(
    () => acceptOffer({ token: tokenOf(link), payerId: other, walletId: makeWallet(other), grantDeps: grantDeps() }),
    (err) => err.code === 'offer_not_available',
  );
});

test('the monthly step keeps the day, or uses the last day of a shorter month', () => {
  assert.equal(addPeriod('2026-01-15T10:00:00.000Z', 'P1M'), '2026-02-15T10:00:00.000Z');
  assert.equal(addPeriod('2026-01-31T10:00:00.000Z', 'P1M'), '2026-02-28T10:00:00.000Z');
  assert.equal(addPeriod('2026-02-28T10:00:00.000Z', 'P1W'), '2026-03-07T10:00:00.000Z');
});
