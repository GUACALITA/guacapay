// Plain-language text for the person using the app. Internal codes, IDs and provider details never reach the page.

const PAYMENT_STATUS_TEXT = Object.freeze({
  created: 'Payment created. Continue to pay.',
  awaiting_payment: 'Waiting for your payment to be confirmed.',
  paid: 'Payment received. The recipient will get a link to claim it.',
  claimable: 'Ready for the recipient to claim.',
  claimed: 'Claimed. The transfer is in progress.',
  completed: 'Completed.',
  expired: 'This payment expired before it was paid.',
  failed: 'This payment did not go through.',
});

const CLAIM_RESULT_TEXT = Object.freeze({
  completed: 'Claimed. The money is on its way to your wallet.',
  failed: 'The transfer did not go through. Contact the sender.',
  processing: 'The transfer is still running. Your claim is saved; check again in a few minutes.',
});

const ERROR_TEXT = Object.freeze({
  claim_not_found: 'This claim link is not valid.',
  claim_used: 'This claim has already been used.',
  claim_expired: 'This claim link has expired. Ask the sender to send a new one.',
  claim_in_progress: 'This claim is being processed. Wait a moment and refresh the page.',
  claim_not_available: 'This payment is not ready to claim yet.',
  email_mismatch: 'That email does not match this claim.',
  invalid_destination: 'Enter a valid wallet address.',
  transfer_not_configured: 'Transfers are not available yet. Your claim is still open. Try again later.',
  network_error: 'Could not reach the server. Check your connection and try again.',
  unauthorized: 'Your session has ended. Sign in again.',
  session_expired: 'Your session has ended. Sign in again.',
  invalid_email: 'Enter a valid email address.',
  invalid_code: 'The code is wrong or has expired.',
  too_many_attempts: 'Too many wrong codes. Request a new code.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  email_not_configured: 'Sign-in email is not available yet. Try again later.',
  email_failed: 'We could not send the email. Try again shortly.',
  insufficient_balance: 'Your app balance is not enough for this payment. Recharge it with Rapyd, or pay with card.',
  payment_not_payable: 'This payment can no longer be paid from the app balance.',
  wallet_not_linked: 'Choose one of your linked wallets to pay from.',
  payment_not_payable: 'This payment can no longer be paid from a wallet.',
  invalid_amount: 'Enter a valid amount.',
  invalid_currency: 'Choose a supported currency.',
  invalid_message: 'Keep the message to 500 characters or fewer.',
  idempotency_conflict: 'This payment was already submitted with different details. Refresh the page and start again.',
  payment_not_found: 'Payment not found.',
  checkout_not_available: 'This payment is no longer waiting for a checkout.',
  gateway_not_configured: 'Payments are not available right now.',
  gateway_unavailable: 'Payments are not available right now. Try again shortly.',
  provider_unavailable: 'The payment provider is not responding. Try again shortly.',
  provider_auth_failed: 'Payments are not available right now.',
  provider_rejected: 'The payment could not be started. Check the details and try again.',
});

const REQUEST_STATUS_TEXT = Object.freeze({
  open: 'Open. Waiting for someone to pay.',
  paid: 'Paid.',
  closed: 'Closed.',
  expired: 'Expired. Nobody can pay it now.',
});

const SUBSCRIPTION_STATUS_TEXT = Object.freeze({
  pending: 'Waiting for approval in the wallet.',
  active: 'Active. Charged each period.',
  paused: 'Paused after three failed charges.',
  cancelled: 'Cancelled.',
});

const POOL_STATUS_TEXT = Object.freeze({
  forming: 'Gathering members.',
  active: 'Collecting contributions.',
  closing: 'Paying out.',
  completed: 'Completed.',
  cancelled: 'Cancelled.',
});

const MOVEMENT_STATUS_TEXT = Object.freeze({
  pending: 'In progress. This may take a few minutes.',
  completed: 'Completed.',
  failed: 'Did not go through.',
});

const SUBSCRIPTION_ROLE_TEXT = Object.freeze({
  payee: 'You receive these charges',
  payer: 'You pay these charges',
});

const INTERVAL_TEXT = Object.freeze({
  P1D: 'daily',
  P1W: 'weekly',
  P1M: 'monthly',
});

const FALLBACK = 'Something went wrong. Please try again.';

export function messageForRequest(status) {
  return REQUEST_STATUS_TEXT[status] ?? 'Status unknown. Refresh the page.';
}

export function messageForSubscription(status) {
  return SUBSCRIPTION_STATUS_TEXT[status] ?? 'Status unknown. Refresh the page.';
}

export function messageForPool(status) {
  return POOL_STATUS_TEXT[status] ?? 'Status unknown. Refresh the page.';
}

export function messageForMovement(status) {
  return MOVEMENT_STATUS_TEXT[status] ?? 'Status unknown. Refresh the page.';
}

export function messageForRole(role) {
  return SUBSCRIPTION_ROLE_TEXT[role] ?? '';
}

export function messageForInterval(interval) {
  return INTERVAL_TEXT[interval] ?? 'on a schedule';
}

export function messageForClaimResult(status) {
  return CLAIM_RESULT_TEXT[status] ?? 'Status unknown. Contact the sender.';
}

export function messageForStatus(status) {
  return PAYMENT_STATUS_TEXT[status] ?? 'Status unknown. Refresh the page.';
}

// Accepts an ApiError (or any error). Unknown codes get the generic text, never the raw message.
export function messageForError(error) {
  return ERROR_TEXT[error?.code] ?? FALLBACK;
}
