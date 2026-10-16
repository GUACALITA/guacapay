// The only module that reads process.env (see docs/CONVENTIONS.md).
// Fails fast at startup if required values are missing or invalid.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const REQUIRED_SECRETS = ['JWT_SECRET', 'HMAC_SECRET', 'GATEWAY_TOKEN'];
const MIN_SECRET_LENGTH = 32;
const SECRET_NAME_PATTERN = /KEY|SECRET|PASS|TOKEN/i;

// Collect configuration problems first, so one run reports all of them.
// Messages name the variable but never print its value.
const problems = [];

for (const name of REQUIRED_SECRETS) {
  const value = process.env[name];
  if (!value) {
    problems.push(`${name} is required`);
  } else if (value.length < MIN_SECRET_LENGTH) {
    problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

function readInteger(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

const port = readInteger('APP_PORT', 3202, { min: 1, max: 65535 });
const minAmountCents = readInteger('PAYMENT_MIN_CENTS', 100, { min: 1, max: 1_000_000_000 });
const maxAmountCents = readInteger('PAYMENT_MAX_CENTS', 1_000_000, { min: 1, max: 1_000_000_000 });

if (minAmountCents > maxAmountCents) {
  problems.push('PAYMENT_MIN_CENTS must not be greater than PAYMENT_MAX_CENTS');
}

const currencies = (process.env.PAYMENT_CURRENCIES || 'USD')
  .split(',')
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`[config] ${problem}`);
  }
  process.exit(1);
}

const nodeEnv = process.env.NODE_ENV || 'development';

export const config = {
  version: pkg.version,
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port,
  frontendDir: join(here, '..', '..', 'frontend'),
  databasePath: process.env.DATABASE_PATH || join(here, '..', 'data', 'guacapay.db'),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3202').replace(/\/+$/, ''),
  jwtSecret: process.env.JWT_SECRET,
  hmacSecret: process.env.HMAC_SECRET,
  gateway: {
    url: (process.env.GATEWAY_URL || 'http://localhost:3203').replace(/\/+$/, ''),
    token: process.env.GATEWAY_TOKEN,
  },
  payments: {
    minAmountCents,
    maxAmountCents,
    currencies,
  },
  // Values of secret-like variables, used by the logger to mask them in output.
  // Short values are skipped: they would mask ordinary words.
  secretValues: Object.entries(process.env)
    .filter(([name, value]) => SECRET_NAME_PATTERN.test(name) && value && value.length >= 8)
    .map(([, value]) => value),
};
