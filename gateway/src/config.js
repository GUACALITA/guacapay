// The only module in the gateway that reads process.env (see docs/CONVENTIONS.md).
// Fails fast at startup if required values are missing or invalid.
import 'dotenv/config';

const MIN_TOKEN_LENGTH = 32;
const problems = [];

function requireValue(name, minLength = 1) {
  const value = process.env[name];
  if (!value) {
    problems.push(`${name} is required`);
    return undefined;
  }
  if (value.length < minLength) {
    problems.push(`${name} must be at least ${minLength} characters`);
  }
  return value;
}

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${name} must be true or false`);
  return fallback;
}

function readPort(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    problems.push(`${name} must be an integer between 1 and 65535`);
    return fallback;
  }
  return value;
}

const accessKey = requireValue('RAPYD_ACCESS_KEY');
const secretKey = requireValue('RAPYD_SECRET_KEY');
const gatewayToken = requireValue('GATEWAY_TOKEN', MIN_TOKEN_LENGTH);
const sandbox = readBoolean('RAPYD_SANDBOX', true);
const port = readPort('GATEWAY_PORT', 3203);

const country = (process.env.RAPYD_COUNTRY || 'CO').trim().toUpperCase();
if (!/^[A-Z]{2}$/.test(country)) {
  problems.push('RAPYD_COUNTRY must be a two-letter ISO country code');
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`[config] ${problem}`);
  }
  process.exit(1);
}

export const config = {
  port,
  gatewayToken,
  rapyd: {
    sandbox,
    baseUrl: sandbox ? 'https://sandboxapi.rapyd.net' : 'https://api.rapyd.net',
    accessKey,
    secretKey,
    country,
  },
};
