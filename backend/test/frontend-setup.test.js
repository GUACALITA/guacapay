// Guided wallet setup (prompt 29). Reads the frontend files; no network, no server. NOT RUN yet, at the user's request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(here, '..', '..', 'frontend');

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const FILES = filesUnder(FRONTEND);
const text = (path) => readFileSync(path, 'utf8');

// Fields a user would type into: any input, textarea or select.
const FIELD_TAG = /<(input|textarea|select)\b[^>]*>/gi;
// Words that would mean a password, a wallet code, a recovery phrase or a key is being asked for.
const SECRET_WORDS = /password|passcode|passphrase|private|secret|seed|recovery|mnemonic|wallet[-_ ]?code|otp/i;

test('no field in frontend/ asks for a password, a wallet code, a recovery phrase or a private key', () => {
  const problems = [];
  for (const file of FILES.filter((path) => path.endsWith('.html'))) {
    for (const [tag] of text(file).matchAll(FIELD_TAG)) {
      if (/type\s*=\s*["']?password/i.test(tag)) problems.push(`${relative(FRONTEND, file)}: password field`);
      if (SECRET_WORDS.test(tag)) problems.push(`${relative(FRONTEND, file)}: field ${tag.slice(0, 80)}`);
    }
  }
  // Fields created in script, not written in the HTML.
  for (const file of FILES.filter((path) => path.endsWith('.js'))) {
    if (/\.type\s*=\s*["']password["']|type\s*=\s*["']password["']/i.test(text(file))) {
      problems.push(`${relative(FRONTEND, file)}: password field created in script`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the wallet setup page has no form fields at all', () => {
  const html = text(join(FRONTEND, 'wallet-setup.html'));
  assert.doesNotMatch(html, /<(input|textarea|select|form)\b/i);
});

test('the official links come from the config file, not from the page', () => {
  const config = JSON.parse(text(join(FRONTEND, 'config', 'setup.json')));
  for (const key of ['walletSignUpUrl', 'keyDocumentationUrl']) {
    assert.match(config[key], /^https:\/\//, `${key} must be an https link`);
  }
  const html = text(join(FRONTEND, 'wallet-setup.html'));
  assert.ok(!html.includes(new URL(config.walletSignUpUrl).hostname), 'the sign-up host is not typed into the page');
  assert.ok(!html.includes(new URL(config.keyDocumentationUrl).hostname), 'the documentation host is not typed into the page');
});

test('the setup script only accepts https links from the config', () => {
  const js = text(join(FRONTEND, 'js', 'pages', 'wallet-setup.js'));
  assert.match(js, /protocol === 'https:'/);
  assert.match(js, /config\/setup\.json/);
});

test('the wallet linking page sends no password, code or key', () => {
  const js = text(join(FRONTEND, 'js', 'pages', 'wallets.js'));
  assert.doesNotMatch(js, /password|private|secret|seed|mnemonic/i);
});
