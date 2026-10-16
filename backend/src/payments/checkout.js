// Starts the hosted checkout for a payment and records the checkout ID.
import { getDb } from '../db.js';
import { AppError } from '../errors.js';
import { STATUS } from './states.js';
import { getPaymentForUser, transitionPayment } from './service.js';

// Stores the checkout ID and moves the payment to awaiting_payment in one transaction.
export function attachCheckout(paymentId, checkoutId, { db = getDb() } = {}) {
  return db.transaction(() => {
    const row = db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId);
    if (!row || row.status !== STATUS.CREATED) {
      throw new AppError('checkout_not_available', 409, 'This payment is not waiting for a checkout.');
    }
    db.prepare('UPDATE payments SET rapyd_checkout_id = ? WHERE id = ?').run(checkoutId, paymentId);
    transitionPayment(paymentId, STATUS.AWAITING_PAYMENT, { db });
  })();
}

export async function startCheckout({ paymentId, userId, gateway, returnUrl, db = getDb() }) {
  // 404 if the payment is not this user's.
  const payment = getPaymentForUser(paymentId, userId, { db });

  if (payment.status !== STATUS.CREATED) {
    throw new AppError('checkout_not_available', 409, 'This payment is not waiting for a checkout.');
  }

  // The gateway sends paymentId as Rapyd's idempotency key, so a repeat call cannot create a second checkout.
  const checkout = await gateway.createCheckout({
    paymentId,
    amountCents: payment.amount_cents,
    currency: payment.currency,
    returnUrl,
  });

  attachCheckout(paymentId, checkout.checkoutId, { db });
  return { checkoutId: checkout.checkoutId, redirectUrl: checkout.redirectUrl };
}
