// App balance: credited by recharges, debited by payments made with it. Every movement is recorded.
import { getDb } from '../db.js';
import { AppError } from '../errors.js';

const iso = () => new Date().toISOString();

export function getBalances(userId, { db = getDb() } = {}) {
  return db
    .prepare('SELECT currency, balance_cents FROM balances WHERE user_id = ? ORDER BY currency')
    .all(userId);
}

export function balanceFor(userId, currency, { db = getDb() } = {}) {
  const row = db.prepare('SELECT balance_cents FROM balances WHERE user_id = ? AND currency = ?').get(userId, currency);
  return row ? row.balance_cents : 0;
}

// Must run inside a transaction when it is part of a larger change.
// referenceId ties a movement to a deposit or withdrawal (prompt 28). Those are not payments, so paymentId stays null.
export function credit(userId, currency, amountCents, reason, paymentId, { db = getDb(), referenceId = null } = {}) {
  db.prepare(
    `INSERT INTO balances (user_id, currency, balance_cents, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, currency) DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents, updated_at = excluded.updated_at`,
  ).run(userId, currency, amountCents, iso());
  db.prepare(
    'INSERT INTO ledger_entries (user_id, currency, amount_cents, reason, payment_id, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, currency, amountCents, reason, paymentId, referenceId);
}

// Refuses to go below zero. The CHECK constraint on the table is a second guard.
export function debit(userId, currency, amountCents, reason, paymentId, { db = getDb(), referenceId = null } = {}) {
  if (balanceFor(userId, currency, { db }) < amountCents) {
    throw new AppError('insufficient_balance', 409, 'Your app balance is not enough for this payment.');
  }
  db.prepare('UPDATE balances SET balance_cents = balance_cents - ?, updated_at = ? WHERE user_id = ? AND currency = ?').run(
    amountCents,
    iso(),
    userId,
    currency,
  );
  db.prepare(
    'INSERT INTO ledger_entries (user_id, currency, amount_cents, reason, payment_id, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, currency, -amountCents, reason, paymentId, referenceId);
}
