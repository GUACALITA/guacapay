// Live payment status over WebSocket at /ws.
// The client sends { type: "subscribe", paymentId, token } as its first message. The token is read from
// the message body, not the URL, so it does not end up in server or proxy logs.
import { WebSocketServer } from 'ws';
import { verifyTokenPayload } from '../auth/tokens.js';
import { AppError } from '../errors.js';
import { getPaymentForUser } from '../payments/service.js';
import { PAYMENT_UPDATED, paymentEvents } from '../payments/events.js';
import { logger } from '../logger.js';

const DEFAULTS = Object.freeze({
  pingIntervalMs: 30 * 1000,
  pongTimeoutMs: 10 * 1000,
  authTimeoutMs: 10 * 1000,
  maxMessageBytes: 4096,
});

const POLICY_VIOLATION = 1008;

export function attachLiveStatus(httpServer, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: settings.maxMessageBytes });

  // paymentId -> set of sockets watching it
  const watchers = new Map();

  function send(socket, message) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendError(socket, code, message) {
    send(socket, { type: 'error', code, message });
  }

  // Sends an error, then closes the socket with a policy-violation code so the client knows not to retry blindly.
  function closeWithError(socket, code, message) {
    sendError(socket, code, message);
    socket.close(POLICY_VIOLATION, code);
  }

  function watch(socket, paymentId) {
    if (!watchers.has(paymentId)) watchers.set(paymentId, new Set());
    watchers.get(paymentId).add(socket);
    socket.watching.add(paymentId);
  }

  function unwatchAll(socket) {
    for (const paymentId of socket.watching) {
      const set = watchers.get(paymentId);
      if (!set) continue;
      set.delete(socket);
      if (set.size === 0) watchers.delete(paymentId);
    }
    socket.watching.clear();
  }

  function handleSubscribe(socket, message) {
    if (typeof message.paymentId !== 'string' || message.paymentId.length === 0) {
      return sendError(socket, 'invalid_message', 'paymentId is required.');
    }

    // The first subscribe must carry a valid token. Later ones use the authenticated user.
    if (!socket.user) {
      let payload;
      try {
        payload = verifyTokenPayload(message.token);
      } catch {
        return closeWithError(socket, 'unauthorized', 'Sign in to continue.');
      }

      socket.user = { id: payload.sub };
      clearTimeout(socket.authTimer);

      // Close when the token expires, so a session that has ended stops receiving updates.
      if (typeof payload.exp === 'number') {
        const msLeft = payload.exp * 1000 - Date.now();
        socket.expiryTimer = setTimeout(
          () => closeWithError(socket, 'session_expired', 'Session expired. Sign in again.'),
          Math.max(0, msLeft),
        );
      }
    }

    let payment;
    try {
      payment = getPaymentForUser(message.paymentId, socket.user.id);
    } catch (err) {
      if (err instanceof AppError) {
        return sendError(socket, err.code, err.message);
      }
      throw err;
    }

    watch(socket, payment.id);
    send(socket, { type: 'subscribed', paymentId: payment.id, status: payment.status });
  }

  function handleMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return sendError(socket, 'invalid_message', 'Message must be JSON.');
    }

    if (!message || typeof message !== 'object' || message.type !== 'subscribe') {
      return sendError(socket, 'invalid_message', 'Expected a subscribe message.');
    }

    handleSubscribe(socket, message);
  }

  function startHeartbeat(socket) {
    const timer = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      // A client that does not answer the ping in time is dropped.
      socket.pongTimer = setTimeout(() => socket.terminate(), settings.pongTimeoutMs);
      socket.ping();
    }, settings.pingIntervalMs);
    socket.on('pong', () => clearTimeout(socket.pongTimer));
    return timer;
  }

  wss.on('connection', (socket) => {
    socket.user = null;
    socket.watching = new Set();

    // A socket that never authenticates is closed.
    socket.authTimer = setTimeout(
      () => closeWithError(socket, 'auth_timeout', 'Send a subscribe message with a token first.'),
      settings.authTimeoutMs,
    );

    const heartbeat = startHeartbeat(socket);

    socket.on('message', (raw) => handleMessage(socket, raw));
    socket.on('error', (err) => logger.warn('socket error', { error: err.message }));
    socket.on('close', () => {
      clearTimeout(socket.authTimer);
      clearTimeout(socket.expiryTimer);
      clearTimeout(socket.pongTimer);
      clearInterval(heartbeat);
      unwatchAll(socket);
    });
  });

  // Each update goes only to sockets watching that payment.
  const onUpdate = ({ paymentId, status, at }) => {
    const sockets = watchers.get(paymentId);
    if (!sockets) return;
    for (const socket of sockets) {
      send(socket, { type: 'payment.updated', paymentId, status, at });
    }
  };
  paymentEvents.on(PAYMENT_UPDATED, onUpdate);

  return {
    close() {
      paymentEvents.off(PAYMENT_UPDATED, onUpdate);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
