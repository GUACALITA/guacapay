// Wiring for dashboard.html: one home page with a section for each feature. Each section loads on its own,
// shows its own empty state and its own error. Server text is only ever set with textContent.
import { api } from '../api.js';
import {
  messageForError,
  messageForInterval,
  messageForMovement,
  messageForPool,
  messageForRequest,
  messageForRole,
  messageForStatus,
  messageForSubscription,
} from '../messages.js';
import { formatCents, parseAmountToCents } from '../money.js';

const $ = (id) => document.getElementById(id);
const QR_PREFIX = 'data:image/png;base64,';
const POOL_KIND_TEXT = Object.freeze({ collection: 'Collection', tanda: 'Tanda' });
const WALLET_STATUS_TEXT = Object.freeze({
  pending: 'Waiting for your approval in the wallet',
  linked: 'Linked',
  revoked: 'Revoked',
});

const SESSION_ERRORS = ['unauthorized', 'session_expired'];

function signOut() {
  $('dashboard').hidden = true;
  $('signed-out').hidden = false;
}

function setError(errorId, error) {
  const el = $(errorId);
  el.textContent = messageForError(error);
  el.hidden = false;
}

function clearError(errorId) {
  $(errorId).textContent = '';
  $(errorId).hidden = true;
}

// Runs one section. A rejected session ends the whole page; any other error is shown in that section only.
async function section(bodyId, errorId, load) {
  clearError(errorId);
  try {
    await load();
  } catch (error) {
    if (SESSION_ERRORS.includes(error?.code)) {
      signOut();
      return;
    }
    $(bodyId).replaceChildren();
    setError(errorId, error);
  }
}

function paragraph(text, className) {
  const p = document.createElement('p');
  if (className) p.className = className;
  p.textContent = text;
  return p;
}

// An empty state: one line of text and one clear action.
function emptyState(bodyId, text, action) {
  const nodes = [paragraph(text, 'muted')];
  if (action) {
    const link = document.createElement('a');
    link.href = action.href;
    link.textContent = action.label;
    nodes.push(paragraph('', null));
    nodes[nodes.length - 1].append(link);
  }
  $(bodyId).replaceChildren(...nodes);
}

// A list of rows. Each row is an array of text lines, plus an optional button.
function list(bodyId, rows) {
  const items = rows.map(({ lines, button }) => {
    const item = document.createElement('li');
    for (const line of lines) item.append(paragraph(line));
    if (button) {
      const control = document.createElement('button');
      control.type = 'button';
      control.textContent = button.label;
      control.addEventListener('click', button.onClick);
      item.append(control);
    }
    return item;
  });
  const ul = document.createElement('ul');
  ul.append(...items);
  $(bodyId).replaceChildren(ul);
}

function dateText(iso) {
  return new Date(iso).toLocaleDateString();
}

// ---- My wallet ----

async function loadWallet() {
  const { wallets } = await api.get('/api/wallets');
  const linked = wallets.filter((wallet) => wallet.status === 'linked');

  // The request form can only use linked wallets.
  $('request-wallet').replaceChildren(
    ...linked.map((wallet) => {
      const option = new Option(wallet.wallet_url, wallet.id);
      option.dataset.currency = wallet.asset_code;
      return option;
    }),
  );

  if (wallets.length === 0) {
    emptyState('wallet-body', 'No wallet yet.', { href: 'wallet-setup.html', label: 'Set up a test wallet' });
    return;
  }
  list(
    'wallet-body',
    wallets.map((wallet) => ({
      lines: [wallet.wallet_url, `${wallet.asset_code} · ${WALLET_STATUS_TEXT[wallet.status] ?? 'Status unknown'}`],
      button: wallet.status === 'revoked'
        ? null
        : {
            label: 'Unlink this wallet',
            onClick: async () => {
              await api.post(`/api/wallets/${encodeURIComponent(wallet.id)}/revoke`);
              await section('wallet-body', 'wallet-error', loadWallet);
            },
          },
    })),
  );
}

// ---- My money ----

async function loadMoney() {
  const [{ balances }, { payments }] = await Promise.all([api.get('/api/balance'), api.get('/api/payments')]);

  // Money sent and not yet claimed by its recipient, per currency.
  const waiting = new Map();
  for (const payment of payments) {
    if (payment.status !== 'claimable') continue;
    waiting.set(payment.currency, (waiting.get(payment.currency) ?? 0) + payment.amount_cents);
  }

  if (balances.length === 0 && waiting.size === 0) {
    emptyState('money-body', 'No money yet.', { href: 'wallet-setup.html', label: 'Set up a test wallet to start' });
    return;
  }

  const rows = balances.map((row) => ({ lines: [`App balance: ${formatCents(row.balance_cents, row.currency)}`] }));
  for (const [currency, cents] of waiting) {
    rows.push({ lines: [`Waiting to be claimed: ${formatCents(cents, currency)}`] });
  }
  list('money-body', rows);
}

// ---- Requests ----

async function loadRequests() {
  const { requests } = await api.get('/api/requests');
  if (requests.length === 0) {
    emptyState('requests-body', 'No requests yet. Create one above.', null);
    return;
  }
  list(
    'requests-body',
    requests.map((request) => ({
      lines: [
        formatCents(request.amount_cents, request.currency),
        request.note ?? 'No note',
        messageForRequest(request.status),
        `Expires ${dateText(request.expires_at)}`,
      ],
      button: request.status === 'open'
        ? {
            label: 'Close this request',
            onClick: async () => {
              await api.post(`/api/requests/${encodeURIComponent(request.id)}/close`);
              await section('requests-body', 'requests-error', loadRequests);
            },
          }
        : null,
    })),
  );
}

function showShare(result) {
  $('request-share').hidden = false;
  $('request-link').textContent = result.link;
  if (typeof result.qr === 'string' && result.qr.startsWith(QR_PREFIX)) {
    $('request-qr').src = result.qr;
  }
}

async function onRequestSubmit(event) {
  event.preventDefault();
  $('request-form-error').hidden = true;
  const cents = parseAmountToCents($('request-amount').value);
  if (cents === null) {
    $('request-form-error').textContent = messageForError({ code: 'invalid_amount' });
    $('request-form-error').hidden = false;
    return;
  }
  const option = $('request-wallet').selectedOptions[0];
  if (!option) {
    $('request-form-error').textContent = messageForError({ code: 'wallet_not_linked' });
    $('request-form-error').hidden = false;
    return;
  }

  $('request-submit').disabled = true;
  $('request-status').textContent = 'Creating request…';
  try {
    const result = await api.post('/api/requests', {
      wallet_id: option.value,
      amount_cents: cents,
      currency: option.dataset.currency,
      note: $('request-note').value.trim() || null,
    });
    showShare(result);
    $('request-amount').value = '';
    $('request-note').value = '';
    $('request-status').textContent = 'Request created. Copy the link now; it is not shown again.';
    await section('requests-body', 'requests-error', loadRequests);
  } catch (error) {
    if (SESSION_ERRORS.includes(error?.code)) {
      signOut();
      return;
    }
    $('request-status').textContent = messageForError(error);
  } finally {
    $('request-submit').disabled = false;
  }
}

// ---- Subscriptions ----

async function loadSubscriptions() {
  const { subscriptions } = await api.get('/api/subscriptions');
  const offers = subscriptions.filter((item) => item.role === 'payee');
  const payments = subscriptions.filter((item) => item.role === 'payer');

  const body = document.createDocumentFragment();
  body.append(paragraph('Offers I sent', 'muted'), paragraph(messageForRole('payee'), 'muted'));
  if (offers.length === 0) {
    body.append(paragraph('No offers sent. Creating offers is coming soon.', 'muted'));
  } else {
    body.append(subscriptionList(offers, false));
  }

  body.append(paragraph('Subscriptions I pay', 'muted'), paragraph(messageForRole('payer'), 'muted'));
  if (payments.length === 0) {
    body.append(paragraph('You pay no subscriptions.', 'muted'));
  } else {
    body.append(subscriptionList(payments, true));
  }
  $('subscriptions-body').replaceChildren(body);
}

function subscriptionList(items, cancellable) {
  const ul = document.createElement('ul');
  ul.append(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.append(
        paragraph(`${formatCents(item.amount_cents, item.currency)}, ${messageForInterval(item.interval)}`),
        paragraph(messageForSubscription(item.status), 'muted'),
      );
      if (cancellable && (item.status === 'active' || item.status === 'paused' || item.status === 'pending')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Cancel this subscription';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api.post(`/api/subscriptions/${encodeURIComponent(item.id)}/cancel`);
            await section('subscriptions-body', 'subscriptions-error', loadSubscriptions);
          } catch (error) {
            button.disabled = false;
            setError('subscriptions-error', error);
          }
        });
        li.append(button);
      }
      return li;
    }),
  );
  return ul;
}

// ---- Pools ----

async function loadPools() {
  const { pools } = await api.get('/api/pools');
  if (pools.length === 0) {
    emptyState('pools-body', 'You are not in any pool. Creating pools is coming soon.', null);
    return;
  }
  list(
    'pools-body',
    pools.map((pool) => ({
      lines: [
        POOL_KIND_TEXT[pool.kind] ?? 'Pool',
        pool.kind === 'collection' && pool.goal_cents
          ? `Goal ${formatCents(pool.goal_cents, pool.currency)}`
          : `Each period ${formatCents(pool.share_cents, pool.currency)}`,
        messageForPool(pool.status),
      ],
    })),
  );
}

// ---- History ----

async function loadHistory() {
  const [{ payments }, { withdrawals }, { deposits }] = await Promise.all([
    api.get('/api/payments'),
    api.get('/api/withdrawals'),
    api.get('/api/deposits'),
  ]);

  const entries = [
    ...payments.map((p) => ({ at: p.created_at, text: `Payment to ${p.recipient_email}`, amount: p.amount_cents, currency: p.currency, status: messageForStatus(p.status) })),
    ...withdrawals.map((w) => ({ at: w.created_at, text: 'Withdrawal to your wallet', amount: w.amount_cents, currency: w.currency, status: messageForMovement(w.status) })),
    ...deposits.map((d) => ({ at: d.created_at, text: 'Deposit from your wallet', amount: d.amount_cents, currency: d.currency, status: messageForMovement(d.status) })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  if (entries.length === 0) {
    emptyState('history-body', 'No activity yet.', { href: 'new.html', label: 'Send money' });
    return;
  }
  list(
    'history-body',
    entries.map((entry) => ({
      lines: [`${dateText(entry.at)} · ${entry.text}`, formatCents(entry.amount, entry.currency), entry.status],
    })),
  );
}

// ---- Start ----

async function start() {
  if (!api.isSignedIn()) {
    $('signed-out').hidden = false;
    return;
  }
  $('dashboard').hidden = false;
  $('request-form').addEventListener('submit', onRequestSubmit);

  await Promise.all([
    section('wallet-body', 'wallet-error', loadWallet),
    section('money-body', 'money-error', loadMoney),
    section('requests-body', 'requests-error', loadRequests),
    section('subscriptions-body', 'subscriptions-error', loadSubscriptions),
    section('pools-body', 'pools-error', loadPools),
    section('history-body', 'history-error', loadHistory),
  ]);
}

start();
