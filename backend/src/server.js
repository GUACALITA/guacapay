// Backend core: Express app with health check, request IDs, static files,
// and one JSON error format. Routes for auth, payments and claims are added later.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { AppError } from './errors.js';

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

app.listen(config.port, '0.0.0.0', () => {
  logger.info('app listening', { port: config.port, version: config.version });
});
