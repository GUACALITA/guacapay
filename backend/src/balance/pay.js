// Pays a transfer with the sender's app balance. The balance debit and the status change happen in one transaction.
import { getDb } from '../db.js';
import { AppError } from '../errors.js';
import { STATUS } from '../payments/states.js';
import { transitionPayment } from '../payments/service.js';
import { debit } from './service.js';

export function payWithBalance({ paymentId, userId, db = getDb() }) {
  const row = db
    .prepare('SELECT id, status, purpose, amount_cents, currency FROM payments WHERE id = ? AND sender_id = ?')
    .get(paymentId, userId);
  if (!row) {
    throw new AppError('payment_not_found', 404, 'Payment not found.');
  }
  if (row.purpose !== 'transfer' || row.status !== STATUS.CREATED) {
    throw new AppError('payment_not_payable', 409, 'This payment cannot be paid with app balance.');
  }

  db.transaction(() => {
    debit(userId, row.currency, row.amount_cents, 'payment', row.id, { db });
    transitionPayment(row.id, STATUS.AWAITING_PAYMENT, { db });
    transitionPayment(row.id, STATUS.PAID, { db });
  })();

  return row.id;
}
