// The steps each page performs, as plain functions over an API client. Pages call these; tests call them with a fake client.

export async function requestLoginCode(client, email) {
  await client.post('/api/auth/request-code', { email }, { auth: false });
}

// On success the session token is kept in sessionStorage through the client.
export async function verifyLoginCode(client, email, code) {
  const result = await client.post('/api/auth/verify-code', { email, code }, { auth: false });
  client.setToken(result.token);
  return result;
}

export async function fetchCurrencies(client) {
  const config = await client.get('/api/config', { auth: false });
  return Array.isArray(config.currencies) && config.currencies.length > 0 ? config.currencies : ['USD'];
}

// Creates the payment, then starts its checkout. `idempotencyKey` must be the same for every retry of this one attempt.
// If the checkout was already started (for example after a retry), the payment page shows where things stand.
export async function startPayment(client, body, idempotencyKey) {
  const payment = await client.post('/api/payments', body, { headers: { 'Idempotency-Key': idempotencyKey } });

  try {
    const checkout = await client.post(`/api/payments/${payment.id}/checkout`);
    return { paymentId: payment.id, redirectUrl: checkout.redirectUrl };
  } catch (error) {
    if (error.code === 'checkout_not_available') {
      return { paymentId: payment.id, redirectUrl: null };
    }
    throw error;
  }
}

export async function fetchPayment(client, paymentId) {
  return client.get(`/api/payments/${encodeURIComponent(paymentId)}`);
}
