// One-time code login: request a code by email, verify it, create the user if needed.
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db.js';
import { hashSecret } from '../hash.js';
import { AppError } from '../errors.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const EMAIL_WINDOW_MS = 15 * 60 * 1000;
export const EMAIL_REQUEST_LIMIT = 3;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^\d{6}$/;

// One message for wrong, expired, used, and unknown codes, so the response reveals nothing.
const invalidCode = () => new AppError('invalid_code', 401, 'The code is invalid or has expired.');

export function normalizeEmail(raw) {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AppError('invalid_email', 400, 'Enter a valid email address.');
  }
  return email;
}

// randomInt uses a cryptographically secure source.
export function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function sameHash(storedHex, candidateHex) {
  const stored = Buffer.from(storedHex, 'hex');
  const candidate = Buffer.from(candidateHex, 'hex');
  return stored.length === candidate.length && stored.length > 0 && timingSafeEqual(stored, candidate);
}

export async function requestLoginCode(rawEmail, { mailer, db = getDb(), now = Date.now() } = {}) {
  const email = normalizeEmail(rawEmail);

  const recent = db
    .prepare('SELECT COUNT(*) AS n FROM otp_codes WHERE email = ? AND created_at >= ?')
    .get(email, isoAt(now - EMAIL_WINDOW_MS)).n;
  if (recent >= EMAIL_REQUEST_LIMIT) {
    throw new AppError('rate_limited', 429, 'Too many code requests. Try again later.');
  }

  const code = generateCode();
  db.transaction(() => {
    // A new code replaces any code still pending for this address.
    db.prepare('UPDATE otp_codes SET used_at = ? WHERE email = ? AND used_at IS NULL').run(isoAt(now), email);
    db.prepare('INSERT INTO otp_codes (id, email, code_hash, expires_at) VALUES (?, ?, ?, ?)').run(
      randomUUID(),
      email,
      hashSecret(code),
      isoAt(now + CODE_TTL_MS),
    );
  })();

  await mailer.sendLoginCode(email, code);
}

export function verifyLoginCode(rawEmail, rawCode, { db = getDb(), now = Date.now() } = {}) {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode : '';

  // Only the newest pending code counts.
  const pending = db
    .prepare('SELECT * FROM otp_codes WHERE email = ? AND used_at IS NULL ORDER BY rowid DESC LIMIT 1')
    .get(email);

  if (!pending || Date.parse(pending.expires_at) <= now) {
    throw invalidCode();
  }

  // Checked before the code itself, so a correct code is also blocked after too many wrong ones.
  if (pending.attempts >= MAX_CODE_ATTEMPTS) {
    throw new AppError('too_many_attempts', 429, 'Too many wrong codes. Request a new code.');
  }

  if (!CODE_PATTERN.test(code) || !sameHash(pending.code_hash, hashSecret(code))) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(pending.id);
    throw invalidCode();
  }

  return db.transaction(() => {
    db.prepare('UPDATE otp_codes SET used_at = ? WHERE id = ?').run(isoAt(now), pending.id);
    db.prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)').run(randomUUID(), email);
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    return { userId: user.id };
  })();
}
