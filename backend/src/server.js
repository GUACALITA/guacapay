// Entry point: runs migrations, starts the HTTP server and the payment poller.
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './migrate.js';
import { createApp } from './app.js';
import { createGatewayClient } from './gateway-client.js';
import { startPaymentPoller } from './payments/poller.js';

try {
  const applied = runMigrations();
  logger.info('migrations checked', { applied });
} catch (err) {
  logger.error('migrations failed', { error: err.message });
  process.exit(1);
}

const gateway = createGatewayClient({ baseUrl: config.gateway.url, token: config.gateway.token });
const app = createApp({ gateway });

app.listen(config.port, '0.0.0.0', () => {
  logger.info('app listening', { port: config.port, version: config.version });
});

startPaymentPoller({ gateway });
