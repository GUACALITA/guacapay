// Entry point: runs migrations, then starts the HTTP server.
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './migrate.js';
import { createApp } from './app.js';

try {
  const applied = runMigrations();
  logger.info('migrations checked', { applied });
} catch (err) {
  logger.error('migrations failed', { error: err.message });
  process.exit(1);
}

const app = createApp();

app.listen(config.port, '0.0.0.0', () => {
  logger.info('app listening', { port: config.port, version: config.version });
});
