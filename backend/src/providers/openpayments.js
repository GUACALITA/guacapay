// The only module that imports @interledger/open-payments. Everything else in the app uses it through here.
import { readFileSync } from 'node:fs';
import { createAuthenticatedClient, createUnauthenticatedClient } from '@interledger/open-payments';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';

const RETRY_DELAYS_MS = [200, 400];
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

let authenticatedClient = null;
let publicClient = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Creates the authenticated client once, from the sender wallet, its key ID and its key file.
// The key is read from its file and never logged or returned.
export async function getClient() {
  if (authenticatedClient) return authenticatedClient;

  const { walletAddress, keyId, privateKeyPath } = config.openPayments;
  if (!walletAddress || !keyId || !privateKeyPath) {
    throw new AppError(
      'openpayments_not_configured',
      503,
      'Testnet payments are not configured. Set OPEN_PAYMENTS_WALLET_ADDRESS, OPEN_PAYMENTS_KEY_ID and OPEN_PAYMENTS_PRIVATE_KEY_PATH.',
    );
  }

  let privateKey;
  try {
    privateKey = readFileSync(privateKeyPath, 'utf8');
  } catch {
    throw new AppError(
      'openpayments_key_missing',
      503,
      'The testnet key file could not be read. Check OPEN_PAYMENTS_PRIVATE_KEY_PATH.',
    );
  }

  authenticatedClient = await createAuthenticatedClient({ walletAddressUrl: walletAddress, privateKey, keyId });
  return authenticatedClient;
}

// Forgets the client, so the next call reads the key again. Used by tests and after a key change.
export function resetClient() {
  authenticatedClient = null;
}

async function getPublicClient() {
  if (!publicClient) {
    publicClient = await createUnauthenticatedClient({ requestTimeoutMs: 10000 });
  }
  return publicClient;
}

// Accepts https only. Tests may pass allowHttp to reach a local fake server.
function checkWalletUrl(raw, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new AppError('invalid_wallet_address', 400, 'Enter a valid wallet address.');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new AppError('invalid_wallet_address', 400, 'A wallet address must start with https.');
  }
  return url.toString();
}

function isNetworkError(err) {
  const code = err?.code ?? err?.cause?.code;
  return err?.status === undefined && NETWORK_CODES.has(code);
}

// Maps an SDK error to a stable app error. The SDK message is logged, never returned to the caller.
function toAppError(err, operation) {
  logger.warn('open payments call failed', { operation, status: err?.status, reason: err?.code ?? err?.name ?? 'unknown' });

  if (err?.status === 404) {
    return new AppError('wallet_not_found', 404, 'That wallet address was not found on the test network.');
  }
  if (err?.status !== undefined && err.status < 500) {
    return new AppError('openpayments_rejected', 422, 'The test network rejected the request.');
  }
  return new AppError('openpayments_unavailable', 502, 'The test network is not responding. Try again shortly.');
}

// Runs an SDK call. Only network errors are retried, twice. A rejected request is never retried.
export async function withRetry(operation, fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isNetworkError(err) || attempt >= RETRY_DELAYS_MS.length) {
        throw toAppError(err, operation);
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Runs a call that creates something on the network. It is not retried: repeating a grant request could create a second grant.
async function callOnce(operation, fn) {
  try {
    return await fn();
  } catch (err) {
    throw toAppError(err, operation);
  }
}

// Asks the wallet's authorization server for a grant. The wallet answers with an approval URL (interact.redirect)
// and a continuation (continue.uri and continue.access_token.value), unless it grants without interaction.
export async function startGrant({ authServer, access, finishUri, nonce }) {
  const client = await getClient();
  return callOnce('grant.request', () =>
    client.grant.request(
      { url: authServer },
      {
        access_token: { access },
        interact: { start: ['redirect'], finish: { method: 'redirect', uri: finishUri, nonce } },
      },
    ),
  );
}

// Finishes a grant after the user approved it, using the interaction reference the wallet sent back.
export async function continueGrant({ continueUri, continueToken, interactRef }) {
  const client = await getClient();
  return callOnce('grant.continue', () =>
    client.grant.continue({ url: continueUri, accessToken: continueToken }, { interact_ref: interactRef }),
  );
}

// Reads a wallet's public document (no keys needed). Used before linking a wallet.
export async function getWalletAddress(rawUrl, options = {}) {
  const url = checkWalletUrl(rawUrl, options);
  return withRetry('walletAddress.get', async () => {
    const client = await getPublicClient();
    const wallet = await client.walletAddress.get({ url });
    return {
      id: wallet.id,
      publicName: wallet.publicName,
      assetCode: wallet.assetCode,
      assetScale: wallet.assetScale,
      authServer: wallet.authServer,
      resourceServer: wallet.resourceServer,
    };
  });
}
