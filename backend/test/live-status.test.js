// Live status over WebSocket (prompt 09). Real server and real ws clients, on a temporary database; no network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-ws-'));

process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.PAYMENT_CURRENCIES = 'USD';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { createPayment, transitionPayment } = await import('../src/payments/service.js');
const { STATUS } = await import('../src/payments/states.js');
const { attachLiveStatus } = await import('../src/ws/live-status.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeUser() {
  const id = randomUUID();
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@example.com`);
  return { id, token: issueToken(id) };
}

function makePayment(senderId) {
  return createPayment({
    senderId,
    body: { recipient_email: 'recipient@example.com', amount_cents: 1500, currency: 'USD' },
  }).payment;
}

// Starts the app with its WebSocket, using short timers so the tests run quickly.
async function startServer(options = {}) {
  const server = createServer(createApp());
  const live = attachLiveStatus(server, {
    pingIntervalMs: 100,
    pongTimeoutMs: 1000,
    authTimeoutMs: 300,
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `ws://127.0.0.1:${server.address().port}/ws`,
    close: () => {
      live.close();
      server.closeAllConnections();
      server.close();
    },
  };
}

// Opens a socket and collects every message it receives.
async function connect(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
  await once(socket, 'open');
  return { socket, messages, closed };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

const subscribe = (socket, paymentId, token) =>
  socket.send(JSON.stringify({ type: 'subscribe', paymentId, token }));

test('a subscribed client receives its payment status and each change, as it happens', async (t) => {
  const alice = makeUser();
  const payment = makePayment(alice.id);
  const server = await startServer();
  t.after(() => server.close());

  const client = await connect(server.url);
  t.after(() => client.socket.close());

  subscribe(client.socket, payment.id, alice.token);
  assert.ok(await waitFor(() => client.messages.some((m) => m.type === 'subscribed')));
  assert.equal(client.messages.find((m) => m.type === 'subscribed').status, STATUS.CREATED);

  transitionPayment(payment.id, STATUS.AWAITING_PAYMENT);
  assert.ok(await waitFor(() => client.messages.some((m) => m.type === 'payment.updated')));
  const update = client.messages.find((m) => m.type === 'payment.updated');
  assert.equal(update.paymentId, payment.id);
  assert.equal(update.status, STATUS.AWAITING_PAYMENT);
  assert.match(update.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('two tabs watching the same payment both receive the update', async (t) => {
  const alice = makeUser();
  const payment = makePayment(alice.id);
  const server = await startServer();
  t.after(() => server.close());

  const first = await connect(server.url);
  const second = await connect(server.url);
  t.after(() => {
    first.socket.close();
    second.socket.close();
  });

  subscribe(first.socket, payment.id, alice.token);
  subscribe(second.socket, payment.id, alice.token);
  assert.ok(await waitFor(() => first.messages.length === 1 && second.messages.length === 1));

  transitionPayment(payment.id, STATUS.AWAITING_PAYMENT);
  assert.ok(await waitFor(() => first.messages.some((m) => m.type === 'payment.updated')));
  assert.ok(await waitFor(() => second.messages.some((m) => m.type === 'payment.updated')));
});

test('a client gets nothing about another user\'s payment', async (t) => {
  const alice = makeUser();
  const bob = makeUser();
  const alicePayment = makePayment(alice.id);
  const server = await startServer();
  t.after(() => server.close());

  const intruder = await connect(server.url);
  t.after(() => intruder.socket.close());

  subscribe(intruder.socket, alicePayment.id, bob.token);
  assert.ok(await waitFor(() => intruder.messages.some((m) => m.type === 'error')));
  assert.equal(intruder.messages.find((m) => m.type === 'error').code, 'payment_not_found');

  transitionPayment(alicePayment.id, STATUS.AWAITING_PAYMENT);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(intruder.messages.filter((m) => m.type === 'payment.updated').length, 0);
});

test('an invalid token is refused and the socket is closed with 1008', async (t) => {
  const alice = makeUser();
  const payment = makePayment(alice.id);
  const server = await startServer();
  t.after(() => server.close());

  const client = await connect(server.url);
  subscribe(client.socket, payment.id, 'not-a-token');

  const code = await client.closed;
  assert.equal(code, 1008);
  assert.equal(client.messages[0].code, 'unauthorized');
});

test('a socket that never authenticates is closed after the auth timeout', async (t) => {
  const server = await startServer({ authTimeoutMs: 200 });
  t.after(() => server.close());

  const client = await connect(server.url);
  const code = await client.closed;
  assert.equal(code, 1008);
  assert.equal(client.messages[0].code, 'auth_timeout');
});

test('a malformed message gets an error, and the connection stays open', async (t) => {
  const alice = makeUser();
  const payment = makePayment(alice.id);
  const server = await startServer();
  t.after(() => server.close());

  const client = await connect(server.url);
  t.after(() => client.socket.close());

  client.socket.send('this is not json');
  assert.ok(await waitFor(() => client.messages.some((m) => m.type === 'error')));
  assert.equal(client.messages[0].code, 'invalid_message');
  assert.equal(client.socket.readyState, WebSocket.OPEN);

  subscribe(client.socket, payment.id, alice.token);
  assert.ok(await waitFor(() => client.messages.some((m) => m.type === 'subscribed')));
});

test('the connection is closed when the token expires', async (t) => {
  const alice = makeUser();
  const payment = makePayment(alice.id);
  const shortToken = jwt.sign({}, PLACEHOLDER_SECRET, { subject: alice.id, expiresIn: 2, algorithm: 'HS256' });
  const server = await startServer();
  t.after(() => server.close());

  const client = await connect(server.url);
  subscribe(client.socket, payment.id, shortToken);
  assert.ok(await waitFor(() => client.messages.some((m) => m.type === 'subscribed')));

  const code = await client.closed;
  assert.equal(code, 1008);
  assert.ok(client.messages.some((m) => m.type === 'error' && m.code === 'session_expired'));
});

test('the server pings idle clients on schedule and keeps those that answer', async (t) => {
  const server = await startServer({ pingIntervalMs: 50, pongTimeoutMs: 500 });
  t.after(() => server.close());

  const client = await connect(server.url);
  t.after(() => client.socket.close());

  let pings = 0;
  client.socket.on('ping', () => (pings += 1));

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(pings >= 2, `expected at least 2 pings, got ${pings}`);
  assert.equal(client.socket.readyState, WebSocket.OPEN);
});
