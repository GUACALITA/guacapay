// HTTP routes for deposits and withdrawals: /api/deposits and /api/withdrawals. Every route requires a signed-in user.
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { createDeposit, createWithdrawal, listDeposits, listWithdrawals, withdrawableCents } from './movements.js';

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

export function createDepositsRouter() {
  const router = Router();
  router.use(requireAuth);

  // Body: { wallet_id, amount_cents, currency }. Moves money from the user's wallet into custody.
  router.post(
    '/',
    route(async (req, res) => {
      res.status(201).json(await createDeposit({ userId: req.user.id, walletId: req.body?.wallet_id, body: req.body }));
    }),
  );

  router.get(
    '/',
    route((req, res) => {
      res.json({ deposits: listDeposits(req.user.id) });
    }),
  );

  return router;
}

export function createWithdrawalsRouter() {
  const router = Router();
  router.use(requireAuth);

  // Body: { wallet_id, amount_cents, currency }. Moves backed balance from custody to one of the user's own wallets.
  router.post(
    '/',
    route(async (req, res) => {
      res.status(201).json(await createWithdrawal({ userId: req.user.id, walletId: req.body?.wallet_id, body: req.body }));
    }),
  );

  router.get(
    '/',
    route((req, res) => {
      res.json({ withdrawals: listWithdrawals(req.user.id) });
    }),
  );

  // How much can be withdrawn now, in one currency.
  router.get(
    '/available',
    route((req, res) => {
      const currency = typeof req.query.currency === 'string' ? req.query.currency.toUpperCase() : '';
      res.json({ currency, withdrawable_cents: withdrawableCents(req.user.id, currency) });
    }),
  );

  return router;
}
