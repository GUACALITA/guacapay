// Frontend shell checks (prompt 10). No browser needed: the API client and banner are tested with fakes,
// and the pages are checked as files. Runs with the whole repository mounted, since the frontend lives outside backend/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createApi, ApiError } from '../../frontend/js/api.js';
import { showSandboxBanner } from '../../frontend/js/shell.js';

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(here, '..', '..', 'frontend');
const backendDir = join(here, '..');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('a successful call returns the parsed body and sends no token when signed out', async () => {
  let sent;
  const api = createApi({
    storage: memoryStorage(),
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return jsonResponse(200, { ok: true });
    },
  });

  assert.deepEqual(await api.get('/health'), { ok: true });
  assert.equal(sent.url, '/health');
  assert.equal(sent.options.headers.Authorization, undefined);
});

test('a stored session token is sent as a Bearer header', async () => {
  let headers;
  const api = createApi({
    storage: memoryStorage({ 'guacapay.session': 'abc.def.ghi' }),
    fetchImpl: async (url, options) => {
      headers = options.headers;
      return jsonResponse(200, {});
    },
  });

  await api.get('/api/payments');
  assert.equal(headers.Authorization, 'Bearer abc.def.ghi');
});

test('an error response becomes an ApiError with the backend code, message, status and request ID', async () => {
  const api = createApi({
    storage: memoryStorage(),
    fetchImpl: async () =>
      jsonResponse(429, { error: { code: 'rate_limited', message: 'Too many requests.', requestId: 'r-1' } }),
  });

  await assert.rejects(
    () => api.post('/api/auth/request-code', { email: 'a@b.co' }),
    (err) =>
      err instanceof ApiError &&
      err.code === 'rate_limited' &&
      err.message === 'Too many requests.' &&
      err.status === 429 &&
      err.requestId === 'r-1',
  );
});

test('a non-JSON error response gets a generic message, not raw HTML', async () => {
  const api = createApi({
    storage: memoryStorage(),
    fetchImpl: async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
  });

  await assert.rejects(
    () => api.get('/api/payments'),
    (err) => err.code === 'http_error' && err.status === 502 && !err.message.includes('<html>'),
  );
});

test('a network failure becomes network_error with status 0', async () => {
  const api = createApi({
    storage: memoryStorage(),
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    () => api.get('/health'),
    (err) => err.code === 'network_error' && err.status === 0,
  );
});

test('a 401 while signed in ends the session', async () => {
  const storage = memoryStorage({ 'guacapay.session': 'expired-token' });
  const api = createApi({
    storage,
    fetchImpl: async () => jsonResponse(401, { error: { code: 'unauthorized', message: 'Sign in to continue.' } }),
  });

  await assert.rejects(() => api.get('/api/payments'), (err) => err.status === 401);
  assert.equal(api.getToken(), null);
  assert.equal(storage.data['guacapay.session'], undefined);
});

test('blocked storage does not break the page: the user is simply signed out', async () => {
  const brokenStorage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  const api = createApi({ storage: brokenStorage, fetchImpl: async () => jsonResponse(200, { ok: true }) });

  assert.equal(api.getToken(), null);
  api.setToken('x');
  assert.deepEqual(await api.get('/health'), { ok: true });
});

test('the banner shows only in sandbox mode, and stays hidden if the config cannot be read', async () => {
  const banner = { hidden: true };
  const root = { getElementById: (id) => (id === 'sandbox-banner' ? banner : null) };

  await showSandboxBanner({ root, client: { get: async () => ({ sandbox: true }) } });
  assert.equal(banner.hidden, false);

  await showSandboxBanner({ root, client: { get: async () => ({ sandbox: false }) } });
  assert.equal(banner.hidden, true);

  banner.hidden = false;
  await showSandboxBanner({
    root,
    client: {
      get: async () => {
        throw new Error('offline');
      },
    },
  });
  assert.equal(banner.hidden, true);
});

test('/api/config reports sandbox mode from RAPYD_SANDBOX', async () => {
  const run = (value) =>
    new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        JWT_SECRET: 'placeholder-secret-value-0123456789abcdef',
        HMAC_SECRET: 'placeholder-secret-value-0123456789abcdef',
        GATEWAY_TOKEN: 'placeholder-secret-value-0123456789abcdef',
        DATABASE_PATH: join(tmpdir(), `guacapay-config-${process.pid}.db`),
      };
      if (value === undefined) delete env.RAPYD_SANDBOX;
      else env.RAPYD_SANDBOX = value;

      const script = `
        const { createApp } = await import(${JSON.stringify(join(backendDir, 'src', 'app.js'))});
        const server = createApp().listen(0, '127.0.0.1', async () => {
          const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/config');
          console.log(JSON.stringify(await res.json()));
          server.close();
        });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, cwd: backendDir });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err))));
    });

  assert.equal((await run(undefined)).sandbox, true, 'sandbox is the default');
  assert.equal((await run('true')).sandbox, true);
  assert.equal((await run('false')).sandbox, false);
});

test('every page has the viewport, styles, shell script and banner', () => {
  const pages = ['index.html', 'new.html', 'payment.html', 'claim.html'];
  for (const page of pages) {
    const html = readFileSync(join(frontendDir, page), 'utf8');
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, page);
    assert.match(html, /href="css\/main\.css"/, page);
    assert.match(html, /src="js\/shell\.js"/, page);
    assert.match(html, /id="sandbox-banner"/, page);
  }
});

test('the stylesheet keeps a 16px gutter and a fluid column, and defines colors as tokens', () => {
  const css = readFileSync(join(frontendDir, 'css', 'main.css'), 'utf8');
  assert.match(css, /\.page \{[^}]*padding: 16px;/);
  assert.match(css, /\.page \{[^}]*max-width: 640px;/);
  assert.match(css, /width: 100%;/);
  assert.match(css, /:root \{/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /:root\[data-theme="dark"\]/);
});

test('no frontend file uses localStorage for the session', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(html|js)$/.test(name)) files.push(path);
    }
  };
  walk(frontendDir);

  assert.ok(files.length >= 6);
  // Matches code that uses the object (localStorage.x or localStorage[x]), not comments that mention it.
  const usage = /localStorage\s*(\.\w+|\[)/;
  for (const file of files) {
    assert.ok(!usage.test(readFileSync(file, 'utf8')), `localStorage used in ${file}`);
  }
});
