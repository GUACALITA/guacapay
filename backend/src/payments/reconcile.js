// Brings payments in line with Rapyd. The status always comes from a direct checkout status request,
// never from the content of a webhook alone.
import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { STATUS } from './states.js';
import { transitionPayment } from './service.js';

const POLL_OLDER_THAN_MS = 2 * 60 * 1000;
const POLL_BATCH_SIZE = 50;

// Provider status -> payment state. "pending" and "unknown" change nothing.
const TARGET_BY_PROVIDER_STATUS = Object.freeze({
  paid: STATUS.PAID,
  expired: STATUS.EXPIRED,
  declined: STATUS.FAILED,
});

async function confirmWithProvider(payment, gateway) {
  const checkout = await gateway.getCheckoutStatus(payment.rapyd_checkout_id);
  return checkout.status;
}

// Applies a provider status, but only to a payment that is still awaiting payment.
// Returns true if the payment changed.
export function applyProviderStatus(paymentId, providerStatus, { db = getDb() } = {}) {
  const target = TARGET_BY_PROVIDER_STATUS[providerStatus];
  if (!target) return false;

  return db.transaction(() => {
    const row = db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId);
    if (!row || row.status !== STATUS.AWAITING_PAYMENT) return false;
    transitionPayment(paymentId, target, { db });
    return true;
  })();
}

// Handles one forwarded webhook event. Outcomes: applied, duplicate, no_change, ignored.
export async function handleProviderEvent(event, { gateway, db = getDb() }) {
  if (!event.paymentReference) {
    return { outcome: 'ignored', reason: 'no_reference' };
  }

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(event.paymentReference);
  if (!payment) {
    logger.warn('event for unknown payment', { eventId: event.eventId });
    return { outcome: 'ignored', reason: 'unknown_payment' };
  }

  if (payment.status !== STATUS.AWAITING_PAYMENT || !payment.rapyd_checkout_id) {
    return { outcome: 'ignored', reason: 'not_awaiting' };
  }

  const providerStatus = await confirmWithProvider(payment, gateway);

  // Check and write in one transaction, so a repeated event cannot apply twice.
  return db.transaction(() => {
    const seen = db.prepare('SELECT 1 FROM processed_events WHERE event_id = ?').get(event.eventId);
    if (seen) return { outcome: 'duplicate' };

    if (!applyProviderStatus(payment.id, providerStatus, { db })) {
      return { outcome: 'no_change', providerStatus };
    }

    db.prepare('INSERT INTO processed_events (event_id, payment_id) VALUES (?, ?)').run(event.eventId, payment.id);
    return { outcome: 'applied', providerStatus };
  })();
}

// Checks payments that have waited for two minutes without a webhook.
export async function reconcilePending({ gateway, db = getDb(), now = Date.now() } = {}) {
  const cutoff = new Date(now - POLL_OLDER_THAN_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM payments
       WHERE status = ? AND rapyd_checkout_id IS NOT NULL AND updated_at <= ?
       ORDER BY updated_at LIMIT ?`,
    )
    .all(STATUS.AWAITING_PAYMENT, cutoff, POLL_BATCH_SIZE);

  let applied = 0;
  for (const payment of rows) {
    try {
      const providerStatus = await confirmWithProvider(payment, gateway);
      if (applyProviderStatus(payment.id, providerStatus, { db })) applied += 1;
    } catch (err) {
      logger.warn('poll check failed', { paymentId: payment.id, error: err.message });
    }
  }
  return { checked: rows.length, applied };
}
