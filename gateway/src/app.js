// Gateway HTTP app. Only the main app calls it, with the shared token in GATEWAY_TOKEN.
import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';
import { logger } from './logger.js';

const PAYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_AMOUNT_CENTS = 1_000_000_000;

// Express 4 does not forward errors thrown inside async handlers; this does.
const route = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);
};

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function requireGatewayToken(expectedToken) {
  const expected = sha256(expectedToken);
  return (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
    if (!match || !timingSafeEqual(sha256(match[1]), expected)) {
      return next(new AppError('unauthorized', 401, 'Missing or invalid gateway token.'));
    }
    next();
  };
}

export function parseCheckoutInput(body) {
  if (typeof body.paymentId !== 'string' || !PAYMENT_ID_PATTERN.test(body.paymentId)) {
    throw new AppError('invalid_payment_id', 400, 'paymentId must be a UUID.');
  }

  if (!Number.isSafeInteger(body.amountCents) || body.amountCents < 1 || body.amountCents > MAX_AMOUNT_CENTS) {
    throw new AppError('invalid_amount', 400, 'amountCents must be a positive whole number.');
  }

  if (typeof body.currency !== 'string' || !CURRENCY_PATTERN.test(body.currency)) {
    throw new AppError('invalid_currency', 400, 'currency must be a three-letter ISO code.');
  }

  let returnUrl;
  try {
    returnUrl = new URL(body.returnUrl);
  } catch {
    throw new AppError('invalid_return_url', 400, 'returnUrl must be an absolute URL.');
  }
  if (returnUrl.protocol !== 'https:' && returnUrl.protocol !== 'http:') {
    throw new AppError('invalid_return_url', 400, 'returnUrl must be an http or https URL.');
  }

  return {
    paymentId: body.paymentId,
    amountCents: body.amountCents,
    currency: body.currency,
    returnUrl: returnUrl.toString(),
  };
}

export function createGatewayApp({ rapyd, gatewayToken, version = 'dev' }) {
  const app = express();

  app.disable('x-powered-by');

  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
      logger.info('request', { requestId: req.id, method: req.method, path: req.path, status: res.statusCode });
    });
    next();
  });

  app.use(express.json({ limit: '20kb' }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'gateway', version });
  });

  app.use('/checkout', requireGatewayToken(gatewayToken));

  app.post(
    '/checkout',
    route(async (req, res) => {
      const result = await rapyd.createCheckout(parseCheckoutInput(req.body ?? {}));
      res.status(201).json(result);
    }),
  );

  app.get(
    '/checkout/status/:id',
    route(async (req, res) => {
      res.json(await rapyd.getCheckoutStatus(req.params.id));
    }),
  );

  app.use((req, res, next) => {
    next(new AppError('not_found', 404, 'Route not found'));
  });

  app.use((err, req, res, next) => {
    let appError = err;

    if (err.type === 'entity.parse.failed') {
      appError = new AppError('invalid_json', 400, 'Request body is not valid JSON');
    } else if (!(err instanceof AppError)) {
      appError = new AppError('internal_error', 500, 'Unexpected error');
    }

    if (appError.status >= 500 || appError.providerCode) {
      logger.error('request failed', {
        requestId: req.id,
        code: appError.code,
        providerCode: appError.providerCode,
        error: err.message,
      });
    }

    res.status(appError.status).json({
      error: { code: appError.code, message: appError.message, requestId: req.id },
    });
  });

  return app;
}
