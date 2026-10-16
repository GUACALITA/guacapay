// Fallback for missed webhooks: checks old awaiting payments once a minute.
import { logger } from '../logger.js';
import { reconcilePending } from './reconcile.js';

export function startPaymentPoller({ gateway, intervalMs = 60 * 1000 }) {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcilePending({ gateway });
      if (result.applied > 0) {
        logger.info('poll applied payment updates', result);
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
