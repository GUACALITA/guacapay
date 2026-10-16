// Internal payment records: creation, reads, and state changes.
// Knows nothing about payment providers.
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { normalizeEmail } from '../validation.js';
import { STATUS, assertTransition } from './states.js';
import { publishPaymentUpdated } from './events.js';

const MESSAGE_MAX_LENGTH = 500;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const LIST_LIMIT = 100;

// Columns that are safe to return to the sender.
const PUBLIC_COLUMNS = 'id, status, recipient_email, amount_cents, currency, message, created_at, updated_at';

function isoNow() {
  return new Date().toISOString();
}

// Shape returned to clients. Internal columns such as rapyd_checkout_id are left out.
export function toPublicPayment(row) {
  return {
    id: row.id,
    status: row.status,
    recipient_email: row.recipient_email,
    amount_cents: row.amount_cents,
    currency: row.currency,
    message: row.message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function parseNewPayment(body) {
  const { minAmountCents, maxAmountCents, currencies } = config.payments;

  const recipientEmail = normalizeEmail(body.recipient_email);

  const amountCents = body.amount_cents;
  if (!Number.isSafeInteger(amountCents) || amountCents < minAmountCents || amountCents > maxAmountCents) {
    throw new AppError(
      'invalid_amount',
      400,
      `Amount must be a whole number of cents between ${minAmountCents} and ${maxAmountCents}.`,
    );
  }

  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  if (!currencies.includes(currency)) {
    throw new AppError('invalid_currency', 400, 'Currency is not supported.');
  }

  let message = null;
  if (body.message !== undefined && body.message !== null) {
    if (typeof body.message !== 'string' || body.message.length > MESSAGE_MAX_LENGTH) {
      throw new AppError('invalid_message', 400, `Message must be text of at most ${MESSAGE_MAX_LENGTH} characters.`);
    }
    message = body.message.trim() || null;
  }

  return { recipientEmail, amountCents, currency, message };
}

function parseIdempotencyKey(raw) {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new AppError(
      'invalid_idempotency_key',
      400,
      'Idempotency-Key must be 8 to 100 letters, digits, hyphens or underscores.',
    );
  }
  return raw;
}

function sameRequest(row, input) {
  return (
    row.recipient_email === input.recipientEmail &&
    row.amount_cents === input.amountCents &&
    row.currency === input.currency &&
    row.message === input.message
  );
}

// Every status change goes through here, inside the caller's transaction.
function recordEvent(db, paymentId, from, to) {
  db.prepare('INSERT INTO payment_events (payment_id, type, payload_json) VALUES (?, ?, ?)').run(
    paymentId,
    'status.changed',
    JSON.stringify({ from, to }),
  );
}

// Returns { payment, created }. A repeated request with the same key returns the first payment.
export function createPayment({ senderId, body, idempotencyKey, purpose = 'transfer', db = getDb() }) {
  const input = parseNewPayment(body);
  const key = parseIdempotencyKey(idempotencyKey);

  const outcome = db.transaction(() => {
    if (key) {
      const existing = db
        .prepare('SELECT * FROM payments WHERE sender_id = ? AND idempotency_key = ?')
        .get(senderId, key);
      if (existing) {
        if (!sameRequest(existing, input)) {
          throw new AppError(
            'idempotency_conflict',
            409,
            'This Idempotency-Key was already used for a different payment.',
          );
        }
        return { payment: existing, created: false };
      }
    }

    const id = randomUUID();
    const now = isoNow();
    db.prepare(
      `INSERT INTO payments (id, sender_id, recipient_email, amount_cents, currency, status, message,
         idempotency_key, created_at, updated_at, purpose)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      senderId,
      input.recipientEmail,
      input.amountCents,
      input.currency,
      STATUS.CREATED,
      input.message,
      key,
      now,
      now,
      purpose,
    );
    recordEvent(db, id, null, STATUS.CREATED);

    return { payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(id), created: true };
  })();

  if (outcome.created) {
    publishPaymentUpdated({
      paymentId: outcome.payment.id,
      status: outcome.payment.status,
      at: outcome.payment.updated_at,
    });
  }
  return outcome;
}

export function getPaymentForUser(id, userId, { db = getDb() } = {}) {
  const row = db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM payments WHERE id = ? AND sender_id = ?`)
    .get(id, userId);
  if (!row) {
    // Same 404 whether the payment does not exist or belongs to someone else.
    throw new AppError('payment_not_found', 404, 'Payment not found.');
  }
  return row;
}

export function listPaymentsForUser(userId, { db = getDb() } = {}) {
  return db
    .prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM payments WHERE sender_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(userId, LIST_LIMIT);
}

// Moves a payment to a new state and records the change in one transaction.
// Throws InvalidTransitionError if the move is not allowed; nothing is written then.
export function transitionPayment(paymentId, to, { db = getDb() } = {}) {
  const updated = db.transaction(() => {
    const current = db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId);
    if (!current) {
      throw new AppError('payment_not_found', 404, 'Payment not found.');
    }

    assertTransition(current.status, to);

    // The status check in WHERE guards against a concurrent change.
    const result = db
      .prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, isoNow(), paymentId, current.status);
    if (result.changes !== 1) {
      throw new Error(`payment ${paymentId} changed while being updated`);
    }

    recordEvent(db, paymentId, current.status, to);
    return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM payments WHERE id = ?`).get(paymentId);
  })();

  publishPaymentUpdated({ paymentId, status: updated.status, at: updated.updated_at });
  return updated;
}

// Records something that is not a state change, such as why a transfer failed. Never put secrets in the payload.
export function addPaymentEvent(paymentId, type, payload, { db = getDb() } = {}) {
  db.prepare('INSERT INTO payment_events (payment_id, type, payload_json) VALUES (?, ?, ?)').run(
    paymentId,
    type,
    JSON.stringify(payload),
  );
}
