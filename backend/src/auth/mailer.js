// The interface used to send email. The real email module replaces this in prompt 13.
// Until then, every send fails with 503, so no code or claim link is ever sent or logged.
import { AppError } from '../errors.js';

const notConfigured = () => new AppError('email_not_configured', 503, 'Email delivery is not configured yet.');

export const unconfiguredMailer = {
  async sendLoginCode() {
    throw notConfigured();
  },
  async sendClaimLink() {
    throw notConfigured();
  },
};
