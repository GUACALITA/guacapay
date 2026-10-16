// Backend core checks (prompt 02). Uses Node's built-in test runner; no network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';

// Clean environment: no leftover secrets or ports from the developer's shell.
function baseEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(JWT_SECRET|HMAC_SECRET|APP_PORT|RAPYD_|NODE_ENV)/.test(name)) delete env[name];
  }
  return {
    ...env,
    JWT_SECRET: PLACEHOLDER_SECRET,
    HMAC_SECRET: PLACEHOLDER_SECRET,
    GATEWAY_TOKEN: PLACEHOLDER_SECRET,
    ...overrides,
  };
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: backendDir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], { cwd: backendDir, env });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('app listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', () => {
      clearTimeout(timer);
      reject(new Error(`server exited early: ${output}`));
    });
  });
}

test('startup fails and names JWT_SECRET when it is missing', async () => {
  const env = baseEnv();
  delete env.JWT_SECRET;

  const result = await runNode(['src/server.js'], env);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /JWT_SECRET is required/);
});

test('startup fails on a short secret without printing its value', async () => {
  const shortValue = 'too-short-123';
  const result = await runNode(['src/server.js'], baseEnv({ JWT_SECRET: shortValue }));

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /JWT_SECRET must be at least 32 characters/);
  assert.ok(!result.stderr.includes(shortValue), 'secret value must not appear in the error');
});

test('health, request ID, and JSON errors', async (t) => {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = await startServer(baseEnv({ APP_PORT: String(port) }));
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.ok(health.headers.get('x-request-id'), 'X-Request-Id header must be set');
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.service, 'app');
  assert.equal(typeof healthBody.version, 'string');

  const missing = await fetch(`${base}/no-such-route`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.code, 'not_found');
  assert.ok(missingBody.error.requestId, 'error must carry the request ID');

  const badJson = await fetch(`${base}/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(badJson.status, 400);
  const badJsonBody = await badJson.json();
  assert.equal(badJsonBody.error.code, 'invalid_json');
});

test('logger masks secret values and secret-named fields', async () => {
  const secret = 'rapyd-test-value-0123456789';
  const loggerUrl = pathToFileURL(join(backendDir, 'src', 'logger.js')).href;
  const script = `
    const { logger } = await import(${JSON.stringify(loggerUrl)});
    logger.info('value is ' + process.env.RAPYD_SECRET_KEY, { note: process.env.RAPYD_SECRET_KEY, RAPYD_SECRET_KEY: 'visible' });
  `;

  const result = await runNode(['--input-type=module', '-e', script], baseEnv({ RAPYD_SECRET_KEY: secret }));

  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes(secret), 'secret value must not appear in log output');
  assert.ok(!result.stdout.includes('visible'), 'secret-named field must be redacted');
  assert.match(result.stdout, /\[REDACTED\]/);
});
