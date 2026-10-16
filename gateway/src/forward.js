// Sends verified webhook events to the main app. Retries server errors and network failures.
// If every attempt fails, the event is logged and the app's polling job still picks the payment up.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createForwarder({
  appUrl,
  token,
  fetchImpl = (url, options) => fetch(url, options),
  maxAttempts = 3,
  retryDelayMs = 1000,
  timeoutMs = 10000,
  onFailure = () => {},
}) {
  return async function forward(event) {
    const payload = JSON.stringify({
      eventId: event.eventId,
      type: event.type,
      paymentReference: event.paymentReference,
      providerPaymentId: event.providerPaymentId,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${appUrl}/internal/payment-events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.ok) return;
        // Client errors will not succeed on retry.
        if (response.status < 500) {
          onFailure(event.eventId, `app answered ${response.status}`);
          return;
        }
      } catch {
        // Network error or timeout: try again below.
      }

      if (attempt < maxAttempts) {
        await sleep(retryDelayMs * attempt);
      }
    }

    onFailure(event.eventId, 'gave up after retries');
  };
}
