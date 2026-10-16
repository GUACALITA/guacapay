// Fallback for missed webhooks and missed claim links: runs once a minute.
import { logger } from '../logger.js';
import { reconcilePending } from './reconcile.js';
import { issuePendingClaims } from '../claims/service.js';

export function startPaymentPoller({ gateway, mailer, intervalMs = 60 * 1000 }) {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const reconciled = await reconcilePending({ gateway });
      if (reconciled.applied > 0) {
        logger.info('poll applied payment updates', reconciled);
      }
      const claims = await issuePendingClaims({ mailer });
      if (claims.issued > 0) {
        logger.info('poll issued claim links', claims);
      }
    } catch (err) {
      logger.error('poll failed', { error: err.message });
    } finally {
      running = false;
    }
  }, intervalMs);

  // Do not keep the process alive just for this timer.
  timer.unref();
  return () => clearInterval(timer);
}
