// Group pools: a collection (everyone pays a share toward one goal) or a tanda (a rotating circle).
// Members pay into the custody wallet; payouts go from custody to one wallet. The payout amount is always the sum of the
// contributions recorded for that pool and period, and a pool with a payout in progress accepts no contributions.
import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { hashSecret } from '../hash.js';
import { recordIn, recordOut } from '../custody/service.js';
import { requestConsent, revokeGrant } from '../grants/service.js';
import { addPeriod } from '../subscriptions/service.js';
import { createTransfer, TRANSFER_STATUS } from '../transfers/engine.js';
import { runPending } from '../transfers/payments.js';

export const POOL_KINDS = Object.freeze(['collection', 'tanda']);
export const POOL_STATUS = Object.freeze({
  FORMING: 'forming',
  ACTIVE: 'active',
  CLOSING: 'closing',
  COMPLETED: 'completed',
});
const POOL_PERIODS = Object.freeze(['P1W', 'P1M']);
const MIN_TANDA_MEMBERS = 2;
const RUN_BATCH_SIZE = 50;
const NAME_MAX_LENGTH = 80;

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const newToken = () => randomBytes(32).toString('base64url');

export function poolLink(token) {
  return `${config.baseUrl}/pool.html?token=${encodeURIComponent(token)}`;
}

function assertCustodyConfigured() {
  if (!config.custody.walletId || !config.custody.address) {
    throw new AppError('transfer_not_configured', 503, 'Transfers are not available yet.');
  }
}

function parsePool(body) {
  const { minAmountCents, maxAmountCents, currencies } = config.payments;
  const amount = (value, name) => {
    if (!Number.isSafeInteger(value) || value < minAmountCents || value > maxAmountCents) {
      throw new AppError('invalid_amount', 400, `${name} must be a whole number of cents between ${minAmountCents} and ${maxAmountCents}.`);
    }
    return value;
  };

  if (!POOL_KINDS.includes(body.kind)) {
    throw new AppError('invalid_kind', 400, 'Kind must be collection or tanda.');
  }
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  if (!currencies.includes(currency)) {
    throw new AppError('invalid_currency', 400, 'Currency is not supported.');
  }
  const shareCents = amount(body.share_cents, 'Share');

  if (body.kind === 'collection') {
    const goalCents = amount(body.goal_cents, 'Goal');
    if (shareCents > goalCents) {
      throw new AppError('invalid_share', 400, 'The share cannot be more than the goal.');
    }
    let closesAt = null;
    if (body.closes_at !== undefined && body.closes_at !== null) {
      if (typeof body.closes_at !== 'string' || !(Date.parse(body.closes_at) > Date.now())) {
        throw new AppError('invalid_closing_date', 400, 'The closing date must be a future date.');
      }
      closesAt = new Date(body.closes_at).toISOString();
    }
    return { kind: 'collection', shareCents, currency, goalCents, closesAt, period: null };
  }

  if (!POOL_PERIODS.includes(body.period)) {
    throw new AppError('invalid_period', 400, 'A tanda period must be P1W (weekly) or P1M (monthly).');
  }
  return { kind: 'tanda', shareCents, currency, goalCents: null, closesAt: null, period: body.period };
}

// What any signed-in member or the organizer sees. No wallet URLs, emails or join tokens.
function poolView(row) {
  return {
    id: row.id,
    kind: row.kind,
    share_cents: row.share_cents,
    goal_cents: row.goal_cents,
    currency: row.currency,
    period: row.period,
    closes_at: row.closes_at,
    status: row.status,
    current_period: row.current_period,
    period_due_at: row.period_due_at,
    created_at: row.created_at,
  };
}

function getPool(db, id) {
  return db.prepare('SELECT * FROM pools WHERE id = ?').get(id);
}

function findByToken(token, db) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new AppError('pool_not_found', 404, 'This pool link is not valid.');
  }
  const row = db
    .prepare(
      `SELECT p.*, u.first_name AS organizer_first_name,
              (SELECT COUNT(*) FROM pool_members m WHERE m.pool_id = p.id) AS member_count
       FROM pools p JOIN users u ON u.id = p.organizer_user_id WHERE p.join_token_hash = ?`,
    )
    .get(hashSecret(token));
  if (!row) {
    throw new AppError('pool_not_found', 404, 'This pool link is not valid.');
  }
  return row;
}

// The organizer creates a pool. The join link is returned once; only its hash is stored.
export function createPool({ organizerId, body, db = getDb() }) {
  const data = body ?? {};
  const input = parsePool(data);

  const wallet = typeof data.organizer_wallet_id === 'string'
    ? db.prepare("SELECT id FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(data.organizer_wallet_id, organizerId)
    : undefined;
  if (!wallet) {
    throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets to receive the payout.');
  }

  const id = randomUUID();
  const token = newToken();
  const now = iso();
  db.prepare(
    `INSERT INTO pools (id, organizer_user_id, organizer_wallet_id, kind, goal_cents, closes_at, period, share_cents, currency,
       status, current_period, join_token_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    organizerId,
    wallet.id,
    input.kind,
    input.goalCents,
    input.closesAt,
    input.period,
    input.shareCents,
    input.currency,
    POOL_STATUS.FORMING,
    hashSecret(token),
    now,
    now,
  );

  return { pool: poolView(getPool(db, id)), link: poolLink(token) };
}

// What anyone with the link sees: the terms and how many members have joined.
export function getPublicPool(token, { db = getDb() } = {}) {
  const row = findByToken(token, db);
  return {
    kind: row.kind,
    share_cents: row.share_cents,
    goal_cents: row.goal_cents,
    currency: row.currency,
    period: row.period,
    closes_at: row.closes_at,
    status: row.status,
    member_count: row.member_count,
    organizer_first_name: row.organizer_first_name ?? null,
  };
}

// A member joins from one of their linked wallets. Consent asks for a limit equal to one share (per period, for a tanda).
// Joining is open only while the pool is forming. Members are numbered in the order they join.
export async function joinPool({ token, memberId, walletId, db = getDb(), grantDeps, now = Date.now() }) {
  const pool = findByToken(token, db);
  if (pool.organizer_user_id === memberId) {
    throw new AppError('own_pool', 409, 'You cannot join your own pool.');
  }
  if (pool.status !== POOL_STATUS.FORMING) {
    throw new AppError('pool_not_forming', 409, 'This pool has already started.');
  }
  if (db.prepare('SELECT 1 FROM pool_members WHERE pool_id = ? AND user_id = ?').get(pool.id, memberId)) {
    throw new AppError('already_member', 409, 'You have already joined this pool.');
  }

  const wallet = typeof walletId === 'string'
    ? db.prepare("SELECT id FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(walletId, memberId)
    : undefined;
  if (!wallet) {
    throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets to pay from.');
  }

  const consent = await requestConsent({
    userId: memberId,
    walletId: wallet.id,
    purpose: pool.kind === 'tanda' ? 'recurring' : 'link',
    limitCents: pool.share_cents,
    interval: pool.kind === 'tanda' ? `R/${iso(now)}/${pool.period}` : undefined,
    db,
    deps: grantDeps,
  });

  try {
    db.transaction(() => {
      if (getPool(db, pool.id).status !== POOL_STATUS.FORMING) {
        throw new AppError('pool_not_forming', 409, 'This pool has already started.');
      }
      const position = db.prepare('SELECT COUNT(*) AS n FROM pool_members WHERE pool_id = ?').get(pool.id).n + 1;
      db.prepare('INSERT INTO pool_members (pool_id, user_id, wallet_id, grant_id, position, joined_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        pool.id,
        memberId,
        wallet.id,
        consent.id,
        position,
        iso(now),
      );
    })();
  } catch (err) {
    revokeGrant(memberId, consent.id, { db });
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new AppError('already_member', 409, 'You have already joined this pool.');
    }
    throw err;
  }

  return { status: 'joined', consent: consent.status, approvalUrl: consent.approvalUrl };
}

// The organizer starts the pool once every member has approved their share. Tanda members are paid in join order.
export function startPool({ organizerId, poolId, db = getDb(), now = Date.now() }) {
  const pool = db.prepare('SELECT * FROM pools WHERE id = ? AND organizer_user_id = ?').get(poolId, organizerId);
  if (!pool) {
    throw new AppError('pool_not_found', 404, 'Pool not found.');
  }
  if (pool.status !== POOL_STATUS.FORMING) {
    throw new AppError('pool_not_forming', 409, 'This pool has already started.');
  }

  const members = db
    .prepare(
      `SELECT m.user_id, m.position, g.status AS grant_status FROM pool_members m
       JOIN grants g ON g.id = m.grant_id WHERE m.pool_id = ? ORDER BY m.position`,
    )
    .all(poolId);
  const minimum = pool.kind === 'tanda' ? MIN_TANDA_MEMBERS : 1;
  if (members.length < minimum) {
    throw new AppError('not_enough_members', 409, `This pool needs at least ${minimum} member(s) to start.`);
  }
  if (members.some((member) => member.grant_status !== 'granted')) {
    throw new AppError('members_not_approved', 409, 'Every member must approve their share before the pool starts.');
  }

  const dueAt = pool.kind === 'tanda' ? addPeriod(iso(now), pool.period) : pool.closes_at;
  db.prepare(
    `UPDATE pools SET status = ?, current_period = 1, period_due_at = ?, order_json = ?, updated_at = ?
     WHERE id = ? AND status = ?`,
  ).run(POOL_STATUS.ACTIVE, dueAt, JSON.stringify(members.map((m) => m.user_id)), iso(now), poolId, POOL_STATUS.FORMING);
  return poolView(getPool(db, poolId));
}

// The contributions recorded for a period. Only completed ones count toward a payout.
function completedTotal(db, poolId, period) {
  const row = period === undefined
    ? db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM pool_contributions WHERE pool_id = ? AND status = 'completed'").get(poolId)
    : db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM pool_contributions WHERE pool_id = ? AND period = ? AND status = 'completed'").get(poolId, period);
  return row.total;
}

function completedCount(db, poolId, period) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM pool_contributions WHERE pool_id = ? AND period = ? AND status = 'completed'")
    .get(poolId, period).n;
}

// Starts the payout for a period: the pool moves to closing, so no contribution can change the amount meanwhile.
// The amount is recomputed from the recorded contributions each time, so a retry never pays a stale total.
function startPayout(pool, period, walletId, db) {
  assertCustodyConfigured();
  const amount = pool.kind === 'collection' ? completedTotal(db, pool.id) : completedTotal(db, pool.id, period);
  if (amount <= 0) return null;

  const wallet = db.prepare('SELECT wallet_url FROM wallets WHERE id = ?').get(walletId);
  return db.transaction(() => {
    const locked = db
      .prepare('UPDATE pools SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(POOL_STATUS.CLOSING, iso(), pool.id, POOL_STATUS.ACTIVE).changes;
    if (locked !== 1) return null;

    const transfer = createTransfer({
      fromWalletId: config.custody.walletId,
      toWalletUrl: wallet.wallet_url,
      amountCents: amount,
      currency: pool.currency,
      direction: 'out',
      db,
    });
    const existing = db.prepare('SELECT id, status FROM pool_payouts WHERE pool_id = ? AND period = ?').get(pool.id, period);
    if (existing) {
      db.prepare("UPDATE pool_payouts SET wallet_id = ?, amount_cents = ?, transfer_id = ?, status = 'pending', updated_at = ? WHERE id = ?")
        .run(walletId, amount, transfer.id, iso(), existing.id);
      return existing.id;
    }
    const payoutId = randomUUID();
    db.prepare(
      `INSERT INTO pool_payouts (id, pool_id, period, wallet_id, amount_cents, currency, transfer_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(payoutId, pool.id, period, walletId, amount, pool.currency, transfer.id, iso(), iso());
    return payoutId;
  })();
}

// Moves a payout on from its transfer. Completed: the period advances (tanda) or the pool completes (collection).
// Failed: the pool is active again and the payout is retried later.
async function settlePayout(payoutId, deps, db) {
  const payout = db.prepare('SELECT * FROM pool_payouts WHERE id = ?').get(payoutId);
  const transfer = await runPending(payout.transfer_id, { db, deps });
  const pool = getPool(db, payout.pool_id);
  const members = db.prepare('SELECT COUNT(*) AS n FROM pool_members WHERE pool_id = ?').get(pool.id).n;

  return db.transaction(() => {
    if (transfer.status === TRANSFER_STATUS.COMPLETED) {
      db.prepare("UPDATE pool_payouts SET status = 'completed', updated_at = ? WHERE id = ?").run(iso(), payoutId);
      recordOut(db, { poolId: pool.id, transferId: transfer.id, amountCents: payout.amount_cents, currency: payout.currency });
      if (pool.kind === 'collection' || pool.current_period + 1 > members) {
        db.prepare("UPDATE pools SET status = ?, updated_at = ? WHERE id = ?").run(POOL_STATUS.COMPLETED, iso(), pool.id);
      } else {
        db.prepare(
          "UPDATE pools SET status = 'active', current_period = current_period + 1, period_due_at = ?, updated_at = ? WHERE id = ?",
        ).run(addPeriod(iso(), pool.period), iso(), pool.id);
      }
      return 'completed';
    }
    if (transfer.status === TRANSFER_STATUS.FAILED) {
      db.prepare("UPDATE pool_payouts SET status = 'failed', updated_at = ? WHERE id = ?").run(iso(), payoutId);
      db.prepare("UPDATE pools SET status = 'active', updated_at = ? WHERE id = ?").run(iso(), pool.id);
      return 'failed';
    }
    return 'pending';
  })();
}

// Pays out a period once it is complete: the whole pool (collection, at the goal) or the period's members (tanda).
async function maybePayOut(pool, { db, deps }) {
  if (pool.status !== POOL_STATUS.ACTIVE) return;
  if (pool.kind === 'collection') {
    if (completedTotal(db, pool.id) < pool.goal_cents) return;
    const payoutId = startPayout(pool, 1, pool.organizer_wallet_id, db);
    if (payoutId) await settlePayout(payoutId, deps, db);
    return;
  }

  const members = db.prepare('SELECT COUNT(*) AS n FROM pool_members WHERE pool_id = ?').get(pool.id).n;
  if (completedCount(db, pool.id, pool.current_period) !== members) return;
  const recipient = db
    .prepare('SELECT wallet_id FROM pool_members WHERE pool_id = ? AND position = ?')
    .get(pool.id, pool.current_period);
  const payoutId = startPayout(pool, pool.current_period, recipient.wallet_id, db);
  if (payoutId) await settlePayout(payoutId, deps, db);
}

// A member pays their share for the current period. A member can pay once per period.
export async function contribute({ memberId, poolId, db = getDb(), deps }) {
  const member = db.prepare('SELECT * FROM pool_members WHERE pool_id = ? AND user_id = ?').get(poolId, memberId);
  if (!member) {
    throw new AppError('pool_not_found', 404, 'Pool not found.');
  }
  const pool = getPool(db, poolId);
  if (pool.status !== POOL_STATUS.ACTIVE) {
    throw new AppError('pool_not_collecting', 409, 'This pool is not collecting contributions now.');
  }

  const period = pool.current_period;
  let contribution = db.prepare('SELECT * FROM pool_contributions WHERE pool_id = ? AND user_id = ? AND period = ?').get(poolId, memberId, period);
  if (contribution && contribution.status === 'completed') {
    throw new AppError('already_contributed', 409, 'You have already paid for this period.');
  }

  let transfer;
  if (contribution && contribution.status === 'pending') {
    transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(contribution.transfer_id);
  } else {
    assertCustodyConfigured();
    transfer = db.transaction(() => {
      const created = createTransfer({
        grantId: member.grant_id,
        fromWalletId: member.wallet_id,
        toWalletUrl: config.custody.address,
        amountCents: pool.share_cents,
        currency: pool.currency,
        direction: 'in',
        db,
      });
      if (contribution) {
        // A failed attempt: the same contribution row takes the new transfer.
        db.prepare("UPDATE pool_contributions SET transfer_id = ?, status = 'pending', updated_at = ? WHERE id = ? AND status = 'failed'")
          .run(created.id, iso(), contribution.id);
      } else {
        try {
          db.prepare(
            `INSERT INTO pool_contributions (id, pool_id, user_id, period, amount_cents, currency, transfer_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          ).run(randomUUID(), poolId, memberId, period, pool.share_cents, pool.currency, created.id, iso(), iso());
        } catch (err) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            throw new AppError('already_contributed', 409, 'You have already paid for this period.');
          }
          throw err;
        }
      }
      return created;
    })();
    contribution = db.prepare('SELECT * FROM pool_contributions WHERE pool_id = ? AND user_id = ? AND period = ?').get(poolId, memberId, period);
  }

  const result = await runPending(transfer.id, { db, deps });
  db.transaction(() => {
    if (result.status === TRANSFER_STATUS.COMPLETED) {
      db.prepare("UPDATE pool_contributions SET status = 'completed', updated_at = ? WHERE id = ?").run(iso(), contribution.id);
      recordIn(db, { poolId, transferId: result.id, amountCents: pool.share_cents, currency: pool.currency });
    } else if (result.status === TRANSFER_STATUS.FAILED) {
      db.prepare("UPDATE pool_contributions SET status = 'failed', updated_at = ? WHERE id = ?").run(iso(), contribution.id);
    }
  })();

  if (result.status === TRANSFER_STATUS.COMPLETED) {
    await maybePayOut(getPool(db, poolId), { db, deps });
  }
  return { status: db.prepare('SELECT status FROM pool_contributions WHERE id = ?').get(contribution.id).status, period };
}

// What a member sees about a pool: its state, the current period's contributions, and who is late.
// A member is late when they have not paid for the current period and its due date has passed.
export function viewPool({ userId, poolId, db = getDb(), now = Date.now() }) {
  const pool = getPool(db, poolId);
  const isOrganizer = pool && pool.organizer_user_id === userId;
  const isMember = db.prepare('SELECT 1 FROM pool_members WHERE pool_id = ? AND user_id = ?').get(poolId, userId);
  if (!pool || (!isOrganizer && !isMember)) {
    throw new AppError('pool_not_found', 404, 'Pool not found.');
  }

  const dueAt = pool.period_due_at ? Date.parse(pool.period_due_at) : null;
  const overdue = pool.status === POOL_STATUS.ACTIVE && dueAt !== null && dueAt <= now;
  const members = db
    .prepare(
      `SELECT m.position, u.first_name,
              (SELECT c.status FROM pool_contributions c WHERE c.pool_id = m.pool_id AND c.user_id = m.user_id AND c.period = ?) AS contribution
       FROM pool_members m JOIN users u ON u.id = m.user_id WHERE m.pool_id = ? ORDER BY m.position`,
    )
    .all(pool.current_period, poolId)
    .map((m) => ({
      position: m.position,
      first_name: m.first_name ?? null,
      paid_current_period: m.contribution === 'completed',
      late: overdue && m.contribution !== 'completed',
    }));

  return { pool: poolView(pool), members, total_collected_cents: completedTotal(db, poolId) };
}

// Lists pools the user organizes or belongs to.
export function listPools(userId, { db = getDb() } = {}) {
  return db
    .prepare(
      `SELECT * FROM pools WHERE organizer_user_id = ?
         OR id IN (SELECT pool_id FROM pool_members WHERE user_id = ?)
       ORDER BY created_at DESC, rowid DESC LIMIT 100`,
    )
    .all(userId, userId)
    .map(poolView);
}

// Hourly: closes collections whose date has passed, retries failed payouts, and finishes payouts left pending by a restart.
export async function runDuePools({ db = getDb(), deps, now = Date.now() } = {}) {
  const outcome = { closed: 0, retried: 0, resumed: 0 };

  const due = db
    .prepare("SELECT * FROM pools WHERE kind = 'collection' AND status = ? AND closes_at IS NOT NULL AND closes_at <= ? LIMIT ?")
    .all(POOL_STATUS.ACTIVE, iso(now), RUN_BATCH_SIZE);
  for (const pool of due) {
    if (completedTotal(db, pool.id) > 0) {
      const payoutId = startPayout(pool, 1, pool.organizer_wallet_id, db);
      if (payoutId) await settlePayout(payoutId, deps, db);
    } else {
      db.prepare("UPDATE pools SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
        .run(POOL_STATUS.COMPLETED, iso(now), pool.id, POOL_STATUS.ACTIVE);
    }
    outcome.closed += 1;
  }

  const failed = db
    .prepare(
      `SELECT po.id, po.pool_id, po.wallet_id FROM pool_payouts po JOIN pools p ON p.id = po.pool_id
       WHERE po.status = 'failed' AND p.status = ? AND po.period = p.current_period LIMIT ?`,
    )
    .all(POOL_STATUS.ACTIVE, RUN_BATCH_SIZE);
  for (const row of failed) {
    const pool = getPool(db, row.pool_id);
    const payoutId = startPayout(pool, pool.current_period, row.wallet_id, db);
    if (payoutId) {
      await settlePayout(payoutId, deps, db);
      outcome.retried += 1;
    }
  }

  const pending = db
    .prepare("SELECT id FROM pool_payouts WHERE status = 'pending' LIMIT ?")
    .all(RUN_BATCH_SIZE);
  for (const row of pending) {
    await settlePayout(row.id, deps, db);
    outcome.resumed += 1;
  }

  return outcome;
}
