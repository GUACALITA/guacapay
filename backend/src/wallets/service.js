// Test wallets linked to users. A wallet address belongs to one user at a time.
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { AppError } from '../errors.js';
import { getWalletAddress as readPublicWallet } from '../providers/openpayments.js';

export const WALLET_STATUS = Object.freeze({ PENDING: 'pending', LINKED: 'linked', REVOKED: 'revoked' });

const iso = () => new Date().toISOString();

// What the owner may see. The key ID and any consent data never appear here.
export function toPublicWallet(row) {
  return {
    id: row.id,
    wallet_url: row.wallet_url,
    asset_code: row.asset_code,
    asset_scale: row.asset_scale,
    status: row.status,
    created_at: row.created_at,
    linked_at: row.linked_at,
  };
}

// Adds a wallet for a user. It stays `pending` until consent completes (prompt 20).
// Adding the same wallet again by the same user returns the existing row.
export async function addWallet(userId, rawUrl, { db = getDb(), readWallet = readPublicWallet } = {}) {
  const document = await readWallet(rawUrl);

  const active = db
    .prepare("SELECT * FROM wallets WHERE wallet_url = ? AND status != 'revoked'")
    .get(document.id);
  if (active) {
    if (active.user_id !== userId) {
      throw new AppError('wallet_in_use', 409, 'That wallet is already linked to another account.');
    }
    return { wallet: active, created: false };
  }

  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, document.id, document.assetCode, document.assetScale, WALLET_STATUS.PENDING, iso());
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new AppError('wallet_in_use', 409, 'That wallet is already linked to another account.');
    }
    throw err;
  }

  return { wallet: db.prepare('SELECT * FROM wallets WHERE id = ?').get(id), created: true };
}

export function listWallets(userId, { db = getDb() } = {}) {
  return db.prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY created_at, rowid').all(userId);
}

// Only the owner can revoke. Anyone else gets the same 404 as for a missing wallet.
export function revokeWallet(userId, walletId, { db = getDb() } = {}) {
  const row = db.prepare('SELECT * FROM wallets WHERE id = ? AND user_id = ?').get(walletId, userId);
  if (!row) {
    throw new AppError('wallet_not_found', 404, 'Wallet not found.');
  }
  db.prepare("UPDATE wallets SET status = 'revoked' WHERE id = ?").run(walletId);
  return db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
}

// Called by the consent step (prompt 20) once the wallet has approved access.
export function markWalletLinked(walletId, { db = getDb() } = {}) {
  db.prepare("UPDATE wallets SET status = 'linked', linked_at = ? WHERE id = ? AND status = 'pending'").run(
    iso(),
    walletId,
  );
  return db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
}
