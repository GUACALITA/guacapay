// Dashboard (prompt 30): static checks of the page and its script. The live check (empty account at 360 px) needs a browser and is reported separately. NOT RUN yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(here, '..', '..', 'frontend');
const html = readFileSync(join(FRONTEND, 'dashboard.html'), 'utf8');
const script = readFileSync(join(FRONTEND, 'js', 'pages', 'dashboard.js'), 'utf8');
const messages = readFileSync(join(FRONTEND, 'js', 'messages.js'), 'utf8');

const SECTIONS = ['wallet', 'money', 'send', 'requests', 'subscriptions', 'pools', 'history'];
const DATA_SECTIONS = ['wallet', 'money', 'requests', 'subscriptions', 'pools', 'history'];

test('the dashboard has every section the prompt asks for', () => {
  assert.match(html, /id="wallet-title"/);
  assert.match(html, /id="money-title"/);
  assert.match(html, /id="send-title"/);
  assert.match(html, /id="requests-title"/);
  assert.match(html, /id="subscriptions-title"/);
  assert.match(html, /id="pools-title"/);
  assert.match(html, /id="history-title"/);
  for (const name of SECTIONS) {
    assert.ok(html.includes(`id="${name}-title"`), name);
  }
});

test('each data section has a body and an error element, so empty and error states can be shown', () => {
  for (const name of DATA_SECTIONS) {
    assert.match(html, new RegExp(`id="${name}-body"`), `${name} body`);
    assert.match(html, new RegExp(`id="${name}-error"`), `${name} error`);
    assert.match(script, new RegExp(`'${name}-body'`), `${name} is loaded by the script`);
  }
});

test('the page has no inline script, no inline style and no password field', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, 'inline script');
  assert.doesNotMatch(html, /\sstyle="/i, 'inline style');
  assert.doesNotMatch(html, /type\s*=\s*["']?password/i, 'password field');
});

test('the script sets no inline styles and writes no HTML from strings', () => {
  assert.doesNotMatch(script, /\.style\b/, 'style property');
  assert.doesNotMatch(script, /setAttribute\(\s*['"]style['"]/, 'style attribute');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(script, /localStorage/);
});

test('the script only accepts QR images as data URLs of a PNG', () => {
  assert.match(script, /startsWith\(QR_PREFIX\)/);
  assert.match(script, /data:image\/png;base64,/);
});

test('internal IDs are not written to the page as text', () => {
  // Rows are built from named fields; the IDs are used only inside request and button handlers.
  assert.doesNotMatch(script, /textContent\s*=\s*[^;]*\.id\b/);
  assert.doesNotMatch(script, /paragraph\([^)]*\.id\b/);
});

test('every status on the dashboard has plain-language text from messages.js', () => {
  for (const fn of ['messageForRequest', 'messageForSubscription', 'messageForPool', 'messageForMovement', 'messageForStatus']) {
    assert.match(script, new RegExp(fn));
    assert.match(messages, new RegExp(`export function ${fn}\\(`));
  }
});

test('the sections without a finished feature say so instead of showing a dead form', () => {
  assert.match(script, /Creating offers is coming soon/);
  assert.match(script, /Creating pools is coming soon/);
});
