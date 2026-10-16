// Sends the app's emails through a transport. The transport is nodemailer in production, or a fake in tests.
// Logs record the email type and a keyed reference to the recipient, never the code, the link, or the address itself.
import { AppError } from '../errors.js';
import { hashSecret } from '../hash.js';
import { logger } from '../logger.js';
import { renderEmail } from './render.js';

const TEMPLATE_FILE = Object.freeze({
  loginCode: 'login-code',
  claimLink: 'claim-link',
  paymentConfirmation: 'payment-confirmation',
});

const SUBJECT = Object.freeze({
  loginCode: 'Your guacapay sign-in code',
  claimLink: 'You have money waiting on guacapay',
  paymentConfirmation: 'Your payment was claimed',
});

export function recipientReference(email) {
  return hashSecret(String(email).toLowerCase()).slice(0, 12);
}

export function createMailer({ transport, from }) {
  async function send(type, to, values) {
    const { text, html } = renderEmail(TEMPLATE_FILE[type], values);
    const reference = recipientReference(to);

    try {
      await transport.sendMail({ from, to, subject: SUBJECT[type], text, html });
      logger.info('email sent', { type, recipient: reference });
    } catch (err) {
      // Only the error code is logged: some transport messages include the address.
      logger.warn('email not sent', { type, recipient: reference, reason: err.code ?? err.name ?? 'unknown' });
      throw new AppError('email_failed', 503, 'We could not send the email. Try again shortly.');
    }
  }

  return {
    sendLoginCode: (email, code) => send('loginCode', email, { code }),

    sendClaimLink: (email, link, details = {}) =>
      send('claimLink', email, { link, amount: details.amountText ?? 'See the link for details' }),

    sendPaymentConfirmation: (email, details) =>
      send('paymentConfirmation', email, {
        amount: details.amountText,
        recipient: details.recipientEmail,
      }),
  };
}
