// The custody ledger: how much money the platform holds in its custody wallet, and for which payment.
// Writes happen inside the transaction that changes the payment, so the ledger and the payment states agree.
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { getWalletAddress } from '../providers/openpayments.js';

const DIRECTION = Object.freeze({ IN: 'in', OUT: 'out' });

// An entry belongs to exactly one owner: a payment, a pool, or a user (their backed balance).
function write(db, { paymentId = null, poolId = null, userId = null, transferId, amountCents, currency, direction }) {
  try {
    db.prepare(
      `INSERT INTO custody_entries (id, payment_id, pool_id, user_id, amount_cents, currency, direction, transfer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), paymentId, poolId, userId, amountCents, currency, direction, transferId ?? null);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_TRIGGER' && err.message.includes('custody_out_exceeds_in')) {
      throw new AppError('custody_out_exceeds_in', 409, 'The custody wallet does not hold enough for this payment.');
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new AppError('custody_entry_exists', 409, 'This transfer is already in the custody ledger.');
    }
    throw err;
  }
}

// Money arrived in custody: the pay-in transfer completed.
export function recordIn(db, entry) {
  write(db, { ...entry, direction: DIRECTION.IN });
}

// Money left custody: the payout to the recipient completed.
export function recordOut(db, entry) {
  write(db, { ...entry, direction: DIRECTION.OUT });
}

// The amount custody holds for one user in one currency (deposits in, withdrawals out).
export function userBacking(userId, currency, { db = getDb() } = {}) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount_cents ELSE -amount_cents END), 0) AS backed
       FROM custody_entries WHERE user_id = ? AND currency = ?`,
    )
    .get(userId, currency).backed;
}

export function recordUserIn(db, entry) {
  write(db, { ...entry, direction: DIRECTION.IN });
}

export function recordUserOut(db, entry) {
  write(db, { ...entry, direction: DIRECTION.OUT });
}

// Refuses a payout the ledger cannot cover, before any money is sent.
export function assertCustodyHolds(paymentId, { db = getDb() } = {}) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount_cents ELSE -amount_cents END), 0) AS held,
              (SELECT amount_cents FROM payments WHERE id = ?) AS due
       FROM custody_entries WHERE payment_id = ?`,
    )
    .get(paymentId, paymentId);
  if (row.held < row.due) {
    throw new AppError('custody_out_exceeds_in', 409, 'The custody wallet does not hold enough for this payment.');
  }
}

// Balance per currency: the sum of entries. Throws if a balance is negative, because that means the rules were broken.
export function custodyBalances({ db = getDb() } = {}) {
  const rows = db
    .prepare(
      `SELECT currency, SUM(CASE direction WHEN 'in' THEN amount_cents ELSE -amount_cents END) AS balance_cents
       FROM custody_entries GROUP BY currency ORDER BY currency`,
    )
    .all();
  for (const row of rows) {
    if (row.balance_cents < 0) {
      throw new Error(`custody balance is negative for ${row.currency}`);
    }
  }
  return rows;
}

// Open Payments wallet documents on the test network carry no balance field that this app reads,
// so the balance on the wallet side is reported as not available. Replace this when the API exposes it.
export async function readPublicBalance() {
  return { available: false, reason: 'not_available_from_api' };
}

// Compares the ledger with the custody wallet's public document. Never guesses: when the API shows no balance, it says so.
export async function reconcile({ db = getDb(), readBalance = readPublicBalance } = {}) {
  const ledger = custodyBalances({ db });
  const onChain = await readBalance();
  if (!onChain.available) {
    return { ledger, comparison: 'not_available_from_api', reason: onChain.reason };
  }
  const entry = ledger.find((row) => row.currency === onChain.currency);
  const ledgerCents = entry ? entry.balance_cents : 0;
  return {
    ledger,
    comparison: ledgerCents === onChain.balanceCents ? 'match' : 'mismatch',
    ledgerCents,
    walletCents: onChain.balanceCents,
    currency: onChain.currency,
  };
}

// Start-up check: the custody wallet exists, is linked, and has a permission. Reports the first problem; never throws.
export async function checkCustodyWallet({ db = getDb(), readWallet = getWalletAddress } = {}) {
  const { walletId, address } = config.custody;
  if (!walletId || !address) {
    return { ok: false, reason: 'not_configured' };
  }

  const row = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!row) return { ok: false, reason: 'wallet_row_missing' };
  if (row.status !== 'linked') return { ok: false, reason: 'wallet_not_linked' };
  if (row.wallet_url !== address) return { ok: false, reason: 'address_mismatch' };

  const grant = db
    .prepare("SELECT id FROM grants WHERE wallet_id = ? AND status = 'granted' AND access_token_enc IS NOT NULL")
    .get(walletId);
  if (!grant) return { ok: false, reason: 'no_active_grant' };

  try {
    await readWallet(address);
  } catch {
    return { ok: false, reason: 'wallet_unreachable' };
  }
  return { ok: true };
}
