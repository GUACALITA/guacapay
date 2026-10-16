// HTTP routes for the app balance: see it, and recharge it with Rapyd. Requires sign-in.
import { Router } from 'express';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { getDb } from '../db.js';
import { getBalances } from './service.js';
import { createPayment, toPublicPayment } from '../payments/service.js';
import { startCheckout } from '../payments/checkout.js';

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createBalanceRouter({ gateway = null } = {}) {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    route((req, res) => {
      res.json({ balances: getBalances(req.user.id) });
    }),
  );

  // A recharge is a payment to yourself. When Rapyd confirms it, the amount is added to the app balance.
  router.post(
    '/recharges',
    route(async (req, res) => {
      if (!gateway) {
        throw new AppError('gateway_not_configured', 503, 'Payment service is not configured.');
      }
      const user = getDb().prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
      const { payment } = createPayment({
        senderId: req.user.id,
        body: { recipient_email: user.email, amount_cents: req.body?.amount_cents, currency: req.body?.currency },
        idempotencyKey: req.get('Idempotency-Key'),
        purpose: 'recharge',
      });
      const returnUrl = `${config.returnBaseUrl}/payment.html?id=${encodeURIComponent(payment.id)}`;
      const { redirectUrl } = await startCheckout({ paymentId: payment.id, userId: req.user.id, gateway, returnUrl });
      res.status(201).json({ payment: toPublicPayment(payment), redirectUrl });
    }),
  );

  return router;
}
