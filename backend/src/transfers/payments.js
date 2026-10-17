// Money movements for payments, built from transfers (engine.js).
// Pay-in: the sender's wallet to the custody wallet. Payout: the custody wallet to the recipient's wallet.
// A payment moves on only when its transfer reports completed. Retryable outcomes leave the payment where it is.
import { assertWalletCurrency } from '../wallets/service.js';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { AppError } from '../errors.js';
import { STATUS } from '../payments/states.js';
import { addPaymentEvent, transitionPayment } from '../payments/service.js';
import { createTransfer, getTransfer, runTransfer, TRANSFER_STATUS } from './engine.js';
import { recordIn } from '../custody/service.js';

export const DIRECTION = Object.freeze({ IN: 'in', OUT: 'out' });
const RESUME_BATCH_SIZE = 50;

// Transfers running in this process. A second request for the same transfer gets the stored row instead of a second run.
const running = new Set();

function assertCustodyConfigured() {
  if (!config.custody.address) {
    throw new AppError('transfer_not_configured', 503, 'Transfers are not available yet.');
  }
}

// Returns the custody wallet row for a given currency, or null if none is configured.
function getCustodyForCurrency(currency, db) {
  const address = config.custody.addressByCurrency[currency];
  if (!address) return null;
  return db.prepare("SELECT id, wallet_url, asset_code FROM wallets WHERE wallet_url = ? AND status != 'revoked'").get(address) || null;
}

function findTransfer(db, paymentId, direction) {
  return db
    .prepare('SELECT * FROM transfers WHERE payment_id = ? AND direction = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(paymentId, direction);
}

// Writes a finished transfer and its legs into the payment's event log. Legs hold Open Payments object URLs, not secrets.
// Pending transfers are not recorded: they would repeat on every retry.
export function recordFinishedTransfer(paymentId, transfer, { db = getDb() } = {}) {
  if (transfer.status === TRANSFER_STATUS.PENDING) return;
  const legs = db
    .prepare('SELECT kind, status, remote_id FROM transfer_legs WHERE transfer_id = ? ORDER BY kind')
    .all(transfer.id);
  addPaymentEvent(
    paymentId,
    'transfer.recorded',
    {
      transfer_id: transfer.id,
      direction: transfer.direction,
      status: transfer.status,
      failure_code: transfer.failure_code,
      legs,
    },
    { db },
  );
}

// Runs a transfer unless this process is already running it. Returns the stored transfer after the attempt.
export async function runPending(transferId, { db = getDb(), deps } = {}) {
  if (running.has(transferId)) return getTransfer(transferId, { db });
  running.add(transferId);
  try {
    return await runTransfer(transferId, { db, deps });
  } finally {
    running.delete(transferId);
  }
}

// Moves a payment on from what its pay-in transfer reported. Only a completed transfer makes the payment paid.
export function settlePayIn(paymentId, transfer, { db = getDb() } = {}) {
  return db.transaction(() => {
    const payment = db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId);
    if (!payment || payment.status !== STATUS.AWAITING_PAYMENT) {
      return { status: payment?.status ?? 'unknown' };
    }

    if (transfer.status === TRANSFER_STATUS.COMPLETED) {
      recordFinishedTransfer(paymentId, transfer, { db });
      recordIn(db, { paymentId, transferId: transfer.id, amountCents: transfer.amount_cents, currency: transfer.currency });
      transitionPayment(paymentId, STATUS.PAID, { db });
      return { status: STATUS.PAID };
    }
    if (transfer.status === TRANSFER_STATUS.FAILED) {
      recordFinishedTransfer(paymentId, transfer, { db });
      transitionPayment(paymentId, STATUS.FAILED, { db });
      return { status: STATUS.FAILED, reason: transfer.failure_code };
    }
    return { status: STATUS.AWAITING_PAYMENT, reason: transfer.failure_code };
  })();
}

// Pay-in (transfer 1). The first call creates the transfer from the chosen wallet and moves the payment to awaiting_payment.
// A repeat call resumes that same transfer, so a retry never sends money twice.
// Returns { status }: paid, failed, or awaiting_payment (still running; the poller resumes it).
export async function payFromWallet({ paymentId, userId, walletId, db = getDb(), deps } = {}) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND sender_id = ?').get(paymentId, userId);
  if (!payment) {
    throw new AppError('payment_not_found', 404, 'Payment not found.');
  }
  if (payment.purpose !== 'transfer' || payment.payment_method !== 'wallet') {
    throw new AppError('payment_not_payable', 409, 'This payment is not paid from a wallet.');
  }

  let transfer = findTransfer(db, paymentId, DIRECTION.IN);
  if (payment.status === STATUS.CREATED && !transfer) {
    assertCustodyConfigured();
    const wallet =
      typeof walletId === 'string'
        ? db.prepare("SELECT id, asset_code FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(walletId, userId)
        : undefined;
    if (!wallet) {
      throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets to pay from.');
    }
    // Refuse paying from any custody wallet.
    const allCustodyAddresses = new Set(Object.values(config.custody.addressByCurrency).concat(config.custody.address));
    if (allCustodyAddresses.has(wallet.wallet_url)) {
      throw new AppError('custody_wallet_not_payer', 422, "Pay from your own wallet. The platform's custody wallet cannot be the payer.");
    }
    assertWalletCurrency(wallet, payment.currency);
    // The money goes into the custody wallet for this currency. Refused here before the network sees it.
    const custodyWallet = getCustodyForCurrency(payment.currency, db);
    if (!custodyWallet) {
      throw new AppError(
        'currency_not_held',
        422,
        `Payments in ${payment.currency} are not available yet. The platform has no custody wallet for ${payment.currency}.`,
      );
    }

    // The status change and the transfer row are written together: a payment never waits without its transfer.
    transfer = db.transaction(() => {
      transitionPayment(paymentId, STATUS.AWAITING_PAYMENT, { db });
      return createTransfer({
        paymentId,
        fromWalletId: wallet.id,
        toWalletUrl: custodyWallet.wallet_url,
        amountCents: payment.amount_cents,
        currency: payment.currency,
        direction: DIRECTION.IN,
        db,
      });
    })();
  } else if (payment.status !== STATUS.AWAITING_PAYMENT || !transfer) {
    throw new AppError('payment_not_payable', 409, 'This payment cannot be paid from a wallet now.');
  }

  const result = await runPending(transfer.id, { db, deps });
  return settlePayIn(paymentId, result, { db });
}

// Payout (transfer 2): the custody wallet to the recipient's wallet.
// Resolves with the completed transfer. Otherwise throws an AppError with the reason; `retryable` is set when a later
// attempt may still succeed, and then the claim stays in progress until resumePayouts settles it.
export async function payoutToRecipient({ paymentId, destination, amountCents, currency, db = getDb(), deps } = {}) {
  assertCustodyConfigured();
  const custodyWallet = getCustodyForCurrency(currency, db);
  if (!custodyWallet) {
    throw new AppError('currency_not_held', 422, `Payouts in ${currency} are not available: the platform has no custody wallet for ${currency}.`);
  }

  let transfer = findTransfer(db, paymentId, DIRECTION.OUT);
  if (!transfer) {
    transfer = createTransfer({
      paymentId,
      fromWalletId: custodyWallet.id,
      toWalletUrl: destination,
      amountCents,
      currency,
      direction: DIRECTION.OUT,
      db,
    });
  }

  const result = await runPending(transfer.id, { db, deps });
  if (result.status === TRANSFER_STATUS.COMPLETED) {
    recordFinishedTransfer(paymentId, result, { db });
    return result;
  }
  if (result.status === TRANSFER_STATUS.FAILED) {
    recordFinishedTransfer(paymentId, result, { db });
    throw new AppError(result.failure_code, 422, 'The transfer to the recipient did not go through.');
  }
  throw Object.assign(
    new AppError(result.failure_code ?? 'leg_timeout', 503, 'The transfer to the recipient is still in progress.'),
    { retryable: true },
  );
}

// Picks up pay-in transfers that were still pending. Called by the poller; a payment that settles here is issued its claim link by the poller too.
export async function resumePayIns({ db = getDb(), deps } = {}) {
  const rows = db
    .prepare(
      `SELECT t.id AS transfer_id, t.payment_id
       FROM transfers t JOIN payments p ON p.id = t.payment_id
       WHERE t.direction = ? AND t.status = ? AND p.status = ?
       ORDER BY t.updated_at LIMIT ?`,
    )
    .all(DIRECTION.IN, TRANSFER_STATUS.PENDING, STATUS.AWAITING_PAYMENT, RESUME_BATCH_SIZE);

  let settled = 0;
  for (const row of rows) {
    const result = await runPending(row.transfer_id, { db, deps });
    if (settlePayIn(row.payment_id, result, { db }).status !== STATUS.AWAITING_PAYMENT) settled += 1;
  }
  return { checked: rows.length, settled };
}
