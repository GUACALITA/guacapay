// HTTP routes for payment requests: /api/requests.
// The public link token travels in the query string (for GET) or the body (for pay), never in the path:
// request paths are written to the log, and the token must stay out of it.
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { createRequest, closeRequest, getPublicRequest, listRequests, payRequest } from './service.js';
import { requestQrPng } from './qr.js';

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createRequestsRouter() {
  const router = Router();

  // Anyone with the link: amount, note and the owner's first name only.
  router.get(
    '/public',
    route((req, res) => {
      res.json(getPublicRequest(req.query.token));
    }),
  );

  // A signed-in payer pays from one of their linked wallets.
  router.post(
    '/public/pay',
    requireAuth,
    route(async (req, res) => {
      const outcome = await payRequest({
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
    route(async (req, res) => {
      const { request, link } = createRequest({ ownerId: req.user.id, body: req.body });
      // Shown once, to the owner: the link and its QR code.
      res.status(201).json({ request, link, qr: await requestQrPng(link) });
    }),
  );

  router.get(
    '/',
    requireAuth,
    route((req, res) => {
      res.json({ requests: listRequests(req.user.id) });
    }),
  );

  router.post(
    '/:id/close',
    requireAuth,
    route((req, res) => {
      res.json(closeRequest(req.user.id, req.params.id));
    }),
  );

  return router;
}
