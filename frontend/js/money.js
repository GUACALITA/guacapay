// Money as whole cents. Text is parsed as text, so no floating-point rounding happens.

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

// "12" -> 1200, "12.5" -> 1250, "12.50" -> 1250. Returns null for anything else, including zero,
// negative numbers, more than two decimals, and text that is not a number.
export function parseAmountToCents(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return null;

  const whole = Number(match[1]);
  const fraction = match[2] ? Number(match[2].padEnd(2, '0')) : 0;
  const cents = whole * 100 + fraction;

  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

export function formatCents(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
