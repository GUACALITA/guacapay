// The interface used to send login codes. The real email module replaces this in prompt 13.
// Until then, requesting a code fails with 503, so no code is ever sent or logged.
import { AppError } from '../errors.js';

export const unconfiguredMailer = {
  async sendLoginCode() {
    throw new AppError('email_not_configured', 503, 'Email delivery is not configured yet.');
  },
};
