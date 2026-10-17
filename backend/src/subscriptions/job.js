// The hourly charge run for subscriptions. A run that overlaps the previous one is skipped.
import { logger } from '../logger.js';
import { runDueCharges } from './service.js';

const HOUR_MS = 60 * 60 * 1000;

export function startSubscriptionJob({ intervalMs = HOUR_MS, deps } = {}) {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const outcome = await runDueCharges({ deps });
      if (outcome.checked > 0) {
        logger.info('subscription charges run', outcome);
      }
    } catch (err) {
      logger.error('subscription charges failed', { error: err.message });
    } finally {
      running = false;
    }
  }, intervalMs);

  // Do not keep the process alive just for this timer.
  timer.unref();
  return () => clearInterval(timer);
}
