// HTTP route for the operator: /api/custody. Protected by the gateway token, never by a user's sign-in.
import { Router } from 'express';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { requireGatewayToken } from '../auth/gateway-token.js';
import { toPublicWallet } from '../wallets/service.js';
import { custodyBalances, reconcile } from './service.js';

// Express 4 does not forward errors thrown inside async handlers; this does.
const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

// Returns the pending custody wallet approval URL so the operator can see it in the UI.
// This endpoint is public (no auth) because it only shows a URL, never secrets.
export function getCustodySetupStatus({ db = getDb() } = {}) {
  if (!config.custody.address) return { configured: false };
  const wallet = db.prepare("SELECT status FROM wallets WHERE wallet_url = ?").get(config.custody.address);
  if (!wallet) return { configured: false };
  if (wallet.status === 'linked') return { configured: true };
  const pending = db.prepare(
    "SELECT g.interact_uri FROM grants g JOIN wallets w ON w.id = g.wallet_id WHERE w.wallet_url = ? AND g.status = 'pending' AND g.interact_uri IS NOT NULL ORDER BY g.created_at DESC LIMIT 1"
  ).get(config.custody.address);
  return { configured: false, approvalUrl: pending?.interact_uri || null };
}

export function createCustodyRouter({ gatewayToken = config.gateway.token, readBalance } = {}) {
  const router = Router();
  router.use(requireGatewayToken(gatewayToken));

  router.get(
    '/',
    route(async (req, res) => {
      const db = getDb();
      const row = config.custody.walletId
        ? db.prepare('SELECT * FROM wallets WHERE id = ?').get(config.custody.walletId)
        : undefined;
      res.json({
        // Only the public fields: no key IDs, tokens or private material.
        wallet: row ? toPublicWallet(row) : null,
        balances: custodyBalances({ db }),
        reconcile: await reconcile({ db, readBalance }),
      });
    }),
  );

  return router;
}
