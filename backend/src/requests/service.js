// Payment requests: a user asks to be paid. The payer's money goes straight to the requester's wallet (no custody, no claim).
// A request is paid only when its transfer completes, and it can be paid once.
import { assertWalletCurrency } from '../wallets/service.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { hashSecret } from '../hash.js';
import { createTransfer, TRANSFER_STATUS } from '../transfers/engine.js';
import { runPending } from '../transfers/payments.js';

export const REQUEST_STATUS = Object.freeze({ OPEN: 'open', PAID: 'paid', CLOSED: 'closed' });

const NOTE_MAX_LENGTH = 200;
const DEFAULT_LIFETIME_HOURS = 7 * 24;
const MAX_LIFETIME_HOURS = 30 * 24;
const LIST_LIMIT = 100;
const RESUME_BATCH_SIZE = 50;

const iso = () => new Date().toISOString();
const newToken = () => randomBytes(32).toString('base64url');

export function requestLink(token) {
  return `${config.baseUrl}/request.html?token=${encodeURIComponent(token)}`;
}

function parseNewRequest(body) {
  const { minAmountCents, maxAmountCents, currencies } = config.payments;

  const amountCents = body.amount_cents;
  if (!Number.isSafeInteger(amountCents) || amountCents < minAmountCents || amountCents > maxAmountCents) {
    throw new AppError('invalid_amount', 400, `Amount must be a whole number of cents between ${minAmountCents} and ${maxAmountCents}.`);
  }

  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  if (!currencies.includes(currency)) {
    throw new AppError('invalid_currency', 400, 'Currency is not supported.');
  }

  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > NOTE_MAX_LENGTH) {
      throw new AppError('invalid_note', 400, `Note must be text of at most ${NOTE_MAX_LENGTH} characters.`);
    }
    note = body.note.trim() || null;
  }

  const hours = body.expires_in_hours ?? DEFAULT_LIFETIME_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_LIFETIME_HOURS) {
    throw new AppError('invalid_expiry', 400, `Expiry must be between 1 and ${MAX_LIFETIME_HOURS} hours.`);
  }

  return { amountCents, currency, note, hours };
}

// What the owner sees. Never the token or its hash.
function ownerView(row) {
  return {
    id: row.id,
    amount_cents: row.amount_cents,
    currency: row.currency,
    note: row.note,
    status: row.status,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
  };
}

// What anyone with the link sees: no wallet URL, email, or internal IDs.
function publicView(row) {
  const expired = row.status === REQUEST_STATUS.OPEN && Date.parse(row.expires_at) <= Date.now();
  return {
    amount_cents: row.amount_cents,
    currency: row.currency,
    note: row.note,
    status: expired ? 'expired' : row.status,
    expires_at: row.expires_at,
    owner_first_name: row.owner_first_name ?? null,
  };
}

// Creates a request and returns the link once. Only the hash of the token is stored, so the link cannot be shown again.
export function createRequest({ ownerId, body, db = getDb() }) {
  const data = body ?? {};
  const input = parseNewRequest(data);

  const wallet = typeof data.wallet_id === 'string'
    ? db.prepare("SELECT id, asset_code FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(data.wallet_id, ownerId)
    : undefined;
  if (!wallet) {
    throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets to receive the money.');
  }
  assertWalletCurrency(wallet, input.currency);

  const id = randomUUID();
  const token = newToken();
  const now = iso();
  const expiresAt = new Date(Date.now() + input.hours * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO payment_requests (id, owner_user_id, wallet_id, amount_cents, currency, note, status, token_hash, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, wallet.id, input.amountCents, input.currency, input.note, REQUEST_STATUS.OPEN, hashSecret(token), expiresAt, now, now);

  return { request: ownerView(getOwnedRow(db, id)), link: requestLink(token) };
}

function getOwnedRow(db, id) {
  return db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
}

export function listRequests(ownerId, { db = getDb() } = {}) {
  return db
    .prepare('SELECT * FROM payment_requests WHERE owner_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(ownerId, LIST_LIMIT)
    .map(ownerView);
}

// Only the owner can close, and only while nobody is paying it.
export function closeRequest(ownerId, requestId, { db = getDb() } = {}) {
  const row = db.prepare('SELECT * FROM payment_requests WHERE id = ? AND owner_user_id = ?').get(requestId, ownerId);
  if (!row) {
    throw new AppError('request_not_found', 404, 'Request not found.');
  }
  const changed = db
    .prepare("UPDATE payment_requests SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'open' AND paying_transfer_id IS NULL")
    .run(iso(), requestId).changes;
  if (changed !== 1) {
    throw new AppError('request_not_closable', 409, 'This request cannot be closed now.');
  }
  return ownerView(getOwnedRow(db, requestId));
}

// Looks a request up by its link token. Unknown tokens get the same answer as a missing request.
export function getPublicRequest(token, { db = getDb() } = {}) {
  const row = findByToken(token, db);
  return publicView(row);
}

function findByToken(token, db) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new AppError('request_not_found', 404, 'This payment request is not valid.');
  }
  const row = db
    .prepare(
      `SELECT r.*, u.first_name AS owner_first_name FROM payment_requests r
       JOIN users u ON u.id = r.owner_user_id WHERE r.token_hash = ?`,
    )
    .get(hashSecret(token));
  if (!row) {
    throw new AppError('request_not_found', 404, 'This payment request is not valid.');
  }
  return row;
}

function assertPayable(row, payerId) {
  if (row.owner_user_id === payerId) {
    throw new AppError('own_request', 409, 'You cannot pay your own request.');
  }
  if (row.status === REQUEST_STATUS.PAID) {
    throw new AppError('request_already_paid', 409, 'This request has already been paid.');
  }
  if (row.status === REQUEST_STATUS.CLOSED) {
    throw new AppError('request_closed', 409, 'This request is closed.');
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new AppError('request_expired', 410, 'This request has expired.');
  }
}

// Moves a request on from what its transfer reported. Only a completed transfer makes the request paid.
export function settleRequestTransfer(requestId, transfer, { db = getDb() } = {}) {
  return db.transaction(() => {
    if (transfer.status === TRANSFER_STATUS.COMPLETED) {
      const changed = db
        .prepare(
          "UPDATE payment_requests SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND paying_transfer_id = ? AND status = 'open'",
        )
        .run(iso(), iso(), requestId, transfer.id).changes;
      return changed === 1 ? { status: REQUEST_STATUS.PAID } : { status: getOwnedRow(db, requestId).status };
    }
    if (transfer.status === TRANSFER_STATUS.FAILED) {
      // The request is open again, so another payer can try.
      db.prepare(
        'UPDATE payment_requests SET paying_transfer_id = NULL, paid_by_user_id = NULL, updated_at = ? WHERE id = ? AND paying_transfer_id = ?',
      ).run(iso(), requestId, transfer.id);
      return { status: 'failed', reason: transfer.failure_code };
    }
    return { status: 'awaiting_payment', reason: transfer.failure_code };
  })();
}

// Pays a request from one of the payer's linked wallets. The first call starts the transfer; a repeat by the same payer resumes it.
export async function payRequest({ token, payerId, walletId, db = getDb(), deps } = {}) {
  const row = findByToken(token, db);

  if (row.paying_transfer_id) {
    if (row.paid_by_user_id !== payerId) {
      throw new AppError('request_in_progress', 409, 'Another payer is already paying this request.');
    }
    assertPayable(row, payerId);
    const transfer = await runPending(row.paying_transfer_id, { db, deps });
    return settleRequestTransfer(row.id, transfer, { db });
  }

  assertPayable(row, payerId);

  const payer = typeof walletId === 'string'
    ? db.prepare("SELECT id, asset_code FROM wallets WHERE id = ? AND user_id = ? AND status = 'linked'").get(walletId, payerId)
    : undefined;
  if (!payer) {
    throw new AppError('wallet_not_linked', 409, 'Choose one of your linked wallets to pay from.');
  }
  assertWalletCurrency(payer, row.currency);

  const requester = db.prepare("SELECT * FROM wallets WHERE id = ? AND status = 'linked'").get(row.wallet_id);
  if (!requester) {
    throw new AppError('request_wallet_unavailable', 409, 'The requester no longer has a linked wallet for this request.');
  }

  // The transfer row and the claim on the request are written together: only one payer can start.
  const transfer = db.transaction(() => {
    const created = createTransfer({
      requestId: row.id,
      fromWalletId: payer.id,
      toWalletUrl: requester.wallet_url,
      amountCents: row.amount_cents,
      currency: row.currency,
      direction: 'in',
      db,
    });
    const claimed = db
      .prepare(
        "UPDATE payment_requests SET paying_transfer_id = ?, paid_by_user_id = ?, updated_at = ? WHERE id = ? AND status = 'open' AND paying_transfer_id IS NULL",
      )
      .run(created.id, payerId, iso(), row.id).changes;
    if (claimed !== 1) {
      throw new AppError('request_in_progress', 409, 'Another payer is already paying this request.');
    }
    return created;
  })();

  const result = await runPending(transfer.id, { db, deps });
  return settleRequestTransfer(row.id, result, { db });
}

// Picks up request transfers that were still pending. Called by the poller.
export async function resumeRequests({ db = getDb(), deps } = {}) {
  const rows = db
    .prepare(
      `SELECT t.id AS transfer_id, t.request_id FROM transfers t
       JOIN payment_requests r ON r.id = t.request_id
       WHERE t.status = ? AND r.status = 'open' AND r.paying_transfer_id = t.id
       ORDER BY t.updated_at LIMIT ?`,
    )
    .all(TRANSFER_STATUS.PENDING, RESUME_BATCH_SIZE);

  let settled = 0;
  for (const row of rows) {
    const transfer = await runPending(row.transfer_id, { db, deps });
    if (settleRequestTransfer(row.request_id, transfer, { db }).status !== 'awaiting_payment') settled += 1;
  }
  return { checked: rows.length, settled };
}
