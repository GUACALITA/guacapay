// Consent grants: a wallet approves the app to move money from it, once. The approval is kept, encrypted, for later use.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { continueGrant, getWalletAddress, startGrant } from '../providers/openpayments.js';
import { markWalletLinked } from '../wallets/service.js';
import { open, seal } from './seal.js';

export const GRANT_PURPOSES = Object.freeze(['link', 'recurring']);
export const GRANT_STATUS = Object.freeze({ PENDING: 'pending', GRANTED: 'granted', EXPIRED: 'expired', REVOKED: 'revoked' });

const SUPPORTED_SCALE = 2;
const INTERVAL_PATTERN = /^R\/[^/]+\/P[^/]+$/;
const MAX_LIMIT_CENTS = 1_000_000_000;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();

const defaultDeps = { readWallet: getWalletAddress, startGrant, continueGrant };

// Builds the permission asked from the wallet: outgoing payments up to a limit, optionally repeating.
function buildAccess(walletUrl, assetCode, limitCents, interval) {
  const limits = {
    debitAmount: { assetCode, assetScale: SUPPORTED_SCALE, value: String(limitCents) },
  };
  if (interval) limits.interval = interval;
  return [{ type: 'outgoing-payment', actions: ['create', 'read', 'list'], identifier: walletUrl, limits }];
}

function ownedWallet(userId, walletId, db) {
  const wallet = db.prepare("SELECT * FROM wallets WHERE id = ? AND user_id = ? AND status != 'revoked'").get(walletId, userId);
  if (!wallet) throw new AppError('wallet_not_found', 404, 'Wallet not found.');
  return wallet;
}

// Starts consent. Returns the approval URL the user must open in their wallet. The grant stays pending until it is finished.
export async function requestConsent({ userId, walletId, purpose, limitCents, interval, returnTo = null, db = getDb(), deps = defaultDeps }) {
  if (!GRANT_PURPOSES.includes(purpose)) {
    throw new AppError('invalid_purpose', 400, 'Purpose must be link or recurring.');
  }
  if (!Number.isSafeInteger(limitCents) || limitCents < 1 || limitCents > MAX_LIMIT_CENTS) {
    throw new AppError('invalid_limit', 400, 'The limit must be a positive whole number of cents.');
  }
  if (interval !== undefined && interval !== null && !INTERVAL_PATTERN.test(String(interval))) {
    throw new AppError('invalid_interval', 400, 'The interval must be an ISO 8601 repeating interval, for example R/2026-11-01T00:00:00Z/P1M.');
  }
  if (purpose === 'recurring' && !interval) {
    throw new AppError('invalid_interval', 400, 'A recurring grant needs an interval.');
  }

  const wallet = ownedWallet(userId, walletId, db);
  const document = await deps.readWallet(wallet.wallet_url);
  if (document.assetScale !== SUPPORTED_SCALE) {
    throw new AppError('asset_scale_unsupported', 422, 'Only wallets with two decimal places are supported for now.');
  }

  const grantId = randomUUID();
  const nonce = randomBytes(16).toString('hex');
  const returnToParam = returnTo ? `&return_to=${encodeURIComponent(String(returnTo))}` : '';
  const finishUri = `${config.baseUrl}/api/grants/callback?grant=${grantId}&nonce=${nonce}${returnToParam}`;
  const access = buildAccess(wallet.wallet_url, document.assetCode, limitCents, interval || null);

  const pending = await deps.startGrant({ authServer: document.authServer, access, finishUri, nonce });

  // A wallet may grant without asking the user. Then the grant is finished at once.
  if (!pending.interact) {
    if (!pending.access_token) {
      throw new AppError('openpayments_rejected', 422, 'The wallet did not return a grant.');
    }
    db.transaction(() => {
      insertGrant(db, { grantId, walletId, purpose, access, limitCents, interval, nonce, continueUri: null, continueTokenEnc: null });
      storeAccessToken(db, grantId, pending.access_token.value, pending.access_token.expires_in);
      if (purpose === 'link') markWalletLinked(walletId, { db });
    })();
    return { id: grantId, status: GRANT_STATUS.GRANTED, approvalUrl: null };
  }

  insertGrant(db, {
    grantId,
    walletId,
    purpose,
    access,
    limitCents,
    interval,
    nonce,
    continueUri: pending.continue.uri,
    continueTokenEnc: seal(pending.continue.access_token.value),
  });
  return { id: grantId, status: GRANT_STATUS.PENDING, approvalUrl: pending.interact.redirect };
}

function insertGrant(db, row) {
  db.prepare(
    `INSERT INTO grants (id, wallet_id, purpose, status, access_limits_json, continue_uri, continue_token_enc, nonce_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.grantId,
    row.walletId,
    row.purpose,
    GRANT_STATUS.PENDING,
    JSON.stringify({ access: row.access, limitCents: row.limitCents, interval: row.interval || null }),
    row.continueUri,
    row.continueTokenEnc,
    sha256(row.nonce),
    iso(),
  );
}

function storeAccessToken(db, grantId, token, expiresInSeconds) {
  const expiresAt = Number.isFinite(expiresInSeconds) ? new Date(Date.now() + expiresInSeconds * 1000).toISOString() : null;
  db.prepare(
    `UPDATE grants SET status = ?, access_token_enc = ?, granted_at = ?, expires_at = ?, continue_token_enc = NULL, continue_uri = NULL
     WHERE id = ?`,
  ).run(GRANT_STATUS.GRANTED, seal(token), iso(), expiresAt, grantId);
}

// Finishes consent after the wallet sent the user back with interact_ref. The nonce must match, and a grant finishes once.
export async function finishConsent({ grantId, nonce, interactRef, db = getDb(), deps = defaultDeps }) {
  const row = db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId);
  if (!row) throw new AppError('grant_not_found', 404, 'Grant not found.');
  if (row.status !== GRANT_STATUS.PENDING) {
    throw new AppError('grant_not_pending', 409, 'This approval was already used or cancelled.');
  }
  if (typeof nonce !== 'string' || sha256(nonce) !== row.nonce_hash) {
    throw new AppError('invalid_nonce', 400, 'The approval link is not valid.');
  }
  if (typeof interactRef !== 'string' || interactRef.length === 0) {
    throw new AppError('invalid_interaction', 400, 'The approval link is missing its reference.');
  }

  const continued = await deps.continueGrant({
    continueUri: row.continue_uri,
    continueToken: open(row.continue_token_enc),
    interactRef,
  });
  if (!continued.access_token) {
    throw new AppError('openpayments_rejected', 422, 'The wallet did not approve the grant.');
  }

  db.transaction(() => {
    storeAccessToken(db, grantId, continued.access_token.value, continued.access_token.expires_in);
    if (row.purpose === 'link') markWalletLinked(row.wallet_id, { db });
  })();

  return { id: grantId, walletId: row.wallet_id, status: GRANT_STATUS.GRANTED };
}

// Returns a usable access token for a granted permission, or refuses. Expired grants are marked expired.
export function getAccessToken(grantId, { db = getDb(), now = Date.now() } = {}) {
  const row = db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId);
  if (!row) throw new AppError('grant_not_found', 404, 'Grant not found.');
  if (row.status !== GRANT_STATUS.GRANTED || !row.access_token_enc) {
    throw new AppError('grant_not_granted', 409, 'This permission is not active.');
  }
  if (row.expires_at && Date.parse(row.expires_at) <= now) {
    db.prepare("UPDATE grants SET status = 'expired', access_token_enc = NULL WHERE id = ?").run(grantId);
    throw new AppError('grant_expired', 409, 'This permission has expired. Approve it again.');
  }
  return open(row.access_token_enc);
}

// The owner revokes a permission. The stored token is removed. Revocation at the wallet is a separate step, not yet built.
export function revokeGrant(userId, grantId, { db = getDb() } = {}) {
  const row = db
    .prepare('SELECT g.* FROM grants g JOIN wallets w ON w.id = g.wallet_id WHERE g.id = ? AND w.user_id = ?')
    .get(grantId, userId);
  if (!row) throw new AppError('grant_not_found', 404, 'Grant not found.');

  db.prepare(
    "UPDATE grants SET status = 'revoked', access_token_enc = NULL, continue_token_enc = NULL, continue_uri = NULL WHERE id = ?",
  ).run(grantId);
  return db.prepare('SELECT id, wallet_id, purpose, status, granted_at, expires_at FROM grants WHERE id = ?').get(grantId);
}
