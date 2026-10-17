// The only module that reads process.env (see docs/CONVENTIONS.md).
// Fails fast at startup if required values are missing or invalid.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

// Secrets the operator does not have to supply. If a variable is not set, a random value is generated once and kept
// in the data folder (next to the database, never in the repository). A value set in the environment always wins.
const GENERATED_SECRETS = ['JWT_SECRET', 'HMAC_SECRET', 'GATEWAY_TOKEN', 'GRANT_ENCRYPTION_KEY'];

function provideGeneratedSecrets() {
  const dataDir = dirname(process.env.DATABASE_PATH || join(here, '..', 'data', 'guacapay.db'));
  const file = join(dataDir, 'generated-secrets.json');
  let stored = {};
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      stored = {};
    }
  }

  let changed = false;
  for (const name of GENERATED_SECRETS) {
    if (process.env[name]) continue;
    if (!stored[name]) {
      stored[name] = randomBytes(32).toString('hex');
      changed = true;
    }
    process.env[name] = stored[name];
  }

  if (changed) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
  }
}

provideGeneratedSecrets();

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

// Sandbox is the default. The app only reports this to the browser, to show a banner; the gateway uses it for real calls.
function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${name} must be true or false`);
  return fallback;
}

const sandbox = readBoolean('RAPYD_SANDBOX', true);

// Which rail moves money into the app. Open Payments (test network) is the only one in the product scope.
// "rapyd" keeps the card checkout and recharge available for development (decision 017).
const RAILS = ['openpayments', 'rapyd'];
const paymentRails = process.env.PAYMENT_RAILS || 'openpayments';
if (!RAILS.includes(paymentRails)) {
  problems.push(`PAYMENT_RAILS must be one of: ${RAILS.join(', ')}`);
}
const minAmountCents = readInteger('PAYMENT_MIN_CENTS', 100, { min: 1, max: 1_000_000_000 });
const maxAmountCents = readInteger('PAYMENT_MAX_CENTS', 1_000_000, { min: 1, max: 1_000_000_000 });

if (minAmountCents > maxAmountCents) {
  problems.push('PAYMENT_MIN_CENTS must not be greater than PAYMENT_MAX_CENTS');
}

// Wallet hosts a claim may pay out to. Testnet only until the transfer is approved for production.
const claimWalletHosts = (process.env.CLAIM_WALLET_HOSTS || 'ilp.interledger-test.dev')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

// Hosts the server may contact for Open Payments: wallet, authorization and resource servers. Anything else is refused
// before a request is sent, so a user cannot make the server call hosts they choose.
const openPaymentsHosts = (process.env.OPEN_PAYMENTS_HOSTS || 'ilp.interledger-test.dev,auth.interledger-test.dev')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

// The currencies the test wallets hold. A payment must use a currency that the chosen wallet holds.
const currencies = (process.env.PAYMENT_CURRENCIES || 'USD,EUR,COP')
  .split(',')
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);

// Per-currency custody addresses. Set CUSTODY_USD_ADDRESS, CUSTODY_EUR_ADDRESS, CUSTODY_COP_ADDRESS to add custody
// wallets for specific currencies. The default address (CUSTODY_WALLET_ADDRESS / OPEN_PAYMENTS_WALLET_ADDRESS) is
// registered for its actual currency at startup once its wallet document is fetched.
const custodyAddressByCurrency = {};
for (const c of currencies) {
  const addr = process.env[`CUSTODY_${c}_ADDRESS`];
  if (addr) custodyAddressByCurrency[c] = addr;
}

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
  paymentRails,
  // Open Payments (test network). Optional at startup: the client reports them as missing when used.
  openPayments: {
    walletAddress: process.env.OPEN_PAYMENTS_WALLET_ADDRESS || '',
    keyId: process.env.OPEN_PAYMENTS_KEY_ID || '',
    privateKeyPath: process.env.OPEN_PAYMENTS_PRIVATE_KEY_PATH || '',
    receiverWalletAddress: process.env.OPEN_PAYMENTS_RECEIVER_WALLET_ADDRESS || '',
  },
  // The platform's custody wallets: hold money for unclaimed payments.
  // The default address is registered for its actual currency at startup.
  // Per-currency overrides (CUSTODY_USD_ADDRESS etc.) let each currency use a dedicated wallet.
  custody: {
    walletId: process.env.CUSTODY_WALLET_ID || 'platform-custody',
    address: process.env.CUSTODY_WALLET_ADDRESS || process.env.OPEN_PAYMENTS_WALLET_ADDRESS || '',
    // Populated at startup: maps currency code → custody wallet address. Do not read directly; use getCustodyForCurrency().
    addressByCurrency: custodyAddressByCurrency,
  },
  // Key for encrypting consent tokens at rest. Required only when a grant is used.
  grantEncryptionKey: process.env.GRANT_ENCRYPTION_KEY || '',
  // Used for links in emails (claim links). Local by default.
  baseUrl: (process.env.BASE_URL || 'http://localhost:3202').replace(/\/+$/, ''),
  // Used only for the return address Rapyd sends the payer back to. Rapyd rejects localhost here.
  returnBaseUrl: (process.env.RETURN_BASE_URL || process.env.BASE_URL || 'http://localhost:3202').replace(/\/+$/, ''),
  sandbox,
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
  claims: {
    walletHosts: claimWalletHosts,
  },
  openPaymentsHosts,
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: readInteger('SMTP_PORT', 1025, { min: 1, max: 65535 }),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'guacapay <no-reply@guacapay.local>',
  },
  // Values of secret-like variables, used by the logger to mask them in output.
  // Short values are skipped: they would mask ordinary words.
  secretValues: Object.entries(process.env)
    .filter(([name, value]) => SECRET_NAME_PATTERN.test(name) && value && value.length >= 8)
    .map(([, value]) => value),
};
