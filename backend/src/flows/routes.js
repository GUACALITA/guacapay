// REST endpoints for parametrizable payment flows.
// All routes require authentication. The flow owner is always req.user.id.
import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import { normalizeEmail } from '../validation.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { escapeHtml } from '../email/render.js';
import { createFlow, listFlows, getFlow, updateFlow, archiveFlow, recordFlowRun, toPublicFlow } from './service.js';
import { getPqInfo } from '../pqsec.js';

const MAX_NOTIFY_EMAILS = 20;

const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

function formatAmount(cents, currency) {
  if (!cents) return null;
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function createFlowsRouter({ mailer } = {}) {
  const router = Router();

  router.use(requireAuth);

  // GET /api/flows — list all active/paused flows for the current user
  router.get(
    '/',
    route(async (req, res) => {
      const rows = listFlows(req.user.id);
      res.json({ flows: rows.map(toPublicFlow), pq: getPqInfo() });
    }),
  );

  // POST /api/flows — create a new flow
  router.post(
    '/',
    route(async (req, res) => {
      const { type, title, config } = req.body ?? {};
      if (!type || !title) {
        throw new AppError('missing_fields', 400, 'type and title are required.');
      }
      const row = createFlow({ userId: req.user.id, type, title, config });
      res.status(201).json({ flow: toPublicFlow(row) });
    }),
  );

  // GET /api/flows/:id
  router.get(
    '/:id',
    route(async (req, res) => {
      const row = getFlow(req.params.id, req.user.id);
      res.json({ flow: toPublicFlow(row) });
    }),
  );

  // PATCH /api/flows/:id — update title, config, or status
  router.patch(
    '/:id',
    route(async (req, res) => {
      const { title, config, status } = req.body ?? {};
      const row = updateFlow({ id: req.params.id, userId: req.user.id, title, config, status });
      res.json({ flow: toPublicFlow(row) });
    }),
  );

  // DELETE /api/flows/:id — archive (soft delete)
  router.delete(
    '/:id',
    route(async (req, res) => {
      archiveFlow(req.params.id, req.user.id);
      res.json({ ok: true });
    }),
  );

  // POST /api/flows/:id/run — mark the flow as run (increment counter)
  router.post(
    '/:id/run',
    route(async (req, res) => {
      const row = getFlow(req.params.id, req.user.id);
      if (row.status !== 'active') {
        throw new AppError('flow_not_active', 400, 'This flow is not active.');
      }
      recordFlowRun(req.params.id);
      res.json({ ok: true, flow: toPublicFlow(getFlow(req.params.id, req.user.id)) });
    }),
  );

  // POST /api/flows/:id/notify — send the flow invitation to one or more email addresses
  router.post(
    '/:id/notify',
    route(async (req, res) => {
      if (!mailer) {
        throw new AppError('mailer_not_configured', 503, 'Email is not available.');
      }

      const row = getFlow(req.params.id, req.user.id);
      if (row.status !== 'active') {
        throw new AppError('flow_not_active', 400, 'This flow is not active.');
      }

      // Collect and validate email list
      const rawEmails = Array.isArray(req.body?.emails) ? req.body.emails : [];
      if (rawEmails.length === 0) {
        throw new AppError('missing_emails', 400, 'Provide at least one recipient email.');
      }
      if (rawEmails.length > MAX_NOTIFY_EMAILS) {
        throw new AppError('too_many_emails', 400, `Max ${MAX_NOTIFY_EMAILS} recipients per send.`);
      }

      const emails = rawEmails.map((e) => normalizeEmail(String(e)));

      // Get sender's email from the DB
      const db = getDb();
      const sender = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
      const senderEmail = sender?.email ?? 'guacapay user';

      // Build email details from the flow config
      const cfg = JSON.parse(row.config_json);
      const amountText = formatAmount(cfg.amount_cents ?? cfg.goal_cents, cfg.currency);
      const amountLine = amountText ? `Amount: ${amountText}` : '';
      const amountBlock = amountText
        ? `<p style="margin:0 0 6px;font-size:.85rem;color:#8b9ab5">AMOUNT</p><p style="margin:0 0 20px;font-size:1.1rem;font-weight:700;color:#00e898">${escapeHtml(amountText)}</p>`
        : '';
      const msgText = cfg.message ?? '';
      const messageBlock = msgText
        ? `<p style="margin:0 0 6px;font-size:.85rem;color:#8b9ab5">MESSAGE</p><p style="margin:0 0 20px;font-size:.9rem;color:#e8edf4">${escapeHtml(msgText)}</p>`
        : '';

      const details = {
        senderEmail,
        flowTitle: row.title,
        flowType: row.type.charAt(0).toUpperCase() + row.type.slice(1),
        amountLine,
        amountBlock,
        messageBlock,
        message: msgText,
        baseUrl: config.baseUrl,
      };

      // Send to all recipients; collect per-address results
      const sent = [];
      const failed = [];
      for (const email of emails) {
        try {
          await mailer.sendFlowInvite(email, details);
          sent.push(email);
        } catch (err) {
          logger.warn('flow invite not sent', { flowId: row.id, reason: err.code ?? 'unknown' });
          failed.push(email);
        }
      }

      recordFlowRun(req.params.id);
      res.json({ ok: true, sent, failed, flow: toPublicFlow(getFlow(req.params.id, req.user.id)) });
    }),
  );

  return router;
}
