// Entry point: runs migrations, starts the HTTP and WebSocket servers, and the payment poller.
import { createServer } from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './migrate.js';
import { createApp } from './app.js';
import { createGatewayClient } from './gateway-client.js';
import { startPaymentPoller } from './payments/poller.js';
import { attachLiveStatus } from './ws/live-status.js';
import { mailerFromConfig } from './email/index.js';
import { checkCustodyWallet } from './custody/service.js';
import { ensurePlatformCustody } from './custody/setup.js';
import { startSubscriptionJob } from './subscriptions/job.js';
import { startPoolJob } from './pools/job.js';

try {
  const applied = runMigrations();
  logger.info('migrations checked', { applied });
} catch (err) {
  logger.error('migrations failed', { error: err.message });
  process.exit(1);
}

// Prepares the platform's custody wallet (no .env setting needed). A failure is logged and does not stop the server.
ensurePlatformCustody().catch((err) => logger.error('custody setup failed', { error: err.message }));

// Checks the custody wallet without stopping the server: it is needed for transfers, not for the rest of the app.
checkCustodyWallet().then((report) => {
  if (report.ok) {
    logger.info('custody wallet ready');
  } else if (report.reason === 'not_configured') {
    logger.warn('custody wallet not configured; transfers are unavailable');
  } else {
    logger.error('custody wallet check failed', { reason: report.reason });
  }
});

const gateway = createGatewayClient({ baseUrl: config.gateway.url, token: config.gateway.token });
const mailer = mailerFromConfig();

// In demo mode the testnet is unreliable, so the payout to the recipient is skipped.
// The claim still records correctly; no real money is moved either way on the testnet.
const demoTransfer =
  process.env.DEMO_MODE === 'true'
    ? async () => ({ id: null, status: 'completed' })
    : undefined;

const app = createApp({ gateway, mailer, transfer: demoTransfer });

const server = createServer(app);
attachLiveStatus(server);

server.listen(config.port, '0.0.0.0', () => {
  logger.info('app listening', { port: config.port, version: config.version });
});

startPaymentPoller({ gateway, mailer });
startSubscriptionJob();
startPoolJob();
