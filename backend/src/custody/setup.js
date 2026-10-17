// Makes the platform's custody wallets ready at startup, with nothing to set in .env.
// The default address is always set up. Per-currency addresses (CUSTODY_USD_ADDRESS etc.) are set up too when configured.
// Paying in works without owner approval; payouts out of custody need it.
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getWalletAddress } from '../providers/openpayments.js';
import { requestConsent, revokeGrant } from '../grants/service.js';

const PLATFORM_EMAIL = 'custody@platform.guacapay.internal';
const CUSTODY_LIMIT_CENTS = 100_000_000;

function platformUser(db) {
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(PLATFORM_EMAIL);
  if (row) return row.id;
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, PLATFORM_EMAIL);
  return id;
}

// Sets up one custody address: finds or creates its wallet row, requests consent if needed.
// Registers the address in config.custody.addressByCurrency once the currency is known.
async function ensureCustodyAddress(address, fallbackWalletId, { db, readWallet, consent }) {
  const existing = db.prepare("SELECT * FROM wallets WHERE wallet_url = ? AND status != 'revoked'").get(address);
  let walletId = fallbackWalletId;
  let userId;
  let row = existing || db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);

  if (existing) {
    walletId = existing.id;
    userId = existing.user_id;
    row = existing;
  } else {
    userId = platformUser(db);
  }

  if (!row) {
    const document = await readWallet(address);
    db.prepare(
      `INSERT INTO wallets (id, user_id, wallet_url, asset_code, asset_scale, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(walletId, userId, document.id, document.assetCode, document.assetScale, new Date().toISOString());
    row = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  }

  // Register this address for its currency so per-currency custody lookup works.
  if (row.asset_code) {
    config.custody.addressByCurrency[row.asset_code] = address;
  }

  const granted = db
    .prepare("SELECT id FROM grants WHERE wallet_id = ? AND status = 'granted' AND access_token_enc IS NOT NULL LIMIT 1")
    .get(walletId);
  if (row.status === 'linked' && granted) {
    return { ok: true, walletId };
  }

  const waiting = db.prepare("SELECT id FROM grants WHERE wallet_id = ? AND status = 'pending'").all(walletId);
  for (const grant of waiting) {
    revokeGrant(userId, grant.id, { db });
  }

  const result = await consent({ userId, walletId, purpose: 'link', limitCents: CUSTODY_LIMIT_CENTS, db });
  if (result.approvalUrl) {
    logger.warn('platform custody wallet needs one approval: open this link and approve it in the platform wallet', {
      approvalUrl: result.approvalUrl,
      address,
    });
    return { ok: false, reason: 'awaiting_owner_approval', walletId };
  }
  return { ok: result.status === 'granted', walletId };
}

export async function ensurePlatformCustody({ db = getDb(), readWallet = getWalletAddress, consent = requestConsent } = {}) {
  const address = config.custody.address;
  if (!address) {
    return { ok: false, reason: 'no_address' };
  }

  const result = await ensureCustodyAddress(address, config.custody.walletId, { db, readWallet, consent });
  // Keep config.custody.walletId in sync with the actual DB row (may have changed if the address already had a row).
  if (result.walletId) config.custody.walletId = result.walletId;

  // Set up any per-currency custody wallets that are different from the default.
  for (const [currency, extraAddress] of Object.entries(config.custody.addressByCurrency)) {
    if (extraAddress === address) continue; // already set up above
    const extraId = `platform-custody-${currency.toLowerCase()}`;
    await ensureCustodyAddress(extraAddress, extraId, { db, readWallet, consent }).catch((err) => {
      logger.error(`failed to set up ${currency} custody wallet`, { address: extraAddress, error: err.message });
    });
  }

  return result;
}
