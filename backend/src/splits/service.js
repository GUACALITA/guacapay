// One payment split among several recipients (prompt 27). Each part is a child payment, paid from the payer's wallet
// into custody (prompt 22) and claimed separately by its recipient. One child failing does not touch the others.
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { normalizeEmail } from '../validation.js';
import { addPaymentEvent, createPayment, transitionPayment } from '../payments/service.js';
import { STATUS } from '../payments/states.js';
import { issueClaim } from '../claims/service.js';
import { unconfiguredMailer } from '../auth/mailer.js';
import { payFromWallet } from '../transfers/payments.js';
import { logger } from '../logger.js';

export const SPLIT_STATUS = Object.freeze({ PENDING: 'pending', COMPLETED: 'completed', PARTIAL: 'partial' });
const MIN_RECIPIENTS = 2;
const MAX_RECIPIENTS = 20;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const TERMINAL_CHILD_STATUSES = ['completed', 'failed', 'expired'];
const LIST_LIMIT = 100;

const iso = () => new Date().toISOString();

function parseSplit(body) {
  const { minAmountCents, maxAmountCents, currencies } = config.payments;

  const total = body.total_cents;
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new AppError('invalid_amount', 400, 'The total must be a positive whole number of cents.');
  }

  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  if (!currencies.includes(currency)) {
    throw new AppError('invalid_currency', 400, 'Currency is not supported.');
  }

  if (!Array.isArray(body.parts)) {
    throw new AppError('invalid_parts', 400, 'Parts must be a list of recipients and amounts.');
  }
  if (body.parts.length > MAX_RECIPIENTS) {
    throw new AppError('too_many_recipients', 400, `A split is limited to ${MAX_RECIPIENTS} recipients.`);
  }
  if (body.parts.length < MIN_RECIPIENTS) {
    throw new AppError('invalid_parts', 400, `A split needs at least ${MIN_RECIPIENTS} recipients.`);
  }

  const seen = new Set();
  const parts = body.parts.map((part) => {
    const email = normalizeEmail(part?.recipient_email);
    if (seen.has(email)) {
      throw new AppError('duplicate_recipient', 400, 'Each recipient can appear only once in a split.');
    }
    seen.add(email);
    const amount = part?.amount_cents;
    if (!Number.isSafeInteger(amount) || amount < minAmountCents || amount > maxAmountCents) {
      throw new AppError('invalid_amount', 400, `Each part must be a whole number of cents between ${minAmountCents} and ${maxAmountCents}.`);
    }
    return { email, amountCents: amount };
  });

  // The parts must add up exactly. Checked before anything is created.
  const sum = parts.reduce((acc, part) => acc + part.amountCents, 0);
  if (sum !== total) {
    throw new AppError('split_mismatch', 400, `The parts add up to ${sum} but the total is ${total}.`);
  }

  return { total, currency, parts };
}

function parseKey(raw) {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw new AppError('invalid_idempotency_key', 400, 'Idempotency-Key must be 8 to 100 letters, digits, hyphens or underscores.');
  }
  return raw;
}

// A fingerprint of the request, so a repeated key with different details is refused.
function requestHash(input, walletId) {
  return createHash('sha256')
    .update(JSON.stringify({ total: input.total, currency: input.currency, walletId, parts: input.parts }))
    .digest('hex');
}

// Split status from its children: pending while any child is in progress; completed when all completed; otherwise partial.
export function refreshSplit(splitId, { db = getDb() } = {}) {
  const children = db.prepare('SELECT status FROM payments WHERE parent_split_id = ?').all(splitId);
  let status = SPLIT_STATUS.PENDING;
  if (children.every((child) => TERMINAL_CHILD_STATUSES.includes(child.status))) {
    status = children.every((child) => child.status === STATUS.COMPLETED) ? SPLIT_STATUS.COMPLETED : SPLIT_STATUS.PARTIAL;
  }
  db.prepare('UPDATE split_payments SET status = ?, updated_at = ? WHERE id = ? AND status != ?').run(status, iso(), splitId, status);
  return status;
}

function latestFailureReason(paymentId, db) {
  const row = db
    .prepare("SELECT payload_json FROM payment_events WHERE payment_id = ? AND type IN ('split.child_failed', 'transfer.failed') ORDER BY id DESC LIMIT 1")
    .get(paymentId);
  return row ? JSON.parse(row.payload_json).reason ?? null : null;
}

// The payer's view: each child's recipient, amount, status, and why it failed, if it did.
function viewSplit(split, db) {
  const children = db
    .prepare('SELECT id, recipient_email, amount_cents, status FROM payments WHERE parent_split_id = ? ORDER BY rowid')
    .all(split.id)
    .map((child) => ({
      payment_id: child.id,
      recipient_email: child.recipient_email,
      amount_cents: child.amount_cents,
      status: child.status,
      failure_reason: child.status === STATUS.FAILED ? latestFailureReason(child.id, db) : null,
    }));
  return {
    id: split.id,
    total_cents: split.total_cents,
    currency: split.currency,
    status: split.status,
    created_at: split.created_at,
    children,
  };
}

function findExisting(payerId, key, db) {
  return db.prepare('SELECT * FROM split_payments WHERE payer_user_id = ? AND idempotency_key = ?').get(payerId, key);
}

// Creates the split and its child payments, then pays each part from the payer's wallet and issues its claim.
// Nothing is created if the parts do not add up. A failed part is recorded on its child; the others continue.
export async function createSplit({ payerId, body, walletId, idempotencyKey, mailer = unconfiguredMailer, db = getDb(), deps } = {}) {
  const data = body ?? {};
  const input = parseSplit(data);
  const key = parseKey(idempotencyKey);
  const hash = requestHash(input, walletId);

  if (key) {
    const existing = findExisting(payerId, key, db);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new AppError('idempotency_conflict', 409, 'This Idempotency-Key was already used for a different split.');
      }
      return { split: viewSplit(existing, db), created: false };
    }
  }

  const wallet = typeof walletId === 'string'
    ? db.prepare("SELECT id FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(walletId, payerId)
    : undefined;
  if (!wallet) {
    throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets to pay from.');
  }
  if (!config.custody.walletId || !config.custody.address) {
    throw new AppError('transfer_not_configured', 503, 'Transfers are not available yet.');
  }

  const splitId = randomUUID();
  const childIds = [];
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO split_payments (id, payer_user_id, total_cents, currency, status, idempotency_key, request_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(splitId, payerId, input.total, input.currency, SPLIT_STATUS.PENDING, key, hash, iso(), iso());

      for (const part of input.parts) {
        const { payment } = createPayment({
          senderId: payerId,
          body: { recipient_email: part.email, amount_cents: part.amountCents, currency: input.currency },
          parentSplitId: splitId,
          db,
        });
        childIds.push(payment.id);
      }
    })();
  } catch (err) {
    if (key && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = findExisting(payerId, key, db);
      return { split: viewSplit(existing, db), created: false };
    }
    throw err;
  }

  // Each part is paid in turn. A part that cannot be paid is marked failed; the rest still go ahead.
  for (const paymentId of childIds) {
    try {
      const outcome = await payFromWallet({ paymentId, userId: payerId, walletId: wallet.id, db, deps });
      if (outcome.status === STATUS.PAID) {
        try {
          await issueClaim(paymentId, { mailer, db });
        } catch (err) {
          logger.warn('claim issue for split part failed', { paymentId, error: err.message });
        }
      } else if (outcome.status === STATUS.FAILED) {
        addPaymentEvent(paymentId, 'split.child_failed', { reason: outcome.reason ?? 'unknown' }, { db });
      }
    } catch (err) {
      const child = db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId);
      if (child.status === STATUS.CREATED) {
        transitionPayment(paymentId, STATUS.FAILED, { db });
        addPaymentEvent(paymentId, 'split.child_failed', { reason: err.code ?? 'unknown' }, { db });
      }
    }
  }

  refreshSplit(splitId, { db });
  return { split: viewSplit(db.prepare('SELECT * FROM split_payments WHERE id = ?').get(splitId), db), created: true };
}

export function getSplit(payerId, splitId, { db = getDb() } = {}) {
  const split = db.prepare('SELECT * FROM split_payments WHERE id = ? AND payer_user_id = ?').get(splitId, payerId);
  if (!split) {
    throw new AppError('split_not_found', 404, 'Split not found.');
  }
  return viewSplit(split, db);
}

export function listSplits(payerId, { db = getDb() } = {}) {
  return db
    .prepare('SELECT * FROM split_payments WHERE payer_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(payerId, LIST_LIMIT)
    .map((split) => ({ id: split.id, total_cents: split.total_cents, currency: split.currency, status: split.status, created_at: split.created_at }));
}

// Called by the poller: children that were waiting (for a transfer or a claim) may have finished since.
export function refreshPendingSplits({ db = getDb() } = {}) {
  const pending = db.prepare('SELECT id FROM split_payments WHERE status = ?').all(SPLIT_STATUS.PENDING);
  for (const row of pending) {
    refreshSplit(row.id, { db });
  }
  return pending.length;
}
