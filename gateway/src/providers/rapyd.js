// The only module that knows Rapyd field names, URLs, and request signing.
// Reference: https://docs.rapyd.net/en/request-signatures.html and
// https://docs.rapyd.net/en/create-checkout-page.html, https://docs.rapyd.net/en/retrieve-checkout-page.html
import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';

const CHECKOUT_PATH = '/v1/checkout';
const CHECKOUT_ID_PATTERN = /^checkout_[A-Za-z0-9]+$/;
const TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

// Rapyd checkout status -> our internal status.
const STATUS_MAP = Object.freeze({
  NEW: 'pending',
  INP: 'pending',
  DON: 'paid',
  EXP: 'expired',
  DEC: 'declined',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rapyd signature, as documented:
// signature = base64( hex( HMAC-SHA256(secret, method + path + salt + timestamp + access + secret + body) ) )
export function signRequest({ method, urlPath, salt, timestamp, accessKey, secretKey, bodyString }) {
  const toSign = `${method.toLowerCase()}${urlPath}${salt}${timestamp}${accessKey}${secretKey}${bodyString}`;
  const hex = createHmac('sha256', secretKey).update(toSign).digest('hex');
  return Buffer.from(hex).toString('base64');
}

export function createRapydClient({
  baseUrl,
  accessKey,
  secretKey,
  country,
  fetchImpl = (url, options) => fetch(url, options),
  now = () => Date.now(),
  makeSalt = () => randomBytes(8).toString('hex'),
  retryDelayMs = 500,
}) {
  // Sends one signed request. Only network errors and timeouts are retried.
  // Each attempt gets a new salt and timestamp; the idempotency key stays the same.
  async function call(method, urlPath, payload, idempotencyKey) {
    const bodyString = payload === undefined ? '' : JSON.stringify(payload);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await sleep(retryDelayMs * attempt);
      }

      const salt = makeSalt();
      const timestamp = String(Math.floor(now() / 1000));
      const headers = {
        'Content-Type': 'application/json',
        access_key: accessKey,
        salt,
        timestamp,
        signature: signRequest({ method, urlPath, salt, timestamp, accessKey, secretKey, bodyString }),
      };
      if (idempotencyKey) {
        headers.idempotency = idempotencyKey;
      }

      let response;
      try {
        response = await fetchImpl(`${baseUrl}${urlPath}`, {
          method,
          headers,
          body: bodyString === '' ? undefined : bodyString,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        continue;
      }

      return readResponse(response);
    }

    throw new AppError('provider_unavailable', 502, 'The payment provider could not be reached.');
  }

  async function readResponse(response) {
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    const providerCode = json?.status?.error_code;

    if (response.status === 401 || response.status === 403) {
      throw new AppError('provider_auth_failed', 502, 'The payment provider rejected our credentials.', { providerCode });
    }
    if (response.status >= 500) {
      throw new AppError('provider_unavailable', 502, 'The payment provider is unavailable.', { providerCode });
    }
    if (!response.ok || json?.status?.status !== 'SUCCESS') {
      throw new AppError('provider_rejected', 422, 'The payment provider rejected the request.', { providerCode });
    }
    return json.data;
  }

  // Creates a hosted checkout page. Amount is sent in major units with two decimals.
  async function createCheckout({ paymentId, amountCents, currency, returnUrl }) {
    const data = await call(
      'POST',
      CHECKOUT_PATH,
      {
        amount: Number((amountCents / 100).toFixed(2)),
        currency,
        country,
        complete_checkout_url: returnUrl,
        cancel_checkout_url: returnUrl,
        merchant_reference_id: paymentId,
      },
      paymentId,
    );

    if (!data?.id || !data?.redirect_url) {
      throw new AppError('provider_rejected', 422, 'The payment provider returned an incomplete checkout.');
    }

    return {
      checkoutId: data.id,
      redirectUrl: data.redirect_url,
      status: STATUS_MAP[data.status] ?? 'unknown',
    };
  }

  async function getCheckoutStatus(checkoutId) {
    if (typeof checkoutId !== 'string' || !CHECKOUT_ID_PATTERN.test(checkoutId)) {
      throw new AppError('invalid_checkout_id', 400, 'Checkout ID is not valid.');
    }

    const data = await call('GET', `${CHECKOUT_PATH}/${checkoutId}`);
    if (!data?.id) {
      throw new AppError('provider_rejected', 422, 'The payment provider returned an incomplete checkout.');
    }

    return {
      checkoutId: data.id,
      status: STATUS_MAP[data.status] ?? 'unknown',
      providerStatus: data.status,
    };
  }

  return { createCheckout, getCheckoutStatus };
}
