// HTTP routes for subscriptions: /api/subscriptions.
// The offer token travels in the query string (GET) or the body (accept), never in the path: request paths are logged.
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { acceptOffer, cancelSubscription, createOffer, getPublicOffer, listSubscriptions } from './service.js';

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createSubscriptionsRouter() {
  const router = Router();

  // Anyone with the offer link: amount, interval and the payee's first name only.
  router.get(
    '/public',
    route((req, res) => {
      res.json(getPublicOffer(req.query.token));
    }),
  );

  // A signed-in payer accepts the offer from one of their linked wallets and receives the approval link.
  router.post(
    '/public/accept',
    requireAuth,
    route(async (req, res) => {
      const outcome = await acceptOffer({
        token: req.body?.token,
        payerId: req.user.id,
        walletId: req.body?.wallet_id,
      });
      res.json(outcome);
    }),
  );

  router.post(
    '/',
    requireAuth,
    route((req, res) => {
      const { subscription, link } = createOffer({ payeeId: req.user.id, body: req.body });
      res.status(201).json({ subscription, link });
    }),
  );

  router.get(
    '/',
    requireAuth,
    route((req, res) => {
      res.json({ subscriptions: listSubscriptions(req.user.id) });
    }),
  );

  router.post(
    '/:id/cancel',
    requireAuth,
    route((req, res) => {
      res.json(cancelSubscription({ userId: req.user.id, subscriptionId: req.params.id }));
    }),
  );

  return router;
}
