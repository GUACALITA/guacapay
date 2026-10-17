// Moves money between two test wallets, in legs: incoming payment at the receiver, quote, then outgoing payment at the sender.
// Each leg is stored before its call, so a retry reuses it. The engine reports the transfer's status; it never changes a payment.
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { AppError } from '../errors.js';
import { getAccessToken } from '../grants/service.js';
import * as openPayments from '../providers/openpayments.js';

export const TRANSFER_STATUS = Object.freeze({ PENDING: 'pending', COMPLETED: 'completed', FAILED: 'failed' });
const LEG = Object.freeze({ CREATED: 'created', COMPLETED: 'completed', FAILED: 'failed' });
const SCALE = 2;
const INCOMING_LIFETIME_MS = 10 * 60 * 1000;

// Failures that can be fixed and retried later; the transfer stays pending with the reason recorded.
// outgoing_state_unknown: the payment may exist, so it stays pending until someone checks it on the network.
const RETRYABLE = new Set([
  'openpayments_unavailable',
  'leg_timeout',
  'grant_expired',
  'no_active_grant',
  'sender_wallet_not_linked',
  'outgoing_state_unknown',
]);

const defaultDeps = {
  readWallet: openPayments.getWalletAddress,
  requestGrant: openPayments.requestNonInteractiveGrant,
  createIncoming: openPayments.createIncomingPayment,
  createQuote: openPayments.createQuote,
  createOutgoing: openPayments.createOutgoingPayment,
  getOutgoing: openPayments.getOutgoingPayment,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  pollTimeoutMs: 30000,
  pollIntervalMs: 1000,
};

const iso = () => new Date().toISOString();

export function getTransfer(id, { db = getDb() } = {}) {
  return db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
}

export function createTransfer({ paymentId, fromWalletId, toWalletUrl, amountCents, currency, db = getDb() }) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new AppError('invalid_amount', 400, 'The amount must be a positive whole number of cents.');
  }
  const id = randomUUID();
  const now = iso();
  db.prepare(
    `INSERT INTO transfers (id, payment_id, from_wallet_id, to_wallet_url, amount_cents, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, paymentId ?? null, fromWalletId, toWalletUrl, amountCents, currency, TRANSFER_STATUS.PENDING, now, now);
  return getTransfer(id, { db });
}

function legFor(db, transferId, kind) {
  return db.prepare('SELECT * FROM transfer_legs WHERE transfer_id = ? AND kind = ?').get(transferId, kind);
}

function saveLeg(db, transferId, kind, remoteId, status) {
  db.prepare(
    `INSERT INTO transfer_legs (id, transfer_id, kind, remote_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (transfer_id, kind) DO UPDATE SET remote_id = excluded.remote_id, status = excluded.status, updated_at = excluded.updated_at`,
  ).run(randomUUID(), transferId, kind, remoteId, status, iso(), iso());
}

function setTransferState(db, transferId, status, failureCode) {
  db.prepare('UPDATE transfers SET status = ?, failure_code = ?, updated_at = ? WHERE id = ?').run(
    status,
    failureCode ?? null,
    iso(),
    transferId,
  );
}

// Runs the legs in order. Returns 'completed', or null when the outgoing payment has not finished in time.
async function execute(transfer, deps, db) {
  const sender = db.prepare("SELECT * FROM wallets WHERE id = ? AND status = 'linked'").get(transfer.from_wallet_id);
  if (!sender) {
    throw new AppError('sender_wallet_not_linked', 409, 'The sending wallet is not linked.');
  }

  const grant = db
    .prepare("SELECT id FROM grants WHERE wallet_id = ? AND status = 'granted' ORDER BY granted_at DESC LIMIT 1")
    .get(sender.id);
  if (!grant) {
    throw new AppError('no_active_grant', 409, 'The sending wallet has no active permission.');
  }
  const senderToken = getAccessToken(grant.id, { db, now: deps.now() });

  const senderDoc = await deps.readWallet(sender.wallet_url);
  const receiverDoc = await deps.readWallet(transfer.to_wallet_url);
  const amountValue = String(transfer.amount_cents);

  // Asset check before any money call: both wallets must hold the transfer's currency at the supported scale.
  if (
    senderDoc.assetCode !== transfer.currency ||
    receiverDoc.assetCode !== transfer.currency ||
    senderDoc.assetScale !== SCALE ||
    receiverDoc.assetScale !== SCALE
  ) {
    throw new AppError('asset_mismatch', 422, 'The wallets do not hold the transfer currency at two decimal places.');
  }

  // Leg 1: incoming payment at the receiver.
  let incomingLeg = legFor(db, transfer.id, 'incoming');
  if (!incomingLeg) {
    const receiverToken = await deps.requestGrant({
      authServer: receiverDoc.authServer,
      access: [{ type: 'incoming-payment', actions: ['create', 'read', 'complete'] }],
    });
    if (!receiverToken) {
      throw new AppError('receiver_interaction_required', 422, 'The receiving wallet asks for approval, which is not supported here.');
    }
    const incoming = await deps.createIncoming({
      resourceServer: receiverDoc.resourceServer,
      accessToken: receiverToken,
      walletAddressId: receiverDoc.id,
      value: amountValue,
      assetCode: transfer.currency,
      assetScale: SCALE,
      expiresAt: new Date(deps.now() + INCOMING_LIFETIME_MS).toISOString(),
    });
    saveLeg(db, transfer.id, 'incoming', incoming.id, LEG.CREATED);
    incomingLeg = legFor(db, transfer.id, 'incoming');
  }

  // Leg 2: quote at the sender, priced to the incoming payment.
  let quoteLeg = legFor(db, transfer.id, 'quote');
  if (!quoteLeg) {
    const quoteToken = await deps.requestGrant({
      authServer: senderDoc.authServer,
      access: [{ type: 'quote', actions: ['create', 'read'] }],
    });
    if (!quoteToken) {
      throw new AppError('quote_interaction_required', 422, 'The sending wallet asks for approval for quotes, which is not supported here.');
    }
    const quote = await deps.createQuote({
      resourceServer: senderDoc.resourceServer,
      accessToken: quoteToken,
      walletAddressId: senderDoc.id,
      receiverId: incomingLeg.remote_id,
      value: amountValue,
      assetCode: transfer.currency,
      assetScale: SCALE,
    });
    saveLeg(db, transfer.id, 'quote', quote.id, LEG.CREATED);
    quoteLeg = legFor(db, transfer.id, 'quote');
  }

  // Leg 3: outgoing payment from the sender. The leg is stored before the call. If a retry finds it without an
  // answer, the payment may or may not exist, so the engine stops and does not send it a second time.
  let outgoingLeg = legFor(db, transfer.id, 'outgoing');
  if (!outgoingLeg) {
    saveLeg(db, transfer.id, 'outgoing', null, LEG.CREATED);
    try {
      const outgoing = await deps.createOutgoing({
        resourceServer: senderDoc.resourceServer,
        accessToken: senderToken,
        walletAddressId: senderDoc.id,
        quoteId: quoteLeg.remote_id,
      });
      saveLeg(db, transfer.id, 'outgoing', outgoing.id, LEG.CREATED);
    } catch (err) {
      if (err instanceof AppError && err.code === 'openpayments_rejected') {
        saveLeg(db, transfer.id, 'outgoing', null, LEG.FAILED);
      }
      throw err;
    }
    outgoingLeg = legFor(db, transfer.id, 'outgoing');
  }
  if (!outgoingLeg.remote_id) {
    throw new AppError('outgoing_state_unknown', 409, 'The outgoing payment may or may not exist. Check it on the test network before retrying.');
  }

  // Read the outgoing payment until it reports completed, or give up at the timeout.
  const deadline = deps.now() + deps.pollTimeoutMs;
  for (;;) {
    const outgoing = await deps.getOutgoing({ url: outgoingLeg.remote_id, accessToken: senderToken });
    const state = String(outgoing.state ?? '').toUpperCase();
    if (state === 'COMPLETED') {
      saveLeg(db, transfer.id, 'outgoing', outgoingLeg.remote_id, LEG.COMPLETED);
      return 'completed';
    }
    if (state === 'FAILED') {
      saveLeg(db, transfer.id, 'outgoing', outgoingLeg.remote_id, LEG.FAILED);
      throw new AppError('outgoing_failed', 422, 'The test network reported the payment as failed.');
    }
    if (deps.now() >= deadline) {
      return null;
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}

// Runs a transfer. Definitive failures mark it failed. Retryable ones leave it pending with the reason.
// Running a completed or failed transfer again changes nothing.
export async function runTransfer(transferId, { db = getDb(), deps: overrides = {} } = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const transfer = getTransfer(transferId, { db });
  if (!transfer) {
    throw new AppError('transfer_not_found', 404, 'Transfer not found.');
  }
  if (transfer.status !== TRANSFER_STATUS.PENDING) {
    return transfer;
  }

  try {
    const outcome = await execute(transfer, deps, db);
    if (outcome === 'completed') {
      setTransferState(db, transferId, TRANSFER_STATUS.COMPLETED, null);
    } else {
      setTransferState(db, transferId, TRANSFER_STATUS.PENDING, 'leg_timeout');
    }
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'internal_error';
    if (RETRYABLE.has(code) || code === 'internal_error') {
      setTransferState(db, transferId, TRANSFER_STATUS.PENDING, code);
    } else {
      setTransferState(db, transferId, TRANSFER_STATUS.FAILED, code);
    }
  }

  return getTransfer(transferId, { db });
}
