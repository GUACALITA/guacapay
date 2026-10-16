// Live payment status for the browser. Subscribes with the session token and reconnects after network drops.
// The token is passed in by the caller; this module does not read or store it.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const POLICY_VIOLATION = 1008;

// Errors that mean retrying will not help. The caller decides what to show.
const STOP_ON_ERROR = new Set(['unauthorized', 'session_expired', 'payment_not_found', 'invalid_message', 'auth_timeout']);

export function connectLiveStatus({
  paymentId,
  token,
  onUpdate = () => {},
  onError = () => {},
  WebSocketImpl = globalThis.WebSocket,
  location = globalThis.location,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let socket = null;
  let attempt = 0;
  let timer = null;
  let stopped = false;

  function socketUrl() {
    const url = new URL('/ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  // Exponential backoff with a little jitter, so many tabs do not reconnect at the same moment.
  function scheduleReconnect() {
    const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    const delay = Math.round(base * (0.85 + Math.random() * 0.3));
    attempt += 1;
    timer = setTimer(open, delay);
  }

  function stop() {
    stopped = true;
    clearTimer(timer);
    if (socket && socket.readyState <= 1) {
      socket.close(1000, 'client stopped');
    }
  }

  function handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'subscribed' || message.type === 'payment.updated') {
      onUpdate(message);
      return;
    }

    if (message.type === 'error') {
      onError(message);
      if (STOP_ON_ERROR.has(message.code)) stop();
    }
  }

  function open() {
    if (stopped) return;
    socket = new WebSocketImpl(socketUrl());

    socket.addEventListener('open', () => {
      attempt = 0;
      socket.send(JSON.stringify({ type: 'subscribe', paymentId, token }));
    });

    socket.addEventListener('message', handleMessage);

    socket.addEventListener('close', (event) => {
      if (stopped) return;
      // The server closes with 1008 when it refuses the session. Retrying would repeat the same refusal.
      if (event.code === POLICY_VIOLATION) {
        stop();
        return;
      }
      scheduleReconnect();
    });
  }

  open();

  return { close: stop };
}
