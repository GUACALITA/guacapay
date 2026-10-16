// HTTP client for the payment gateway. The app uses this, never Rapyd directly.
import { AppError } from './errors.js';

export function createGatewayClient({ baseUrl, token, fetchImpl = (url, options) => fetch(url, options), timeoutMs = 10000 }) {
  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AppError('gateway_unavailable', 502, 'The payment service could not be reached.');
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok) {
      const status = response.status >= 500 ? 502 : response.status;
      throw new AppError(
        json?.error?.code ?? 'gateway_error',
        status,
        json?.error?.message ?? 'The payment service returned an error.',
      );
    }
    return json;
  }

  return {
    createCheckout: (input) => call('POST', '/checkout', input),
    getCheckoutStatus: (checkoutId) => call('GET', `/checkout/status/${encodeURIComponent(checkoutId)}`),
  };
}
