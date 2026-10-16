// Browser module checks (prompt 09). Uses a fake WebSocket and a fake timer; no browser needed.
// The module lives in frontend/, so this test must run with the whole repository mounted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLiveStatus } from '../../frontend/js/live-status.js';

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    this.closedWith = null;
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  // Test helpers that simulate what the browser would do.
  fire(type, event = {}) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }

  open() {
    this.readyState = 1;
    this.fire('open');
  }
}

const location = { href: 'https://guacapay.test/payment.html?id=p1', protocol: 'https:' };
const TOKEN = 'session-token';
const PAYMENT_ID = 'p1';

function setup(overrides = {}) {
  FakeSocket.instances = [];
  const timers = [];
  const updates = [];
  const errors = [];

  const live = connectLiveStatus({
    paymentId: PAYMENT_ID,
    token: TOKEN,
    onUpdate: (m) => updates.push(m),
    onError: (m) => errors.push(m),
    WebSocketImpl: FakeSocket,
    location,
    setTimer: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimer: () => {},
    ...overrides,
  });

  return { live, timers, updates, errors, socket: () => FakeSocket.instances.at(-1) };
}

test('connects to /ws on the same host, over wss for https pages, and subscribes with the token', () => {
  const { socket } = setup();
  const current = socket();

  assert.equal(current.url, 'wss://guacapay.test/ws');

  current.open();
  assert.deepEqual(current.sent, [{ type: 'subscribe', paymentId: PAYMENT_ID, token: TOKEN }]);
});

test('updates from the server reach the caller', () => {
  const { socket, updates } = setup();
  socket().open();

  socket().fire('message', { data: JSON.stringify({ type: 'subscribed', paymentId: PAYMENT_ID, status: 'created' }) });
  socket().fire('message', {
    data: JSON.stringify({ type: 'payment.updated', paymentId: PAYMENT_ID, status: 'awaiting_payment', at: 'now' }),
  });

  assert.equal(updates.length, 2);
  assert.equal(updates[1].status, 'awaiting_payment');
});

test('a dropped connection is retried, and the backoff grows', () => {
  const { socket, timers } = setup();

  socket().open();
  socket().fire('close', { code: 1006 });
  socket().fire('close', { code: 1006 });
  socket().fire('close', { code: 1006 });

  assert.equal(timers.length, 3);
  assert.ok(timers[0].delay >= 850 && timers[0].delay <= 1150, `first retry ${timers[0].delay}ms`);
  assert.ok(timers[1].delay > timers[0].delay, 'second retry waits longer');
  assert.ok(timers[2].delay > timers[1].delay, 'third retry waits longer still');
  assert.ok(timers.every((t) => t.delay <= 30000 * 1.15), 'never beyond the cap');
});

test('running the scheduled retry opens a new socket and subscribes again', () => {
  const { socket, timers } = setup();

  socket().open();
  socket().fire('close', { code: 1006 });
  timers[0].fn();

  assert.equal(FakeSocket.instances.length, 2);
  socket().open();
  assert.equal(socket().sent.length, 1);
  assert.equal(socket().sent[0].type, 'subscribe');
});

test('the server refusing the session (1008) stops retries', () => {
  const { socket, timers } = setup();

  socket().open();
  socket().fire('close', { code: 1008 });

  assert.equal(timers.length, 0, 'no retry is scheduled');
});

test('a token error stops retries and is reported to the caller', () => {
  const { socket, timers, errors } = setup();

  socket().open();
  socket().fire('message', { data: JSON.stringify({ type: 'error', code: 'session_expired', message: 'Expired.' }) });
  socket().fire('close', { code: 1008 });

  assert.equal(errors[0].code, 'session_expired');
  assert.equal(timers.length, 0);
});

test('close() stops the connection and cancels any retry', () => {
  const { live, socket, timers } = setup();

  socket().open();
  socket().fire('close', { code: 1006 });
  live.close();
  timers[0].fn();

  assert.equal(FakeSocket.instances.length, 1, 'no new socket after close()');
});
