// Flows: parametrizable payment templates. Each type maps to a guacapay feature.
// Types: cobro (request), tanda (split+notify), vaca (pool), cuenta (split), suscripcion (subscription).
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { AppError } from '../errors.js';
import { signFlow, verifyFlowSig } from '../pqsec.js';

const VALID_TYPES = ['cobro', 'tanda', 'vaca', 'cuenta', 'suscripcion'];
const VALID_CURRENCIES = ['USD', 'COP', 'EUR', 'MXN'];
const LIST_LIMIT = 100;

function isoNow() {
  return new Date().toISOString();
}

// Validates and normalizes config per flow type.
function validateConfig(type, raw) {
  const cfg = typeof raw === 'object' && raw !== null ? raw : {};

  const amountCents = cfg.amount_cents != null ? Math.floor(Number(cfg.amount_cents)) : null;
  const currency = typeof cfg.currency === 'string' ? cfg.currency.trim().toUpperCase() : 'USD';
  const message = typeof cfg.message === 'string' ? cfg.message.slice(0, 500).trim() || null : null;
  const note = typeof cfg.note === 'string' ? cfg.note.slice(0, 200).trim() || null : null;

  if (!VALID_CURRENCIES.includes(currency)) {
    throw new AppError('invalid_currency', 400, 'Currency is not supported.');
  }

  if (type === 'cobro') {
    // cobro: fixed-amount payment link (optional amount = "pay what you want")
    if (amountCents !== null && (!Number.isFinite(amountCents) || amountCents < 1)) {
      throw new AppError('invalid_amount', 400, 'Amount must be a positive number of cents.');
    }
    return { amount_cents: amountCents, currency, message, note };
  }

  if (type === 'vaca') {
    // vaca / pool: collective goal; amount is the goal
    const goal = amountCents;
    return { goal_cents: goal, currency, message, note };
  }

  if (type === 'cuenta' || type === 'tanda') {
    // cuenta: split bill; tanda: rotating savings
    if (!Number.isFinite(amountCents) || amountCents < 1) {
      throw new AppError('invalid_amount', 400, 'Amount is required for this flow type.');
    }
    const people = Math.floor(Number(cfg.people ?? 0));
    if (!Number.isFinite(people) || people < 2 || people > 30) {
      throw new AppError('invalid_people', 400, 'People must be between 2 and 30.');
    }
    const emails = Array.isArray(cfg.emails)
      ? cfg.emails.map((e) => String(e).toLowerCase().trim()).filter(Boolean)
      : [];
    return { amount_cents: amountCents, currency, people, emails, message, note };
  }

  if (type === 'suscripcion') {
    // suscripcion: recurring charge
    if (!Number.isFinite(amountCents) || amountCents < 1) {
      throw new AppError('invalid_amount', 400, 'Amount is required for subscriptions.');
    }
    const intervalDays = Math.floor(Number(cfg.interval_days ?? 30));
    if (intervalDays < 1 || intervalDays > 365) {
      throw new AppError('invalid_interval', 400, 'interval_days must be 1–365.');
    }
    return { amount_cents: amountCents, currency, interval_days: intervalDays, message, note };
  }

  throw new AppError('invalid_type', 400, 'Unknown flow type.');
}

export function createFlow({ userId, type, title, config, db = getDb() }) {
  if (!VALID_TYPES.includes(type)) {
    throw new AppError('invalid_type', 400, `Flow type must be one of: ${VALID_TYPES.join(', ')}.`);
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new AppError('invalid_title', 400, 'Title is required.');
  }

  const cfg = validateConfig(type, config);
  const configJson = JSON.stringify(cfg);
  const id = randomUUID();
  const now = isoNow();
  const pqSig = signFlow(id, userId, type, configJson);

  db.prepare(
    `INSERT INTO flows (id, user_id, type, title, config_json, pq_sig, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(id, userId, type, title.trim(), configJson, pqSig, now);

  return db.prepare('SELECT * FROM flows WHERE id = ?').get(id);
}

export function listFlows(userId, { db = getDb() } = {}) {
  return db
    .prepare('SELECT * FROM flows WHERE user_id = ? AND status != ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, 'archived', LIST_LIMIT);
}

export function getFlow(id, userId, { db = getDb() } = {}) {
  const row = db.prepare('SELECT * FROM flows WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw new AppError('flow_not_found', 404, 'Flow not found.');
  return row;
}

export function updateFlow({ id, userId, title, config, status, db = getDb() }) {
  const existing = getFlow(id, userId, { db });

  const newTitle = title !== undefined ? (typeof title === 'string' ? title.trim() : existing.title) : existing.title;
  const newType = existing.type;
  const newCfg = config !== undefined ? validateConfig(newType, config) : JSON.parse(existing.config_json);
  const newCfgJson = JSON.stringify(newCfg);
  const newStatus = status !== undefined && ['active', 'paused', 'archived'].includes(status) ? status : existing.status;
  const pqSig = signFlow(id, userId, newType, newCfgJson);

  db.prepare(
    'UPDATE flows SET title = ?, config_json = ?, status = ?, pq_sig = ? WHERE id = ?',
  ).run(newTitle, newCfgJson, newStatus, pqSig, id);

  return db.prepare('SELECT * FROM flows WHERE id = ?').get(id);
}

export function archiveFlow(id, userId, { db = getDb() } = {}) {
  getFlow(id, userId, { db });
  db.prepare("UPDATE flows SET status = 'archived' WHERE id = ?").run(id);
}

// Increments run_count and sets last_run_at. Called when a flow creates a payment.
export function recordFlowRun(id, { db = getDb() } = {}) {
  db.prepare('UPDATE flows SET run_count = run_count + 1, last_run_at = ? WHERE id = ?').run(isoNow(), id);
}

// Verifies the PQ signature on a flow row. Returns true if valid or no sig.
export function verifyFlow(row) {
  return verifyFlowSig(row.id, row.user_id, row.type, row.config_json, row.pq_sig);
}

export function toPublicFlow(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    config: JSON.parse(row.config_json),
    status: row.status,
    run_count: row.run_count,
    last_run_at: row.last_run_at,
    created_at: row.created_at,
    pq_verified: verifyFlow(row),
  };
}
