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

// The claim token from the link is the proof of access, so these calls do not use the sign-in token.
export async function sendClaimCode(client, token, email) {
  await client.post('/api/claims/verify-email', { token, email }, { auth: false });
}

export async function confirmClaim(client, { token, code, destinationWalletAddress }) {
  return client.post('/api/claims/confirm', { token, code, destinationWalletAddress }, { auth: false });
}

// Creates the payment only. The payer chooses how to pay on the payment page.
export async function createPaymentOnly(client, body, idempotencyKey) {
  return client.post('/api/payments', body, { headers: { 'Idempotency-Key': idempotencyKey } });
}

export async function payWithAppBalance(client, paymentId) {
  return client.post(`/api/payments/${encodeURIComponent(paymentId)}/pay-with-balance`);
}

// Pays from one of the signed-in user's linked wallets. Resolves with { status }: paid, failed, or awaiting_payment.
export async function payWithWallet(client, paymentId, walletId) {
  return client.post(`/api/payments/${encodeURIComponent(paymentId)}/pay-with-wallet`, { wallet_id: walletId });
}

export async function fetchWallets(client) {
  const result = await client.get('/api/wallets');
  return result.wallets;
}

export async function startRapydCheckout(client, paymentId) {
  return client.post(`/api/payments/${encodeURIComponent(paymentId)}/checkout`);
}

export async function fetchBalances(client) {
  const result = await client.get('/api/balance');
  return result.balances;
}

// Recharges the app balance through Rapyd. Returns the Rapyd page to send the payer to.
export async function startRecharge(client, amountCents, currency, idempotencyKey) {
  return client.post(
    '/api/balance/recharges',
    { amount_cents: amountCents, currency },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

export async function fetchPayment(client, paymentId) {
  return client.get(`/api/payments/${encodeURIComponent(paymentId)}`);
}
