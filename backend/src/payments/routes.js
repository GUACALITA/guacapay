// HTTP routes for payments: /api/payments. Every route requires a signed-in user.
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import {
  createPayment,
  getPaymentForUser,
  listPaymentsForUser,
  toPublicPayment,
} from './service.js';

// Express 4 does not forward errors thrown inside async handlers; this does.
const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createPaymentsRouter() {
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

  return router;
}
