// Login with one-time code (prompt 04). Runs the app in-process with a fake mailer; no network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-auth-'));

process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { hashSecret } = await import('../src/hash.js');
const { generateCode } = await import('../src/auth/service.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function fakeMailer() {
  const sent = [];
  return {
    sent,
    async sendLoginCode(email, code) {
      sent.push({ email, code });
    },
  };
}

// Starts the app on a random port, runs the callback, then stops it.
async function withServer(mailer, callback) {
  const server = createApp({ mailer }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(base);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function post(base, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function requestCode(base, email) {
  return post(base, '/api/auth/request-code', { email });
}

function latestCodeRow(email) {
  return getDb().prepare('SELECT * FROM otp_codes WHERE email = ? ORDER BY rowid DESC LIMIT 1').get(email);
}

test('request-code answers the same for known and unknown addresses, and stores only a hash', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    // Create an account for bob first, so he is a "known" address.
    await requestCode(base, 'bob@example.com');
    await post(base, '/api/auth/verify-code', { email: 'bob@example.com', code: mailer.sent.at(-1).code });

    const known = await requestCode(base, 'bob@example.com');
    const unknown = await requestCode(base, 'nobody-yet@example.com');

    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(known.body, unknown.body);
  });

  const sentToBob = mailer.sent.filter((m) => m.email === 'bob@example.com').at(-1);
  const row = latestCodeRow('bob@example.com');
  assert.match(sentToBob.code, /^\d{6}$/);
  assert.notEqual(row.code_hash, sentToBob.code, 'the code itself must not be stored');
  assert.equal(row.code_hash, hashSecret(sentToBob.code));
  const ttlMs = Date.parse(row.expires_at) - Date.now();
  assert.ok(ttlMs > 9 * 60 * 1000 && ttlMs <= 10 * 60 * 1000, 'code expires in about 10 minutes');
});

test('a correct code returns a token whose subject is the user ID', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    await requestCode(base, 'alice@example.com');
    const { code } = mailer.sent.at(-1);

    const result = await post(base, '/api/auth/verify-code', { email: 'ALICE@example.com ', code });

    assert.equal(result.status, 200);
    assert.equal(result.body.tokenType, 'Bearer');
    assert.equal(result.body.expiresIn, 3600);

    const payload = jwt.verify(result.body.token, PLACEHOLDER_SECRET);
    const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get('alice@example.com');
    assert.equal(payload.sub, user.id);
    assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'sub'], 'token carries only the user ID');
  });
});

test('five wrong codes block the correct code', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    await requestCode(base, 'eve@example.com');
    const { code } = mailer.sent.at(-1);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await post(base, '/api/auth/verify-code', { email: 'eve@example.com', code: wrong });
      assert.equal(result.status, 401, `wrong attempt ${attempt}`);
      assert.equal(result.body.error.code, 'invalid_code');
    }

    const blocked = await post(base, '/api/auth/verify-code', { email: 'eve@example.com', code });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'too_many_attempts');
  });
});

test('an expired code is rejected', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    await requestCode(base, 'frank@example.com');
    const { code } = mailer.sent.at(-1);

    getDb()
      .prepare('UPDATE otp_codes SET expires_at = ? WHERE email = ?')
      .run(new Date(Date.now() - 1000).toISOString(), 'frank@example.com');

    const result = await post(base, '/api/auth/verify-code', { email: 'frank@example.com', code });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'invalid_code');
  });
});

test('a code cannot be used twice', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    await requestCode(base, 'grace@example.com');
    const { code } = mailer.sent.at(-1);

    assert.equal((await post(base, '/api/auth/verify-code', { email: 'grace@example.com', code })).status, 200);
    assert.equal((await post(base, '/api/auth/verify-code', { email: 'grace@example.com', code })).status, 401);
  });
});

test('a new code request replaces the pending one', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    await requestCode(base, 'heidi@example.com');
    const first = mailer.sent.at(-1).code;
    await requestCode(base, 'heidi@example.com');
    const second = mailer.sent.at(-1).code;

    if (first !== second) {
      const stale = await post(base, '/api/auth/verify-code', { email: 'heidi@example.com', code: first });
      assert.equal(stale.status, 401, 'the older code must no longer work');
    }
    const fresh = await post(base, '/api/auth/verify-code', { email: 'heidi@example.com', code: second });
    assert.equal(fresh.status, 200);
  });
});

test('the fourth code request for one address within 15 minutes is rate limited', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    for (let i = 1; i <= 3; i += 1) {
      assert.equal((await requestCode(base, 'dave@example.com')).status, 202, `request ${i}`);
    }
    const limited = await requestCode(base, 'dave@example.com');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.equal(mailer.sent.filter((m) => m.email === 'dave@example.com').length, 3);
  });
});

test('the eleventh request from one IP within 15 minutes is rate limited', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    for (let i = 1; i <= 10; i += 1) {
      assert.equal((await requestCode(base, `ip-user-${i}@example.com`)).status, 202, `request ${i}`);
    }
    const limited = await requestCode(base, 'ip-user-11@example.com');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
  });
});

test('protected route needs a valid token', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    await requestCode(base, 'ivan@example.com');
    const { code } = mailer.sent.at(-1);
    const { body } = await post(base, '/api/auth/verify-code', { email: 'ivan@example.com', code });

    const none = await fetch(`${base}/api/auth/me`);
    assert.equal(none.status, 401);

    const bad = await fetch(`${base}/api/auth/me`, { headers: { Authorization: 'Bearer not-a-token' } });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${body.token}` } });
    assert.equal(good.status, 200);
    const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get('ivan@example.com');
    assert.deepEqual(await good.json(), { id: user.id });
  });
});

test('an invalid email is rejected before anything is stored', async () => {
  const mailer = fakeMailer();
  await withServer(mailer, async (base) => {
    const result = await requestCode(base, 'not-an-email');
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_email');
    assert.equal(latestCodeRow('not-an-email'), undefined);
  });
});

test('without a configured mailer, no code is sent and the request fails clearly', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await requestCode(`http://127.0.0.1:${server.address().port}`, 'judy@example.com');
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'email_not_configured');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('generated codes are six digits and vary', () => {
  const codes = new Set();
  for (let i = 0; i < 1000; i += 1) {
    const code = generateCode();
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size > 900, 'codes should be spread across the range');
});
