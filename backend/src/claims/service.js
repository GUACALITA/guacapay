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

export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// open: link can be used. claiming: a transfer is in progress. claimed: used, for good.
export const CLAIM_STATUS = Object.freeze({ OPEN: 'open', CLAIMING: 'claiming', CLAIMED: 'claimed' });

const iso = (ms) => new Date(ms).toISOString();

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
    await mailer.sendClaimLink(payment.recipient_email, claimLink(token));
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

// Step 2 of claiming: checks the code and destination, then runs the transfer once.
// Outcomes: completed, or failed (the transfer was attempted and did not go through).
export async function confirmClaim({ token, code, destination, transfer, db = getDb(), now = Date.now() }) {
  const claim = findClaimByToken(token, db);
  assertUsable(claim, now);

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(claim.payment_id);
  if (!payment || payment.status !== STATUS.CLAIMABLE) {
    throw new AppError('claim_not_available', 409, 'This payment is not ready to claim.');
  }

  // Both checks come before the code is used, so a typo in the wallet address does not spend the code.
  const address = validateDestination(destination);
  verifyLoginCode(payment.recipient_email, code, { db, now });

  // Only one request may start the transfer.
  const locked = db
    .prepare('UPDATE claims SET status = ? WHERE id = ? AND status = ?')
    .run(CLAIM_STATUS.CLAIMING, claim.id, CLAIM_STATUS.OPEN).changes;
  if (locked !== 1) {
    throw new AppError('claim_in_progress', 409, 'This claim is being processed.');
  }

  try {
    await transfer({
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

    db.transaction(() => {
      db.prepare('UPDATE claims SET status = ?, destination = ?, claimed_at = ? WHERE id = ?').run(
        CLAIM_STATUS.CLAIMED,
        address,
        iso(now),
        claim.id,
      );
      transitionPayment(payment.id, STATUS.CLAIMED, { db });
      transitionPayment(payment.id, STATUS.FAILED, { db });
      addPaymentEvent(payment.id, 'transfer.failed', { reason: err.code ?? 'unknown' }, { db });
    })();
    return { status: STATUS.FAILED };
  }

  db.transaction(() => {
    db.prepare('UPDATE claims SET status = ?, destination = ?, claimed_at = ? WHERE id = ?').run(
      CLAIM_STATUS.CLAIMED,
      address,
      iso(now),
      claim.id,
    );
    transitionPayment(payment.id, STATUS.CLAIMED, { db });
    transitionPayment(payment.id, STATUS.COMPLETED, { db });
  })();
  return { status: STATUS.COMPLETED };
}
