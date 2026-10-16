// Entry point: builds the Rapyd client and webhook checks from config, then starts the gateway.
import { config } from './config.js';
import { logger } from './logger.js';
import { createRapydClient, createRapydWebhooks } from './providers/rapyd.js';
import { createForwarder } from './forward.js';
import { createGatewayApp } from './app.js';

const rapyd = createRapydClient({
  baseUrl: config.rapyd.baseUrl,
  accessKey: config.rapyd.accessKey,
  secretKey: config.rapyd.secretKey,
  country: config.rapyd.country,
});

const webhooks = createRapydWebhooks({
  url: config.rapyd.webhookUrl,
  accessKey: config.rapyd.accessKey,
  secretKey: config.rapyd.secretKey,
});

const forward = createForwarder({
  appUrl: config.appUrl,
  token: config.gatewayToken,
  onFailure: (eventId, reason) => {
    logger.error('event not delivered to app', { eventId, reason });
  },
});

const app = createGatewayApp({
  rapyd,
  gatewayToken: config.gatewayToken,
  webhooks,
  forward,
  version: '0.1.0',
});

app.listen(config.port, '0.0.0.0', () => {
  logger.info('gateway listening', { port: config.port, sandbox: config.rapyd.sandbox });
});
