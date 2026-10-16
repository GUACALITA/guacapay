// Builds the Express app. Kept separate from server.js so tests can run it in-process.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { AppError } from './errors.js';
import { createAuthRouter } from './auth/routes.js';
import { unconfiguredMailer } from './auth/mailer.js';
import { createPaymentsRouter } from './payments/routes.js';
import { handleProviderEvent } from './payments/reconcile.js';
import { requireGatewayToken } from './auth/gateway-token.js';

// Turns an async handler's rejection into a call to next(err).
const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

// Only the fields the gateway forwards are read; anything else is ignored.
function parseInternalEvent(body) {
  const event = body ?? {};
  if (typeof event.eventId !== 'string' || event.eventId.length === 0 || event.eventId.length > 100) {
    throw new AppError('invalid_event', 400, 'Event is missing its ID.');
  }
  if (typeof event.type !== 'string') {
    throw new AppError('invalid_event', 400, 'Event is missing its type.');
  }
  return {
    eventId: event.eventId,
    type: event.type,
    paymentReference: typeof event.paymentReference === 'string' && event.paymentReference ? event.paymentReference : null,
  };
}

export function createApp({ mailer = unconfiguredMailer, gateway = null, gatewayToken = config.gateway.token } = {}) {
  const app = express();

  app.disable('x-powered-by');

  // Request ID: one per request, returned to the client and included in logs and errors.
  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
      logger.info('request', { requestId: req.id, method: req.method, path: req.path, status: res.statusCode });
    });
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(config.frontendDir));

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'app', version: config.version });
  });

  app.use('/api/auth', createAuthRouter({ mailer }));
  app.use('/api/payments', createPaymentsRouter({ gateway }));

  // Called only by the gateway, with the shared token. Always answers 200 for a well-formed event,
  // including unknown or already-applied ones, so the gateway does not keep retrying.
  app.post(
    '/internal/payment-events',
    requireGatewayToken(gatewayToken),
    route(async (req, res) => {
      if (!gateway) {
        throw new AppError('gateway_not_configured', 503, 'Payment service is not configured.');
      }
      const result = await handleProviderEvent(parseInternalEvent(req.body), { gateway });
      res.json(result);
    }),
  );

  // Any route not matched above.
  app.use((req, res, next) => {
    next(new AppError('not_found', 404, 'Route not found'));
  });

  // The only place that turns errors into responses.
  app.use((err, req, res, next) => {
    let appError = err;

    if (err.type === 'entity.parse.failed') {
      appError = new AppError('invalid_json', 400, 'Request body is not valid JSON');
    } else if (!(err instanceof AppError)) {
      const status = err.status || err.statusCode;
      if (status && status < 500) {
        appError = new AppError('bad_request', status, 'Request could not be processed');
      } else {
        appError = new AppError('internal_error', 500, 'Unexpected error');
      }
    }

    if (appError.status >= 500) {
      logger.error('request failed', {
        requestId: req.id,
        error: err.message,
        stack: config.isProduction ? undefined : err.stack,
      });
    }

    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        requestId: req.id,
      },
    });
  });

  return app;
}
