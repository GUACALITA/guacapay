// HTTP routes for consent grants: /api/grants. The callback comes back from the wallet, so it has no sign-in;
// its protection is the grant ID and the one-time nonce that the app created.
import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { finishConsent, requestConsent, revokeGrant } from './service.js';

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createGrantsRouter({ deps } = {}) {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    route(async (req, res) => {
      const body = req.body ?? {};
      const result = await requestConsent({
        userId: req.user.id,
        walletId: body.wallet_id,
        purpose: body.purpose,
        limitCents: body.limit_cents,
        interval: body.interval,
        deps,
      });
      res.status(201).json(result);
    }),
  );

  router.get(
    '/callback',
    route(async (req, res) => {
      const result = await finishConsent({
        grantId: req.query.grant,
        nonce: req.query.nonce,
        interactRef: req.query.interact_ref,
        deps,
      });
      // Redirect to return_to if it is the same origin, otherwise fall back to new.html.
      const raw = req.query.return_to ? String(req.query.return_to) : null;
      const sameOrigin = raw && (raw.startsWith('/') || raw.startsWith(config.baseUrl));
      const base = sameOrigin ? (raw.startsWith('/') ? `${config.baseUrl}${raw}` : raw) : `${config.baseUrl}/new.html`;
      const sep = base.includes('?') ? '&' : '?';
      res.redirect(`${base}${sep}grant=${encodeURIComponent(result.id)}&status=granted`);
    }),
  );

  router.post(
    '/:id/revoke',
    requireAuth,
    route((req, res) => {
      res.json(revokeGrant(req.user.id, req.params.id));
    }),
  );

  return router;
}
