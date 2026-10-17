// Post-quantum signing layer — ML-DSA-65 (Dilithium3), NIST FIPS 204.
// Signs payment and flow records so tampering is detectable even against a quantum adversary.
// Key is derived deterministically from PQ_SEED env var (64 hex chars).
// Missing seed → PQ signing is skipped (sign returns null, verify always passes).
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

let _keys = null;

function getKeys() {
  if (_keys) return _keys;
  const seed = process.env.PQ_SEED;
  if (!seed || seed.length !== 64 || !/^[0-9a-fA-F]+$/.test(seed)) return null;
  const seedBytes = Buffer.from(seed, 'hex');
  _keys = ml_dsa65.keygen(seedBytes);
  return _keys;
}

export function getPqInfo() {
  const keys = getKeys();
  if (!keys) return { algorithm: 'ML-DSA-65', active: false, pubKeyBytes: 0 };
  return { algorithm: 'ML-DSA-65', active: true, pubKeyBytes: keys.publicKey.length };
}

// Canonical payload for a payment — used for both sign and verify.
function paymentMsg(paymentId, recipientEmail, amountCents, currency) {
  return `payment:${paymentId}:${recipientEmail}:${amountCents}:${currency}`;
}

export function signPayment(paymentId, recipientEmail, amountCents, currency) {
  const keys = getKeys();
  if (!keys) return null;
  const msg = Buffer.from(paymentMsg(paymentId, recipientEmail, amountCents, currency));
  return Buffer.from(ml_dsa65.sign(msg, keys.secretKey)).toString('hex');
}

export function verifyPaymentSig(paymentId, recipientEmail, amountCents, currency, sigHex) {
  if (!sigHex) return true; // no sig = old payment, pass through
  const keys = getKeys();
  if (!keys) return true; // no keys = skip verification
  try {
    const msg = Buffer.from(paymentMsg(paymentId, recipientEmail, amountCents, currency));
    const sig = Buffer.from(sigHex, 'hex');
    return ml_dsa65.verify(sig, msg, keys.publicKey);
  } catch {
    return false;
  }
}

// Canonical payload for a flow — used for both sign and verify.
function flowMsg(flowId, userId, type, configJson) {
  return `flow:${flowId}:${userId}:${type}:${configJson}`;
}

export function signFlow(flowId, userId, type, configJson) {
  const keys = getKeys();
  if (!keys) return null;
  const msg = Buffer.from(flowMsg(flowId, userId, type, configJson));
  return Buffer.from(ml_dsa65.sign(msg, keys.secretKey)).toString('hex');
}

export function verifyFlowSig(flowId, userId, type, configJson, sigHex) {
  if (!sigHex) return true;
  const keys = getKeys();
  if (!keys) return true;
  try {
    const msg = Buffer.from(flowMsg(flowId, userId, type, configJson));
    const sig = Buffer.from(sigHex, 'hex');
    return ml_dsa65.verify(sig, msg, keys.publicKey);
  } catch {
    return false;
  }
}
