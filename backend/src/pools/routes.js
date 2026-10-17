// HTTP routes for group pools: /api/pools. The join token travels in the query string or body, never in the path (request paths are logged).
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { contribute, createPool, getPublicPool, joinPool, listPools, startPool, viewPool } from './service.js';

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createPoolsRouter() {
  const router = Router();

  // Anyone with the link: the terms and the member count.
  router.get(
    '/public',
    route((req, res) => {
      res.json(getPublicPool(req.query.token));
    }),
  );

  // A signed-in user joins from one of their linked wallets and receives the approval link for their share.
  router.post(
    '/public/join',
    requireAuth,
    route(async (req, res) => {
      const outcome = await joinPool({
        token: req.body?.token,
        memberId: req.user.id,
        walletId: req.body?.wallet_id,
      });
      res.json(outcome);
    }),
  );

  router.post(
    '/',
    requireAuth,
    route((req, res) => {
      const { pool, link } = createPool({ organizerId: req.user.id, body: req.body });
      res.status(201).json({ pool, link });
    }),
  );

  router.get(
    '/',
    requireAuth,
    route((req, res) => {
      res.json({ pools: listPools(req.user.id) });
    }),
  );

  router.get(
    '/:id',
    requireAuth,
    route((req, res) => {
      res.json(viewPool({ userId: req.user.id, poolId: req.params.id }));
    }),
  );

  router.post(
    '/:id/start',
    requireAuth,
    route((req, res) => {
      res.json(startPool({ organizerId: req.user.id, poolId: req.params.id }));
    }),
  );

  router.post(
    '/:id/contribute',
    requireAuth,
    route(async (req, res) => {
      res.json(await contribute({ memberId: req.user.id, poolId: req.params.id }));
    }),
  );

  return router;
}
