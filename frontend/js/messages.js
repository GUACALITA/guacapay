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

const FALLBACK = 'Something went wrong. Please try again.';

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
