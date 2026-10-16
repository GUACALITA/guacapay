// Checks the shared token on requests coming from the gateway.
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

const BEARER_PATTERN = /^Bearer (.+)$/;

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

export function requireGatewayToken(expectedToken) {
  const expected = sha256(expectedToken);
  return (req, res, next) => {
    const match = BEARER_PATTERN.exec(req.get('Authorization') || '');
    if (!match || !timingSafeEqual(sha256(match[1]), expected)) {
      return next(new AppError('unauthorized', 401, 'Missing or invalid gateway token.'));
    }
    next();
  };
}
