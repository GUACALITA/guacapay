// HTTP routes for claims: /api/claims. No sign-in: the claim token is the proof of access.
import { Router } from 'express';
import { createRateLimiter } from '../rate-limit.js';
import { unconfiguredMailer } from '../auth/mailer.js';
import { confirmClaim, verifyClaimEmail } from './service.js';
import { payoutToRecipient } from '../transfers/payments.js';

const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_REQUEST_LIMIT = 20;

// Express 4 does not forward errors thrown inside async handlers; this does.
const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createClaimsRouter({ mailer = unconfiguredMailer, transfer = payoutToRecipient } = {}) {
  const router = Router();
  const limitByIp = createRateLimiter({
    windowMs: IP_WINDOW_MS,
    max: IP_REQUEST_LIMIT,
    message: 'Too many requests from this address. Try again later.',
  });

  router.post(
    '/verify-email',
    route(async (req, res) => {
      limitByIp(req.ip);
      const body = req.body ?? {};
      await verifyClaimEmail({ token: body.token, email: body.email, mailer });
      res.status(202).json({ ok: true, message: 'A code has been sent to the recipient email.' });
    }),
  );

  router.post(
    '/confirm',
    route(async (req, res) => {
      limitByIp(req.ip);
      const body = req.body ?? {};
      const result = await confirmClaim({
        token: body.token,
        code: body.code,
        destination: body.destinationWalletAddress,
        transfer,
        mailer,
      });
      res.json({ status: result.status });
    }),
  );

  return router;
}
