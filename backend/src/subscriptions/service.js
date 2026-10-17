// Subscriptions: a payee offers a recurring charge. The payer approves it once, with a limit equal to one period's amount.
// Each period the app makes one transfer, from the payer's wallet, under that subscription's permission.
// The amount and interval are fixed in the offer. Changing either means a new offer and a new approval.
import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { hashSecret } from '../hash.js';
import { requestConsent, revokeGrant } from '../grants/service.js';
import { createTransfer, TRANSFER_STATUS } from '../transfers/engine.js';
import { runPending } from '../transfers/payments.js';

export const SUBSCRIPTION_STATUS = Object.freeze({ PENDING: 'pending', ACTIVE: 'active', PAUSED: 'paused', CANCELLED: 'cancelled' });
export const INTERVALS = Object.freeze(['P1D', 'P1W', 'P1M']);
const MAX_FAILURES = 3;
const RUN_BATCH_SIZE = 50;

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const newToken = () => randomBytes(32).toString('base64url');

export function offerLink(token) {
  return `${config.baseUrl}/subscribe.html?token=${encodeURIComponent(token)}`;
}

// Adds one period. Monthly steps keep the day of the month, or the last day of a shorter month.
export function addPeriod(isoStart, interval) {
  const date = new Date(isoStart);
  if (interval === 'P1D') {
    date.setUTCDate(date.getUTCDate() + 1);
  } else if (interval === 'P1W') {
    date.setUTCDate(date.getUTCDate() + 7);
  } else if (interval === 'P1M') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else {
    throw new AppError('invalid_interval', 400, 'Interval must be daily, weekly or monthly.');
  }
  return date.toISOString();
}

function parseOffer(body) {
  const { minAmountCents, maxAmountCents, currencies } = config.payments;

  const amountCents = body.amount_cents;
  if (!Number.isSafeInteger(amountCents) || amountCents < minAmountCents || amountCents > maxAmountCents) {
    throw new AppError('invalid_amount', 400, `Amount must be a whole number of cents between ${minAmountCents} and ${maxAmountCents}.`);
  }

  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  if (!currencies.includes(currency)) {
    throw new AppError('invalid_currency', 400, 'Currency is not supported.');
  }

  if (!INTERVALS.includes(body.interval)) {
    throw new AppError('invalid_interval', 400, 'Interval must be P1D (daily), P1W (weekly) or P1M (monthly).');
  }

  return { amountCents, currency, interval: body.interval };
}

// What anyone with the offer link sees: no wallet IDs, emails or internal IDs.
function publicOffer(row) {
  return {
    amount_cents: row.amount_cents,
    currency: row.currency,
    interval: row.interval,
    status: row.status,
    payee_first_name: row.payee_first_name ?? null,
  };
}

// What the payer or payee sees about a subscription they are part of.
function memberView(row) {
  return {
    id: row.id,
    amount_cents: row.amount_cents,
    currency: row.currency,
    interval: row.interval,
    status: row.status,
    failure_count: row.failure_count,
    next_charge_at: row.next_charge_at,
    created_at: row.created_at,
  };
}

// The payee creates an offer. The link token is returned once; only its hash is stored.
export function createOffer({ payeeId, body, db = getDb() }) {
  const data = body ?? {};
  const input = parseOffer(data);

  const wallet = typeof data.payee_wallet_id === 'string'
    ? db.prepare("SELECT id FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(data.payee_wallet_id, payeeId)
    : undefined;
  if (!wallet) {
    throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets to receive the payments.');
  }

  const id = randomUUID();
  const token = newToken();
  const now = iso();
  db.prepare(
    `INSERT INTO subscriptions (id, offer_token_hash, payee_user_id, payee_wallet_id, amount_cents, currency, interval, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, hashSecret(token), payeeId, wallet.id, input.amountCents, input.currency, input.interval, SUBSCRIPTION_STATUS.PENDING, now, now);

  return { subscription: memberView(getRow(db, id)), link: offerLink(token) };
}

function getRow(db, id) {
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
}

function findByToken(token, db) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new AppError('offer_not_found', 404, 'This subscription offer is not valid.');
  }
  const row = db
    .prepare(
      `SELECT s.*, u.first_name AS payee_first_name FROM subscriptions s
       JOIN users u ON u.id = s.payee_user_id WHERE s.offer_token_hash = ?`,
    )
    .get(hashSecret(token));
  if (!row) {
    throw new AppError('offer_not_found', 404, 'This subscription offer is not valid.');
  }
  return row;
}

export function getPublicOffer(token, { db = getDb() } = {}) {
  return publicOffer(findByToken(token, db));
}

// The payer accepts the offer from one of their linked wallets. The consent asks for a limit equal to one period.
// Returns the approval link the payer opens in their wallet. The subscription becomes active once the grant is granted.
export async function acceptOffer({ token, payerId, walletId, db = getDb(), grantDeps, now = Date.now() }) {
  const row = findByToken(token, db);
  if (row.payee_user_id === payerId) {
    throw new AppError('own_subscription', 409, 'You cannot subscribe to your own offer.');
  }
  if (row.status !== SUBSCRIPTION_STATUS.PENDING || row.grant_id) {
    throw new AppError('offer_not_available', 409, 'This offer has already been accepted.');
  }

  const payer = typeof walletId === 'string'
    ? db.prepare("SELECT * FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(walletId, payerId)
    : undefined;
  if (!payer) {
    throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets to pay from.');
  }

  const payee = db.prepare("SELECT id FROM wallets WHERE id = ? AND status = 'linked'").get(row.payee_wallet_id);
  if (!payee) {
    throw new AppError('offer_wallet_unavailable', 409, 'The payee no longer has a linked wallet for this offer.');
  }

  const consent = await requestConsent({
    userId: payerId,
    walletId: payer.id,
    purpose: 'recurring',
    limitCents: row.amount_cents,
    interval: `R/${iso(now)}/${row.interval}`,
    db,
    deps: grantDeps,
  });

  // Only one payer may accept. A second acceptance that lost the race withdraws its own permission.
  const claimed = db
    .prepare(
      "UPDATE subscriptions SET payer_user_id = ?, payer_wallet_id = ?, grant_id = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND grant_id IS NULL",
    )
    .run(payerId, payer.id, consent.id, iso(now), row.id).changes;
  if (claimed !== 1) {
    revokeGrant(payerId, consent.id, { db });
    throw new AppError('offer_not_available', 409, 'This offer has already been accepted.');
  }

  if (consent.status === 'granted') {
    activateGrantedSubscriptions({ db, now });
  }
  return { status: getRow(db, row.id).status, approvalUrl: consent.approvalUrl };
}

// Makes pending subscriptions active once their permission is granted. The first charge is due now.
export function activateGrantedSubscriptions({ db = getDb(), now = Date.now() } = {}) {
  const rows = db
    .prepare(
      `SELECT s.id FROM subscriptions s JOIN grants g ON g.id = s.grant_id
       WHERE s.status = ? AND g.status = 'granted'`,
    )
    .all(SUBSCRIPTION_STATUS.PENDING);
  for (const row of rows) {
    db.prepare("UPDATE subscriptions SET status = 'active', next_charge_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(iso(now), iso(now), row.id);
  }
  return rows.length;
}

// Starts the transfer for a period. The charge's transfer is set only if it still holds the value this run read,
// so two runs cannot both start a transfer for the same period.
function startChargeTransfer(sub, charge, db) {
  const payee = db.prepare('SELECT wallet_url FROM wallets WHERE id = ?').get(sub.payee_wallet_id);
  return db.transaction(() => {
    const created = createTransfer({
      grantId: sub.grant_id,
      fromWalletId: sub.payer_wallet_id,
      toWalletUrl: payee.wallet_url,
      amountCents: sub.amount_cents,
      currency: sub.currency,
      direction: 'in',
      db,
    });
    const changed = db
      .prepare("UPDATE subscription_charges SET transfer_id = ?, status = 'pending', updated_at = ? WHERE id = ? AND transfer_id IS ?")
      .run(created.id, iso(), charge.id, charge.transfer_id).changes;
    if (changed !== 1) {
      throw new AppError('charge_in_progress', 409, 'This period is already being charged.');
    }
    return created;
  })();
}

// Moves a charge on from its transfer. A completed charge advances the schedule; a failed one counts toward the pause.
function settleCharge(sub, charge, transfer, db) {
  return db.transaction(() => {
    if (transfer.status === TRANSFER_STATUS.COMPLETED) {
      db.prepare("UPDATE subscription_charges SET status = 'completed', updated_at = ? WHERE id = ?").run(iso(), charge.id);
      db.prepare(
        "UPDATE subscriptions SET next_charge_at = ?, failure_count = 0, updated_at = ? WHERE id = ? AND next_charge_at = ?",
      ).run(addPeriod(charge.period_start, sub.interval), iso(), sub.id, charge.period_start);
      return 'completed';
    }
    if (transfer.status === TRANSFER_STATUS.FAILED) {
      db.prepare("UPDATE subscription_charges SET status = 'failed', updated_at = ? WHERE id = ?").run(iso(), charge.id);
      // The same period is tried again on the next run, until the failures reach the limit.
      db.prepare(
        `UPDATE subscriptions SET failure_count = failure_count + 1,
           status = CASE WHEN failure_count + 1 >= ? THEN ? ELSE status END, updated_at = ?
         WHERE id = ?`,
      ).run(MAX_FAILURES, SUBSCRIPTION_STATUS.PAUSED, iso(), sub.id);
      return 'failed';
    }
    return 'pending';
  })();
}

// Charges one period. Resumes an unfinished transfer; starts a new one only when the last attempt failed for good.
async function chargePeriod(sub, { db, deps }) {
  const period = sub.next_charge_at;
  db.prepare(
    "INSERT OR IGNORE INTO subscription_charges (id, subscription_id, period_start, transfer_id, status) VALUES (?, ?, ?, NULL, 'pending')",
  ).run(randomUUID(), sub.id, period);
  let charge = db.prepare('SELECT * FROM subscription_charges WHERE subscription_id = ? AND period_start = ?').get(sub.id, period);

  let transfer = charge.transfer_id ? db.prepare('SELECT * FROM transfers WHERE id = ?').get(charge.transfer_id) : undefined;
  if (transfer && transfer.status === TRANSFER_STATUS.COMPLETED) {
    return settleCharge(sub, charge, transfer, db);
  }
  if (!transfer || transfer.status === TRANSFER_STATUS.FAILED) {
    try {
      transfer = startChargeTransfer(sub, charge, db);
    } catch (err) {
      if (err.code === 'charge_in_progress') return 'skipped';
      throw err;
    }
  }

  const result = await runPending(transfer.id, { db, deps });
  return settleCharge(sub, charge, result, db);
}

// Finds due subscriptions and charges each one's current period. Safe to run any number of times:
// a period is charged once, and a run never starts a second transfer for a period that is still in progress.
export async function runDueCharges({ db = getDb(), deps, now = Date.now() } = {}) {
  activateGrantedSubscriptions({ db, now });
  const due = db
    .prepare("SELECT * FROM subscriptions WHERE status = ? AND next_charge_at <= ? ORDER BY next_charge_at LIMIT ?")
    .all(SUBSCRIPTION_STATUS.ACTIVE, iso(now), RUN_BATCH_SIZE);

  const outcomes = { checked: due.length, completed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const sub of due) {
    const outcome = await chargePeriod(sub, { db, deps });
    outcomes[outcome] += 1;
  }
  return outcomes;
}

// The payer cancels at any time. Their permission is revoked, so no later charge can use it.
// A transfer still waiting for the network is marked failed here, so it is not picked up again.
export function cancelSubscription({ userId, subscriptionId, db = getDb() }) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ? AND payer_user_id = ?').get(subscriptionId, userId);
  if (!sub) {
    throw new AppError('subscription_not_found', 404, 'Subscription not found.');
  }
  db.transaction(() => {
    db.prepare("UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(iso(), sub.id);
    if (sub.grant_id) {
      revokeGrant(userId, sub.grant_id, { db });
      db.prepare(
        "UPDATE transfers SET status = 'failed', failure_code = 'subscription_cancelled', updated_at = ? WHERE grant_id = ? AND status = 'pending'",
      ).run(iso(), sub.grant_id);
    }
  })();
  return memberView(getRow(db, sub.id));
}

// Subscriptions where the user is the payee (offers) or the payer.
export function listSubscriptions(userId, { db = getDb() } = {}) {
  return db
    .prepare('SELECT * FROM subscriptions WHERE payee_user_id = ? OR payer_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100')
    .all(userId, userId)
    .map(memberView);
}
