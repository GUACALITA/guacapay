// Deposits and withdrawals (prompt 28).
// A deposit moves money from the user's wallet into custody; on completion it credits the app balance, backed by custody.
// A withdrawal moves money from custody to one of the user's own wallets. It is limited to what is both in the balance
// and backed in custody for that user, minus withdrawals still in progress. The balance is debited only on completion.
// Everything here is test money on the test network: it cannot become cash.
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { recordUserIn, recordUserOut, userBacking } from '../custody/service.js';
import { createTransfer, TRANSFER_STATUS } from '../transfers/engine.js';
import { runPending } from '../transfers/payments.js';
import { balanceFor, credit, debit } from './service.js';

export const MOVEMENT_STATUS = Object.freeze({ PENDING: 'pending', COMPLETED: 'completed', FAILED: 'failed' });
export const NOTICE = 'This moves test money on the test network. It cannot be turned into cash.';
const LIST_LIMIT = 100;
const RESUME_BATCH_SIZE = 50;

const iso = () => new Date().toISOString();

function parseMovement(body, { minAmountCents, maxAmountCents, currencies }) {
  const amountCents = body.amount_cents;
  if (!Number.isSafeInteger(amountCents) || amountCents < minAmountCents || amountCents > maxAmountCents) {
    throw new AppError('invalid_amount', 400, `Amount must be a whole number of cents between ${minAmountCents} and ${maxAmountCents}.`);
  }
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  if (!currencies.includes(currency)) {
    throw new AppError('invalid_currency', 400, 'Currency is not supported.');
  }
  return { amountCents, currency };
}

// The user's own linked wallet only. A revoked wallet is not 'linked', so it is refused here too.
function ownLinkedWallet(db, userId, walletId) {
  const wallet = typeof walletId === 'string'
    ? db.prepare("SELECT * FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(walletId, userId)
    : undefined;
  if (!wallet) {
    throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets.');
  }
  return wallet;
}

function assertCustodyConfigured() {
  if (!config.custody.walletId || !config.custody.address) {
    throw new AppError('transfer_not_configured', 503, 'Transfers are not available yet.');
  }
}

// What the user can withdraw now: the lower of their balance and what custody backs for them, less withdrawals in progress.
export function withdrawableCents(userId, currency, { db = getDb() } = {}) {
  const balance = balanceFor(userId, currency, { db });
  const backed = userBacking(userId, currency, { db });
  const reserved = db
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM withdrawals WHERE user_id = ? AND currency = ? AND status = 'pending'")
    .get(userId, currency).total;
  return Math.max(0, Math.min(balance, backed) - reserved);
}

function view(row) {
  return {
    id: row.id,
    amount_cents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    failure_code: row.failure_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
    notice: NOTICE,
  };
}

function settleDeposit(depositId, transfer, db) {
  db.transaction(() => {
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
    if (deposit.status !== MOVEMENT_STATUS.PENDING) return;
    if (transfer.status === TRANSFER_STATUS.COMPLETED) {
      db.prepare("UPDATE deposits SET status = 'completed', updated_at = ? WHERE id = ?").run(iso(), depositId);
      recordUserIn(db, { userId: deposit.user_id, transferId: transfer.id, amountCents: deposit.amount_cents, currency: deposit.currency });
      credit(deposit.user_id, deposit.currency, deposit.amount_cents, 'deposit', null, { db, referenceId: depositId });
    } else if (transfer.status === TRANSFER_STATUS.FAILED) {
      db.prepare("UPDATE deposits SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ?")
        .run(transfer.failure_code, iso(), depositId);
    }
  })();
  return db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
}

function settleWithdrawal(withdrawalId, transfer, db) {
  db.transaction(() => {
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (withdrawal.status !== MOVEMENT_STATUS.PENDING) return;
    if (transfer.status === TRANSFER_STATUS.COMPLETED) {
      db.prepare("UPDATE withdrawals SET status = 'completed', updated_at = ? WHERE id = ?").run(iso(), withdrawalId);
      // The balance is debited only now, once the transfer has completed.
      debit(withdrawal.user_id, withdrawal.currency, withdrawal.amount_cents, 'withdrawal', null, { db, referenceId: withdrawalId });
      recordUserOut(db, { userId: withdrawal.user_id, transferId: transfer.id, amountCents: withdrawal.amount_cents, currency: withdrawal.currency });
    } else if (transfer.status === TRANSFER_STATUS.FAILED) {
      db.prepare("UPDATE withdrawals SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ?")
        .run(transfer.failure_code, iso(), withdrawalId);
    }
  })();
  return db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
}

// Moves money from the user's wallet into custody. The balance is credited when the transfer completes.
export async function createDeposit({ userId, walletId, body, db = getDb(), deps } = {}) {
  const input = parseMovement(body ?? {}, config.payments);
  const wallet = ownLinkedWallet(db, userId, walletId);
  if (input.currency !== wallet.asset_code) {
    throw new AppError('currency_mismatch', 422, 'The wallet holds a different currency.');
  }
  const grant = db.prepare("SELECT id FROM grants WHERE wallet_id = ? AND status = 'granted' LIMIT 1").get(wallet.id);
  if (!grant) {
    throw new AppError('no_active_grant', 409, 'This wallet has no active permission. Approve it again.');
  }
  assertCustodyConfigured();

  const depositId = randomUUID();
  const transfer = db.transaction(() => {
    const created = createTransfer({
      fromWalletId: wallet.id,
      toWalletUrl: config.custody.address,
      amountCents: input.amountCents,
      currency: input.currency,
      direction: 'in',
      db,
    });
    db.prepare(
      `INSERT INTO deposits (id, user_id, wallet_id, amount_cents, currency, status, transfer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(depositId, userId, wallet.id, input.amountCents, input.currency, created.id, iso(), iso());
    return created;
  })();

  const result = await runPending(transfer.id, { db, deps });
  return view(settleDeposit(depositId, result, db));
}

// Moves money from custody to one of the user's own wallets, up to what is withdrawable. Refused before any transfer if not.
export async function createWithdrawal({ userId, walletId, body, db = getDb(), deps } = {}) {
  const input = parseMovement(body ?? {}, config.payments);
  const wallet = ownLinkedWallet(db, userId, walletId);
  if (input.currency !== wallet.asset_code) {
    throw new AppError('currency_mismatch', 422, 'The wallet holds a different currency.');
  }
  assertCustodyConfigured();

  const withdrawalId = randomUUID();
  // The check and the reservation happen in one synchronous transaction, so two requests cannot both pass it.
  const transfer = db.transaction(() => {
    const available = withdrawableCents(userId, input.currency, { db });
    if (input.amountCents > available) {
      throw new AppError(
        'withdrawal_exceeds_balance',
        409,
        `You can withdraw at most ${available} cents now. Only balance backed in custody can be withdrawn.`,
      );
    }
    const created = createTransfer({
      fromWalletId: config.custody.walletId,
      toWalletUrl: wallet.wallet_url,
      amountCents: input.amountCents,
      currency: input.currency,
      direction: 'out',
      db,
    });
    db.prepare(
      `INSERT INTO withdrawals (id, user_id, wallet_id, amount_cents, currency, status, transfer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(withdrawalId, userId, wallet.id, input.amountCents, input.currency, created.id, iso(), iso());
    return created;
  })();

  const result = await runPending(transfer.id, { db, deps });
  return view(settleWithdrawal(withdrawalId, result, db));
}

export function listDeposits(userId, { db = getDb() } = {}) {
  return db
    .prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, LIST_LIMIT)
    .map(view);
}

export function listWithdrawals(userId, { db = getDb() } = {}) {
  return db
    .prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, LIST_LIMIT)
    .map(view);
}

// Finishes deposits and withdrawals whose transfers were still pending. Called by the poller.
export async function resumeMovements({ db = getDb(), deps } = {}) {
  let settled = 0;
  const deposits = db
    .prepare("SELECT d.id, t.id AS transfer_id FROM deposits d JOIN transfers t ON t.id = d.transfer_id WHERE d.status = 'pending' AND t.status = 'pending' LIMIT ?")
    .all(RESUME_BATCH_SIZE);
  for (const row of deposits) {
    const result = await runPending(row.transfer_id, { db, deps });
    if (settleDeposit(row.id, result, db).status !== MOVEMENT_STATUS.PENDING) settled += 1;
  }
  const withdrawals = db
    .prepare("SELECT w.id, t.id AS transfer_id FROM withdrawals w JOIN transfers t ON t.id = w.transfer_id WHERE w.status = 'pending' AND t.status = 'pending' LIMIT ?")
    .all(RESUME_BATCH_SIZE);
  for (const row of withdrawals) {
    const result = await runPending(row.transfer_id, { db, deps });
    if (settleWithdrawal(row.id, result, db).status !== MOVEMENT_STATUS.PENDING) settled += 1;
  }
  return { checked: deposits.length + withdrawals.length, settled };
}
