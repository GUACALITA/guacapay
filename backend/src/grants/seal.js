// Encrypts the grant tokens at rest with AES-256-GCM. The key comes from GRANT_ENCRYPTION_KEY (64 hex characters).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';

function key() {
  const hex = config.grantEncryptionKey;
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) {
    throw new AppError('grant_key_missing', 503, 'GRANT_ENCRYPTION_KEY must be 64 hexadecimal characters.');
  }
  return Buffer.from(hex, 'hex');
}

// Output: iv.tag.ciphertext, each part in base64.
export function seal(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64')).join('.');
}

export function open(sealed) {
  const [iv, tag, encrypted] = String(sealed).split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
