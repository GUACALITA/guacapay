// Input checks shared by several modules.
import { AppError } from './errors.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Trims and lowercases an email address, or throws a 400 error.
export function normalizeEmail(raw) {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AppError('invalid_email', 400, 'Enter a valid email address.');
  }
  return email;
}
