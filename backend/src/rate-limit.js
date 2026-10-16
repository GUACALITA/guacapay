// Fixed-window rate limiter kept in memory. Counts reset when the process restarts.
import { AppError } from './errors.js';

const MAX_TRACKED_KEYS = 10000;

export function createRateLimiter({ windowMs, max, message }) {
  const windows = new Map();

  function prune(now) {
    for (const [key, entry] of windows) {
      if (now - entry.start >= windowMs) windows.delete(key);
    }
  }

  return function limit(key, now = Date.now()) {
    if (windows.size > MAX_TRACKED_KEYS) prune(now);

    const entry = windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return;
    }

    entry.count += 1;
    if (entry.count > max) {
      throw new AppError('rate_limited', 429, message);
    }
  };
}
