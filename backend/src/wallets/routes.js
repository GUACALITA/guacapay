// HTTP routes for wallets: /api/wallets. Every route requires a signed-in user.
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { addWallet, listWallets, revokeWallet, toPublicWallet } from './service.js';

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createWalletsRouter({ readWallet } = {}) {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    route(async (req, res) => {
      const { wallet, created } = await addWallet(req.user.id, req.body?.wallet_url, { readWallet });
      res.status(created ? 201 : 200).json(toPublicWallet(wallet));
    }),
  );

  router.get(
    '/',
    route((req, res) => {
      res.json({ wallets: listWallets(req.user.id).map(toPublicWallet) });
    }),
  );

  router.post(
    '/:id/revoke',
    route((req, res) => {
      res.json(toPublicWallet(revokeWallet(req.user.id, req.params.id)));
    }),
  );

  return router;
}
