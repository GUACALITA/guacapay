// HTTP routes for login: /api/auth/request-code, /verify-code, /me.
import { Router } from 'express';
import { createRateLimiter } from '../rate-limit.js';
import { requestLoginCode, verifyLoginCode } from './service.js';
import { issueToken, TOKEN_TTL_SECONDS } from './tokens.js';
import { requireAuth } from './middleware.js';

const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_REQUEST_LIMIT = 10;

// Turns an async handler's rejection into a call to next(err).
const route = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res)).catch(next);
};

export function createAuthRouter({ mailer }) {
  const router = Router();
  const limitByIp = createRateLimiter({
    windowMs: IP_WINDOW_MS,
    max: IP_REQUEST_LIMIT,
    message: 'Too many requests from this address. Try again later.',
  });

  // Same response whether or not the address already has an account.
  router.post(
    '/request-code',
    route(async (req, res) => {
      limitByIp(req.ip);
      await requestLoginCode((req.body ?? {}).email, { mailer });
      res.status(202).json({ ok: true, message: 'If the address is valid, a code has been sent.' });
    }),
  );

  router.post(
    '/verify-code',
    route(async (req, res) => {
      const body = req.body ?? {};
      const { userId } = verifyLoginCode(body.email, body.code);
      res.json({ token: issueToken(userId), tokenType: 'Bearer', expiresIn: TOKEN_TTL_SECONDS });
    }),
  );

  router.get('/me', requireAuth, (req, res) => {
    res.json({ id: req.user.id });
  });

  return router;
}
