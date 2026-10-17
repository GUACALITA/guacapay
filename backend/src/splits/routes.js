// HTTP routes for split payments: /api/splits. Every route requires a signed-in payer.
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { unconfiguredMailer } from '../auth/mailer.js';
import { createSplit, getSplit, listSplits } from './service.js';

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createSplitsRouter({ mailer = unconfiguredMailer } = {}) {
  const router = Router();
  router.use(requireAuth);

  // Body: { total_cents, currency, wallet_id, parts: [{ recipient_email, amount_cents }] }.
  // The Idempotency-Key header makes a repeated request return the first split instead of paying again.
  router.post(
    '/',
    route(async (req, res) => {
      const body = req.body ?? {};
      const { split, created } = await createSplit({
        payerId: req.user.id,
        body,
        walletId: body.wallet_id,
        idempotencyKey: req.get('Idempotency-Key'),
        mailer,
      });
      res.status(created ? 201 : 200).json(split);
    }),
  );

  router.get(
    '/',
    route((req, res) => {
      res.json({ splits: listSplits(req.user.id) });
    }),
  );

  router.get(
    '/:id',
    route((req, res) => {
      res.json(getSplit(req.user.id, req.params.id));
    }),
  );

  return router;
}
