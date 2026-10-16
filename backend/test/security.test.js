// Security checks (prompt 15): headers, error shapes, and page content. No network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-security-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'production';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');

runMigrations(getDb());
after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(here, '..', '..', 'frontend');

async function withServer(callback) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('every response carries the browser protections', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-powered-by'), null, 'the framework is not advertised');

    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(/unsafe-inline|unsafe-eval/.test(csp), false, 'no inline scripts or eval');
  });
});

test('error responses never include a stack trace, even outside production checks', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-token' },
      body: '{ broken',
    });
    const text = await response.text();
    assert.equal(response.status, 400, 'the body is parsed before the route runs');
    assert.match(text, /invalid_json/);
    assert.equal(/stack|at \w+ \(|\.js:\d+/.test(text), false, 'no stack in the body');
  });

  await withServer(async (base) => {
    const response = await fetch(`${base}/no-such-page`);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId']);
  });
});

test('pages use no inline style attributes, so the style policy can stay strict', () => {
  const pages = ['index.html', 'new.html', 'payment.html', 'claim.html'];
  for (const page of pages) {
    const html = readFileSync(join(frontendDir, page), 'utf8');
    assert.equal(/\sstyle="/.test(html), false, `${page} uses an inline style`);
  }
});
