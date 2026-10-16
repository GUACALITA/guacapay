// Reads `Authorization: Bearer <token>` and sets req.user. Rejects anything else with 401.
import { AppError } from '../errors.js';
import { verifyToken } from './tokens.js';

const BEARER_PATTERN = /^Bearer (.+)$/;

export function requireAuth(req, res, next) {
  const match = BEARER_PATTERN.exec(req.get('Authorization') || '');
  if (!match) {
    return next(new AppError('unauthorized', 401, 'Sign in to continue.'));
  }

  try {
    req.user = { id: verifyToken(match[1]) };
    next();
  } catch {
    next(new AppError('unauthorized', 401, 'Sign in to continue.'));
  }
}
