// Session tokens. The payload carries only the user ID (as `sub`).
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const TOKEN_TTL_SECONDS = 60 * 60;
const ALGORITHM = 'HS256';

export function issueToken(userId) {
  return jwt.sign({}, config.jwtSecret, {
    subject: userId,
    expiresIn: TOKEN_TTL_SECONDS,
    algorithm: ALGORITHM,
  });
}

// Returns the full payload (sub, iat, exp). Throws if the token is invalid, expired, or signed with another algorithm.
export function verifyTokenPayload(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: [ALGORITHM] });
}

export function verifyToken(token) {
  return verifyTokenPayload(token).sub;
}
