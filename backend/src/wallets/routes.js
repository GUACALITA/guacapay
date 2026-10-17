// HTTP routes for wallets: /api/wallets. Every route requires a signed-in user.
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { addWallet, listWallets, revokeWallet, toPublicWallet } from './service.js';
import { getDb } from '../db.js';
import { requestConsent, revokeGrant } from '../grants/service.js';

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

  // Revokes the wallet's existing grants and asks the wallet for a new one.
  // Returns { approvalUrl } so the caller can redirect the user there.
  // Optional body: { return_to, limit_cents }
  router.post(
    '/:id/renew-consent',
    route(async (req, res) => {
      const db = getDb();
      const walletId = req.params.id;
      const returnTo = req.body?.return_to ?? null;
      const limitCents = Number.isInteger(req.body?.limit_cents) ? req.body.limit_cents : 1_000_000;

      const old = db.prepare("SELECT id FROM grants WHERE wallet_id = ? AND status != 'revoked'").all(walletId);
      for (const g of old) revokeGrant(req.user.id, g.id, { db });

      const result = await requestConsent({
        userId: req.user.id,
        walletId,
        purpose: 'link',
        limitCents,
        returnTo,
        db,
      });
      res.json(result);
    }),
  );

  return router;
}
