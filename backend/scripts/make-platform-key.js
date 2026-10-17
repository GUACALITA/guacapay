// Creates a new Ed25519 key pair for the platform's Open Payments wallet, on this machine (prompt 35).
// The private key is written to keys/ with restricted permissions and is never printed.
// Only the public key is printed: upload it in the platform wallet (Developer Keys > Upload key).
// Never overwrites an existing file. Not part of `npm test`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const keysDir = join(here, '..', '..', 'keys');
const output = join(keysDir, 'platform-key-candidate.pem');

if (existsSync(output)) {
  console.log(`Refused: ${output} already exists. Move or delete it first, so the current key is never replaced by mistake.`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
mkdirSync(keysDir, { recursive: true });
writeFileSync(output, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

console.log('Private key written to keys/platform-key-candidate.pem. It is not printed and must not be shared.');
console.log('');
console.log('Upload ONLY this public key in the platform wallet (Developer Keys > Upload key):');
console.log('');
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
