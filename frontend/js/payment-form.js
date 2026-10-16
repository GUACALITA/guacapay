// Checks the new-payment form in the browser. The backend checks again; this only saves a round trip
// and tells the user what to fix.
import { parseAmountToCents } from './money.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MESSAGE_MAX_LENGTH = 500;
const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Returns { errors, body }. `body` is only set when there are no errors.
export function validatePaymentForm(values, { currencies }) {
  const errors = {};

  const email = (values.recipientEmail ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    errors.recipientEmail = 'Enter a valid email address.';
  }

  const amountCents = parseAmountToCents(values.amount ?? '');
  if (amountCents === null) {
    errors.amount = 'Enter an amount greater than zero, with at most two decimals.';
  }

  const currency = (values.currency ?? '').trim().toUpperCase();
  if (!currencies.includes(currency)) {
    errors.currency = 'Choose a supported currency.';
  }

  const message = (values.message ?? '').trim();
  if (message.length > MESSAGE_MAX_LENGTH) {
    errors.message = `Keep the message to ${MESSAGE_MAX_LENGTH} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0) {
    return { errors, body: null };
  }

  return {
    errors,
    body: {
      recipient_email: email,
      amount_cents: amountCents,
      currency,
      ...(message ? { message } : {}),
    },
  };
}

// A key for one payment attempt. Sent as Idempotency-Key, so a retry cannot create a second payment.
// Uses crypto.getRandomValues, which works on plain http pages where randomUUID does not.
export function newIdempotencyKey(randomSource = globalThis.crypto) {
  const bytes = new Uint8Array(24);
  randomSource.getRandomValues(bytes);
  let key = '';
  for (const byte of bytes) {
    key += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  }
  return key;
}
