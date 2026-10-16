// Chooses the real mailer when SMTP is configured, and the unconfigured one otherwise.
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { unconfiguredMailer } from '../auth/mailer.js';
import { createMailer } from './send.js';

export function mailerFromConfig() {
  if (!config.smtp.host) {
    return unconfiguredMailer;
  }

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });

  return createMailer({ transport, from: config.smtp.from });
}
