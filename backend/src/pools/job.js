// The hourly run for group pools: closes collections past their date, retries failed payouts, and finishes pending ones.
// A run that overlaps the previous one is skipped.
import { logger } from '../logger.js';
import { runDuePools } from './service.js';

const HOUR_MS = 60 * 60 * 1000;

export function startPoolJob({ intervalMs = HOUR_MS, deps } = {}) {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const outcome = await runDuePools({ deps });
      if (outcome.closed + outcome.retried + outcome.resumed > 0) {
        logger.info('pool run', outcome);
      }
    } catch (err) {
      logger.error('pool run failed', { error: err.message });
    } finally {
      running = false;
    }
  }, intervalMs);

  // Do not keep the process alive just for this timer.
  timer.unref();
  return () => clearInterval(timer);
}
