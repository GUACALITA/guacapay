// HTTP routes for payments: /api/payments. Every route requires a signed-in user.
import { Router } from 'express';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import {
  createPayment,
  getPaymentForUser,
  listPaymentsForUser,
  toPublicPayment,
} from './service.js';
import { startCheckout } from './checkout.js';
import { payWithBalance } from '../balance/pay.js';
import { issueClaim } from '../claims/service.js';
import { unconfiguredMailer } from '../auth/mailer.js';
import { logger } from '../logger.js';

// Express 4 does not forward errors thrown inside async handlers; this does.
const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createPaymentsRouter({ gateway = null, mailer = unconfiguredMailer } = {}) {
  const router = Router();

  router.use(requireAuth);

  // Pays with the sender's app balance. Fails with insufficient_balance when it is not enough.
  router.post(
    '/:id/pay-with-balance',
    route(async (req, res) => {
      const paymentId = payWithBalance({ paymentId: req.params.id, userId: req.user.id });
      try {
        await issueClaim(paymentId, { mailer });
      } catch (err) {
        logger.warn('claim issue after balance payment failed', { paymentId, error: err.message });
      }
      res.json({ status: 'paid' });
    }),
  );

  // Paying with testnet balance needs the Open Payments transfer, which is not connected yet.
  router.post(
    '/:id/pay-with-testnet',
    route(() => {
      throw new AppError(
        'testnet_not_connected',
        503,
        'Paying with testnet balance is not connected yet. Pay with Rapyd or use your app balance.',
      );
    }),
  );

  router.post(
    '/',
    route((req, res) => {
      const { payment, created } = createPayment({
        senderId: req.user.id,
        body: req.body ?? {},
        idempotencyKey: req.get('Idempotency-Key'),
      });
      res.status(created ? 201 : 200).json(toPublicPayment(payment));
    }),
  );

  router.get(
    '/',
    route((req, res) => {
      res.json({ payments: listPaymentsForUser(req.user.id).map(toPublicPayment) });
    }),
  );

  router.get(
    '/:id',
    route((req, res) => {
      res.json(toPublicPayment(getPaymentForUser(req.params.id, req.user.id)));
    }),
  );

  // Starts the Rapyd checkout for a created payment and returns where to send the payer.
  router.post(
    '/:id/checkout',
    route(async (req, res) => {
      if (!gateway) {
        throw new AppError('gateway_not_configured', 503, 'Payment service is not configured.');
      }
      const returnUrl = `${config.returnBaseUrl}/payment.html?id=${encodeURIComponent(req.params.id)}`;
      const { redirectUrl } = await startCheckout({
        paymentId: req.params.id,
        userId: req.user.id,
        gateway,
        returnUrl,
      });
      res.json({ redirectUrl });
    }),
  );

  return router;
}
