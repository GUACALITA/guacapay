// The only module that reads process.env (see docs/CONVENTIONS.md).
// Fails fast at startup if required values are missing or invalid.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const REQUIRED_SECRETS = ['JWT_SECRET', 'HMAC_SECRET'];
const MIN_SECRET_LENGTH = 32;
const SECRET_NAME_PATTERN = /KEY|SECRET|PASS|TOKEN/i;
const DEFAULT_APP_PORT = 3202;

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

function readPort(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`${name} must be an integer between 1 and 65535`);
    return fallback;
  }
  return port;
}

const port = readPort('APP_PORT', DEFAULT_APP_PORT);

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
  jwtSecret: process.env.JWT_SECRET,
  hmacSecret: process.env.HMAC_SECRET,
  // Values of secret-like variables, used by the logger to mask them in output.
  // Short values are skipped: they would mask ordinary words.
  secretValues: Object.entries(process.env)
    .filter(([name, value]) => SECRET_NAME_PATTERN.test(name) && value && value.length >= 8)
    .map(([, value]) => value),
};
