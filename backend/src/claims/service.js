// Claims: the recipient's link to a paid payment. Only a hash of the link token is stored.
import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { hashSecret } from '../hash.js';
import { logger } from '../logger.js';
import { normalizeEmail } from '../validation.js';
import { requestLoginCode, verifyLoginCode } from '../auth/service.js';
import { STATUS } from '../payments/states.js';
import { addPaymentEvent, transitionPayment } from '../payments/service.js';
import { payoutToRecipient, runPending } from '../transfers/payments.js';
import { TRANSFER_STATUS } from '../transfers/engine.js';
import { assertCustodyHolds, recordOut } from '../custody/service.js';

export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// open: link can be used. claiming: a transfer is in progress. claimed: used, for good.
export const CLAIM_STATUS = Object.freeze({ OPEN: 'open', CLAIMING: 'claiming', CLAIMED: 'claimed' });

const RESUME_BATCH_SIZE = 50;
const iso = (ms) => new Date(ms).toISOString();

function formatAmount(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function newClaimToken() {
  return randomBytes(32).toString('base64url');
}

export function claimLink(token) {
  return `${config.baseUrl}/claim.html?token=${encodeURIComponent(token)}`;
}

function findClaimByToken(token, db) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new AppError('claim_not_found', 404, 'This claim link is not valid.');
  }
  const claim = db.prepare('SELECT * FROM claims WHERE token_hash = ?').get(hashSecret(token));
  if (!claim) {
    throw new AppError('claim_not_found', 404, 'This claim link is not valid.');
  }
  return claim;
}

function assertUsable(claim, now) {
  if (claim.status === CLAIM_STATUS.CLAIMED) {
    throw new AppError('claim_used', 409, 'This claim has already been used.');
  }
  if (claim.status === CLAIM_STATUS.CLAIMING) {
    throw new AppError('claim_in_progress', 409, 'This claim is being processed.');
  }
  if (Date.parse(claim.expires_at) <= now) {
    throw new AppError('claim_expired', 410, 'This claim link has expired.');
  }
}

// Sends the claim link for a paid payment and makes the payment claimable.
// The link is sent first: if sending fails, no claim is kept, and the payment stays paid to be tried again.
export async function issueClaim(paymentId, { mailer, db = getDb(), now = Date.now() } = {}) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment || payment.status !== STATUS.PAID) {
    return { issued: false, reason: 'not_paid' };
  }

  // The link was already sent on an earlier attempt, so only the state needs to move.
  if (db.prepare('SELECT id FROM claims WHERE payment_id = ?').get(paymentId)) {
    transitionPayment(paymentId, STATUS.CLAIMABLE, { db });
    return { issued: true };
  }

  const token = newClaimToken();
  try {
    db.prepare('INSERT INTO claims (id, payment_id, token_hash, status, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      randomUUID(),
      paymentId,
      hashSecret(token),
      CLAIM_STATUS.OPEN,
      iso(now + CLAIM_TTL_MS),
    );
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Another attempt is already creating the claim.
      return { issued: false, reason: 'in_progress' };
    }
    throw err;
  }

  try {
    await mailer.sendClaimLink(payment.recipient_email, claimLink(token), {
      amountText: formatAmount(payment.amount_cents, payment.currency),
    });
  } catch (err) {
    db.prepare('DELETE FROM claims WHERE payment_id = ?').run(paymentId);
    logger.warn('claim link not sent', { paymentId, reason: err.code ?? 'send_failed' });
    return { issued: false, reason: 'email_failed' };
  }

  transitionPayment(paymentId, STATUS.CLAIMABLE, { db });
  return { issued: true };
}

// Catches paid payments that have no claim yet (for example after a failed send).
export async function issuePendingClaims({ mailer, db = getDb(), limit = 50 } = {}) {
  const rows = db.prepare('SELECT id FROM payments WHERE status = ? ORDER BY updated_at LIMIT ?').all(STATUS.PAID, limit);
  let issued = 0;
  for (const row of rows) {
    try {
      const result = await issueClaim(row.id, { mailer, db });
      if (result.issued) issued += 1;
    } catch (err) {
      logger.warn('claim issue failed', { paymentId: row.id, error: err.message });
    }
  }
  return { checked: rows.length, issued };
}

// Step 1 of claiming: the recipient proves the claim is theirs by email. A login code is sent to that address.
export async function verifyClaimEmail({ token, email, mailer, db = getDb(), now = Date.now() }) {
  const claim = findClaimByToken(token, db);
  assertUsable(claim, now);

  const payment = db.prepare('SELECT recipient_email FROM payments WHERE id = ?').get(claim.payment_id);
  const normalized = normalizeEmail(email);
  if (normalized !== payment.recipient_email) {
    throw new AppError('email_mismatch', 400, 'That email does not match this claim.');
  }

  await requestLoginCode(normalized, { mailer, db, now });
}

const WALLET_PATH_PATTERN = /^\/[^/]+$/;

// Only https addresses on a configured wallet host are accepted, so a claim cannot send money to an arbitrary site.
export function validateDestination(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new AppError('invalid_destination', 400, 'Enter a valid wallet address.');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AppError('invalid_destination', 400, 'Enter a valid wallet address.');
  }
  if (!config.claims.walletHosts.includes(url.hostname.toLowerCase()) || !WALLET_PATH_PATTERN.test(url.pathname)) {
    throw new AppError('invalid_destination', 400, 'That wallet address is not accepted here.');
  }
  return url.toString();
}

// Records the claim as used and moves the payment to completed. Called only when the payout completed.
function completeClaim(payment, claim, address, { db, now, transferId }) {
  db.transaction(() => {
    db.prepare('UPDATE claims SET status = ?, destination = ?, claimed_at = ? WHERE id = ?').run(
      CLAIM_STATUS.CLAIMED,
      address,
      iso(now),
      claim.id,
    );
    recordOut(db, { paymentId: payment.id, transferId, amountCents: payment.amount_cents, currency: payment.currency });
    transitionPayment(payment.id, STATUS.CLAIMED, { db });
    transitionPayment(payment.id, STATUS.COMPLETED, { db });
  })();
}

// Records the claim as used and moves the payment to failed. The money stays in custody.
function failClaim(payment, claim, address, reason, { db, now }) {
  db.transaction(() => {
    db.prepare('UPDATE claims SET status = ?, destination = ?, claimed_at = ? WHERE id = ?').run(
      CLAIM_STATUS.CLAIMED,
      address,
      iso(now),
      claim.id,
    );
    transitionPayment(payment.id, STATUS.CLAIMED, { db });
    transitionPayment(payment.id, STATUS.FAILED, { db });
    addPaymentEvent(payment.id, 'transfer.failed', { reason }, { db });
  })();
}

function normalizeWalletUrl(url) {
  return String(url ?? '').trim().toLowerCase().replace(/\/+$/, '');
}

// Step 2 of claiming: checks the code and destination, then runs the payout (custody to recipient) once.
// Outcomes: completed, failed (the payout was attempted and did not go through), or processing (it is still running;
// the claim stays in progress and resumePayouts settles it).
export async function confirmClaim({ token, code, destination, transfer = payoutToRecipient, mailer, db = getDb(), now = Date.now() }) {
  const claim = findClaimByToken(token, db);
  assertUsable(claim, now);

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(claim.payment_id);
  if (!payment || payment.status !== STATUS.CLAIMABLE) {
    throw new AppError('claim_not_available', 409, 'This payment is not ready to claim.');
  }

  // Both checks come before the code is used, so a typo in the wallet address does not spend the code.
  const address = validateDestination(destination);
  const senderWallets = db.prepare('SELECT wallet_url FROM wallets WHERE user_id = ?').all(payment.sender_id).map((w) => normalizeWalletUrl(w.wallet_url));
  if (senderWallets.includes(normalizeWalletUrl(address))) {
    throw new AppError('destination_is_sender', 400, 'Choose a wallet that is not the sender’s own account.');
  }
  // Checked before any money moves, and before the code is used: the custody ledger must hold this payment's amount.
  assertCustodyHolds(payment.id, { db });
  verifyLoginCode(payment.recipient_email, code, { db, now });

  // Only one request may start the transfer.
  const locked = db
    .prepare('UPDATE claims SET status = ? WHERE id = ? AND status = ?')
    .run(CLAIM_STATUS.CLAIMING, claim.id, CLAIM_STATUS.OPEN).changes;
  if (locked !== 1) {
    throw new AppError('claim_in_progress', 409, 'This claim is being processed.');
  }

  let sent;
  try {
    sent = await transfer({
      paymentId: payment.id,
      amountCents: payment.amount_cents,
      currency: payment.currency,
      destination: address,
    });
  } catch (err) {
    if (err.code === 'transfer_not_configured') {
      // Nothing was sent: reopen the claim so the recipient can try again.
      db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(CLAIM_STATUS.OPEN, claim.id);
      throw err;
    }
    if (err.retryable) {
      // The payout is still running. The claim stays in progress until resumePayouts settles it.
      return { status: 'processing' };
    }

    failClaim(payment, claim, address, err.code ?? 'unknown', { db, now });
    return { status: STATUS.FAILED };
  }

  completeClaim(payment, claim, address, { db, now, transferId: sent?.id ?? null });
  await notifySender(payment, { db, mailer });
  return { status: STATUS.COMPLETED };
}

// Finishes payouts that were still pending: the transfer runs again, and the claim settles when it ends.
export async function resumePayouts({ mailer, db = getDb(), deps, now = Date.now() } = {}) {
  const rows = db
    .prepare(
      `SELECT t.id AS transfer_id, t.payment_id, t.to_wallet_url
       FROM transfers t JOIN payments p ON p.id = t.payment_id
       WHERE t.direction = 'out' AND t.status = ? AND p.status = ?
       ORDER BY t.updated_at LIMIT ?`,
    )
    .all(TRANSFER_STATUS.PENDING, STATUS.CLAIMABLE, RESUME_BATCH_SIZE);

  let settled = 0;
  for (const row of rows) {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(row.payment_id);
    const claim = db.prepare('SELECT * FROM claims WHERE payment_id = ?').get(row.payment_id);
    const transfer = await runPending(row.transfer_id, { db, deps });

    if (transfer.status === TRANSFER_STATUS.COMPLETED) {
      completeClaim(payment, claim, row.to_wallet_url, { db, now, transferId: transfer.id });
      await notifySender(payment, { db, mailer });
      settled += 1;
    } else if (transfer.status === TRANSFER_STATUS.FAILED) {
      failClaim(payment, claim, row.to_wallet_url, transfer.failure_code, { db, now });
      settled += 1;
    }
  }
  return { checked: rows.length, settled };
}

// The payment is already completed, so a failed notification is logged and does not undo anything.
async function notifySender(payment, { db, mailer }) {
  if (!mailer) return;
  try {
    const sender = db.prepare('SELECT email FROM users WHERE id = ?').get(payment.sender_id);
    await mailer.sendPaymentConfirmation(sender.email, {
      amountText: formatAmount(payment.amount_cents, payment.currency),
      recipientEmail: payment.recipient_email,
    });
  } catch (err) {
    logger.warn('payment confirmation not sent', { paymentId: payment.id, reason: err.code ?? 'unknown' });
  }
}
