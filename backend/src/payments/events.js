// In-process notifications for payment changes. Live status (WebSocket) listens here.
// Published only after the database transaction has finished, so subscribers never see an update that was rolled back.
import { EventEmitter } from 'node:events';

export const PAYMENT_UPDATED = 'payment.updated';

export const paymentEvents = new EventEmitter();

export function publishPaymentUpdated({ paymentId, status, at }) {
  paymentEvents.emit(PAYMENT_UPDATED, { paymentId, status, at });
}
