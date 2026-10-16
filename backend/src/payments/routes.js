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

// Express 4 does not forward errors thrown inside async handlers; this does.
const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createPaymentsRouter({ gateway = null } = {}) {
  const router = Router();

  router.use(requireAuth);

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
