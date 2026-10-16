// Keyed hashing for secrets stored at rest (OTP codes, claim tokens).
// Uses HMAC-SHA256 with HMAC_SECRET, so a leaked database alone is not enough to check guesses.
import { createHmac } from 'node:crypto';
import { config } from './config.js';

export function hashSecret(value) {
  return createHmac('sha256', config.hmacSecret).update(String(value)).digest('hex');
}
