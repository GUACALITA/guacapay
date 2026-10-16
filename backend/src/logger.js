// Structured JSON logger. Masks secret values and secret-named fields.
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS.info;
const SENSITIVE_FIELD_PATTERN = /key|secret|pass|token|authorization/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 4;

function scrubText(text) {
  let out = String(text);
  for (const secret of config.secretValues) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

function scrubFields(fields, depth = 0) {
  const out = {};
  for (const [name, value] of Object.entries(fields)) {
    if (SENSITIVE_FIELD_PATTERN.test(name)) {
      out[name] = REDACTED;
    } else if (typeof value === 'string') {
      out[name] = scrubText(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value) && depth < MAX_DEPTH) {
      out[name] = scrubFields(value, depth + 1);
    } else {
      out[name] = value;
    }
  }
  return out;
}

function write(level, message, fields = {}) {
  if (LEVELS[level] < THRESHOLD) return;

  const entry = {
    time: new Date().toISOString(),
    level,
    msg: scrubText(message),
    ...scrubFields(fields),
  };
  const line = JSON.stringify(entry);

  if (LEVELS[level] >= LEVELS.warn) {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};
