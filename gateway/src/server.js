// Entry point: builds the Rapyd client from config and starts the gateway.
import { config } from './config.js';
import { logger } from './logger.js';
import { createRapydClient } from './providers/rapyd.js';
import { createGatewayApp } from './app.js';

const rapyd = createRapydClient({
  baseUrl: config.rapyd.baseUrl,
  accessKey: config.rapyd.accessKey,
  secretKey: config.rapyd.secretKey,
  country: config.rapyd.country,
});

const app = createGatewayApp({ rapyd, gatewayToken: config.gatewayToken, version: '0.1.0' });

app.listen(config.port, '0.0.0.0', () => {
  logger.info('gateway listening', { port: config.port, sandbox: config.rapyd.sandbox });
});
