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
  const p = document.createElement('p');
  p.style.cssText = 'color:var(--gp-text3,#5a6a82);font-size:.88rem;margin:8px 0 4px';
  p.textContent = text;
  const nodes = [p];
  if (action) {
    const link = document.createElement('a');
    link.href = action.href;
    link.textContent = action.label;
    link.style.cssText = 'font-size:.88rem';
    nodes.push(link);
  }
  $(bodyId).replaceChildren(...nodes);
}

// A list of rows. Each row is an array of text lines, plus an optional button.
function list(bodyId, rows) {
  const items = rows.map(({ lines, button }) => {
    const item = document.createElement('li');
    item.style.cssText = 'background:var(--gp-card2,#1a2333);border:1px solid var(--gp-border,#1f2d3d);border-radius:12px;padding:12px 14px';
    lines.forEach((line, i) => {
      const p = document.createElement('p');
      p.style.cssText = i === 0
        ? 'margin:0 0 3px;font-size:.88rem;font-weight:600'
        : 'margin:0 0 2px;font-size:.8rem;color:var(--gp-text3,#5a6a82)';
      p.textContent = line;
      item.append(p);
    });
    if (button) {
      const control = document.createElement('button');
      control.type = 'button';
      control.textContent = button.label;
      control.className = 'secondary';
      control.style.cssText = 'margin-top:8px;width:auto;padding:6px 14px;font-size:.8rem;border-radius:8px';
      control.addEventListener('click', button.onClick);
      item.append(control);
    }
    return item;
  });
  const ul = document.createElement('ul');
  ul.style.cssText = 'list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px';
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

// ---- Flows ----

const FLOW_TYPE_LABELS = Object.freeze({
  cobro: 'Cobro',
  vaca: 'Vaca/Colecta',
  tanda: 'Tanda',
  cuenta: 'Cuenta',
  suscripcion: 'Suscripción',
});

function flowSummary(flow) {
  const cfg = flow.config ?? {};
  const parts = [];
  if (cfg.amount_cents) parts.push(formatCents(cfg.amount_cents, cfg.currency ?? 'USD'));
  if (cfg.goal_cents) parts.push(`Goal: ${formatCents(cfg.goal_cents, cfg.currency ?? 'USD')}`);
  if (cfg.people) parts.push(`${cfg.people} people`);
  if (cfg.interval_days) parts.push(`Every ${cfg.interval_days}d`);
  return parts.join(' · ') || 'No amount set';
}

function renderExtraFields() {
  const type = $('flow-type').value;
  const container = $('flow-extra-fields');
  container.replaceChildren();
  if (type === 'tanda' || type === 'cuenta') {
    const label = document.createElement('label');
    label.htmlFor = 'flow-people';
    label.textContent = 'Number of people';
    const input = document.createElement('input');
    input.id = 'flow-people';
    input.type = 'number';
    input.min = '2';
    input.max = '30';
    input.value = '2';
    container.append(label, input);
  }
  if (type === 'suscripcion') {
    const label = document.createElement('label');
    label.htmlFor = 'flow-interval';
    label.textContent = 'Billing interval (days)';
    const input = document.createElement('input');
    input.id = 'flow-interval';
    input.type = 'number';
    input.min = '1';
    input.max = '365';
    input.value = '30';
    container.append(label, input);
  }
}

async function loadFlows() {
  const { flows, pq } = await api.get('/api/flows');

  // Update PQ badge
  const badge = $('flows-pq-status');
  if (badge && pq) {
    badge.className = `pq-badge ${pq.active ? 'active' : 'inactive'}`;
    badge.innerHTML = `<span class="pq-dot"></span>${pq.active ? `Dilithium3 ON` : 'PQ OFF'}`;
  }

  if (flows.length === 0) {
    emptyState('flows-body', 'No flows yet. Create one above.', null);
    return;
  }

  const items = flows.map((flow) => {
    const div = document.createElement('div');
    div.className = 'flow-item';

    const head = document.createElement('div');
    head.className = 'flow-item-head';

    const typeBadge = document.createElement('span');
    typeBadge.className = `flow-badge ${flow.type}`;
    typeBadge.textContent = FLOW_TYPE_LABELS[flow.type] ?? flow.type;
    head.append(typeBadge);

    const pqMark = document.createElement('span');
    pqMark.style.cssText = 'font-size:.75rem;margin-left:auto;color:' + (flow.pq_verified ? 'var(--gp-green)' : 'var(--gp-red)');
    pqMark.textContent = flow.pq_verified ? '🔐 PQ ✓' : '⚠ PQ ✗';
    head.append(pqMark);

    const title = document.createElement('div');
    title.className = 'flow-item-title';
    title.textContent = flow.title;

    const meta = document.createElement('div');
    meta.className = 'flow-item-meta';
    meta.textContent = `${flowSummary(flow)} · ${flow.run_count} run${flow.run_count !== 1 ? 's' : ''} · ${flow.status}`;

    div.append(head, title, meta);

    if (flow.status === 'active') {
      const actions = document.createElement('div');
      actions.className = 'flow-item-actions';

      // Run button — just increments counter
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.textContent = '▶ Run';
      runBtn.className = 'secondary';
      runBtn.style.cssText = 'margin:0;width:auto;padding:7px 16px;font-size:.82rem;border-radius:8px';
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        try {
          await api.post(`/api/flows/${encodeURIComponent(flow.id)}/run`);
          await section('flows-body', 'flows-error', loadFlows);
        } catch (error) {
          runBtn.disabled = false;
          setError('flows-error', error);
        }
      });

      // Send email button — reveals email form below
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.textContent = '📧 Enviar';
      sendBtn.style.cssText = 'margin:0;width:auto;padding:7px 16px;font-size:.82rem;border-radius:8px';

      // Archive button
      const archiveBtn = document.createElement('button');
      archiveBtn.type = 'button';
      archiveBtn.textContent = 'Archivar';
      archiveBtn.className = 'danger';
      archiveBtn.style.cssText = 'margin:0;width:auto;padding:7px 16px;font-size:.82rem;border-radius:8px';
      archiveBtn.addEventListener('click', async () => {
        archiveBtn.disabled = true;
        try {
          await api.del(`/api/flows/${encodeURIComponent(flow.id)}`);
          await section('flows-body', 'flows-error', loadFlows);
        } catch (error) {
          archiveBtn.disabled = false;
          setError('flows-error', error);
        }
      });

      actions.append(runBtn, sendBtn, archiveBtn);
      div.append(actions);

      // Email form (hidden until Send is clicked)
      const emailForm = document.createElement('form');
      emailForm.style.cssText = 'display:none;margin-top:14px;background:rgba(0,232,152,.04);border:1px solid rgba(0,232,152,.15);border-radius:10px;padding:14px';
      emailForm.noValidate = true;

      const emailLbl = document.createElement('label');
      emailLbl.textContent = 'Recipient email(s)';
      emailLbl.style.cssText = 'display:block;font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--gp-text3);margin-bottom:6px';

      const emailInput = document.createElement('textarea');
      emailInput.placeholder = 'client@email.com\nclient2@email.com';
      emailInput.rows = 3;
      emailInput.style.cssText = 'width:100%;resize:vertical;font-size:.88rem';

      const emailStatus = document.createElement('p');
      emailStatus.style.cssText = 'margin:8px 0 0;font-size:.82rem;min-height:1.2em';

      const emailSubmit = document.createElement('button');
      emailSubmit.type = 'submit';
      emailSubmit.textContent = 'Enviar invitaciones →';
      emailSubmit.style.cssText = 'margin-top:10px;padding:9px 18px;font-size:.85rem;border-radius:8px';

      emailForm.append(emailLbl, emailInput, emailStatus, emailSubmit);
      div.append(emailForm);

      sendBtn.addEventListener('click', () => {
        const open = emailForm.style.display !== 'none';
        emailForm.style.display = open ? 'none' : 'block';
        if (!open) emailInput.focus();
      });

      emailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const emails = emailInput.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
        if (emails.length === 0) {
          emailStatus.textContent = 'Enter at least one email.';
          emailStatus.style.color = 'var(--gp-red)';
          return;
        }
        emailSubmit.disabled = true;
        emailStatus.style.color = 'var(--gp-text3)';
        emailStatus.textContent = 'Sending…';
        try {
          const r = await api.post(`/api/flows/${encodeURIComponent(flow.id)}/notify`, { emails });
          const ok = r.sent?.length ?? 0;
          const fail = r.failed?.length ?? 0;
          emailStatus.style.color = fail ? 'var(--gp-amber)' : 'var(--gp-green)';
          emailStatus.textContent = fail
            ? `✓ Sent to ${ok}, failed: ${r.failed.join(', ')}`
            : `✓ Sent to ${ok} recipient${ok !== 1 ? 's' : ''}`;
          emailInput.value = '';
          meta.textContent = `${flowSummary(flow)} · ${r.flow?.run_count ?? flow.run_count + 1} runs · ${flow.status}`;
        } catch (error) {
          emailStatus.style.color = 'var(--gp-red)';
          emailStatus.textContent = messageForError(error);
        } finally {
          emailSubmit.disabled = false;
        }
      });
    }

    return div;
  });

  const container = document.createElement('div');
  container.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  container.append(...items);
  $('flows-body').replaceChildren(container);
}

async function onFlowSubmit(event) {
  event.preventDefault();
  $('flow-form-error').hidden = true;
  const type = $('flow-type').value;
  const title = $('flow-title').value.trim();
  if (!title) {
    $('flow-form-error').textContent = 'Name is required.';
    $('flow-form-error').hidden = false;
    return;
  }
  const amountRaw = $('flow-amount').value.trim();
  const config = { currency: $('flow-currency').value };
  if (amountRaw) {
    const cents = Number(amountRaw);
    if (!Number.isFinite(cents) || cents < 1) {
      $('flow-form-error').textContent = 'Amount must be a positive whole number of cents.';
      $('flow-form-error').hidden = false;
      return;
    }
    if (type === 'vaca') config.goal_cents = cents;
    else config.amount_cents = cents;
  }
  const peopleEl = document.getElementById('flow-people');
  if (peopleEl) config.people = Number(peopleEl.value);
  const intervalEl = document.getElementById('flow-interval');
  if (intervalEl) config.interval_days = Number(intervalEl.value);

  $('flow-submit').disabled = true;
  $('flow-status').textContent = 'Creating flow…';
  try {
    await api.post('/api/flows', { type, title, config });
    $('flow-title').value = '';
    $('flow-amount').value = '';
    $('flow-status').textContent = 'Flow created and signed with Dilithium3.';
    await section('flows-body', 'flows-error', loadFlows);
  } catch (error) {
    if (SESSION_ERRORS.includes(error?.code)) { signOut(); return; }
    $('flow-status').textContent = messageForError(error);
  } finally {
    $('flow-submit').disabled = false;
  }
}

// ---- History ----

const HISTORY_PAGE = 10;

function renderHistoryEntries(entries, bodyId, showAll) {
  const visible = showAll ? entries : entries.slice(0, HISTORY_PAGE);
  const body = $('history-body');

  const ul = document.createElement('ul');
  ul.style.cssText = 'list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px';

  for (const entry of visible) {
    const li = document.createElement('li');
    li.style.cssText = 'background:var(--gp-card2,#1a2333);border:1px solid var(--gp-border,#1f2d3d);border-radius:12px;padding:12px 14px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px';

    const left = document.createElement('div');
    const right = document.createElement('div');
    right.style.cssText = 'text-align:right;flex-shrink:0';

    const mainLine = document.createElement('p');
    mainLine.style.cssText = 'margin:0 0 2px;font-size:.88rem;font-weight:600';
    mainLine.textContent = entry.text;

    const dateLine = document.createElement('p');
    dateLine.style.cssText = 'margin:0;font-size:.78rem;color:var(--gp-text3,#5a6a82)';
    dateLine.textContent = dateText(entry.at);

    left.append(mainLine, dateLine);

    const amtLine = document.createElement('p');
    amtLine.style.cssText = 'margin:0 0 2px;font-size:.9rem;font-weight:700';
    amtLine.textContent = formatCents(entry.amount, entry.currency);

    const statusLine = document.createElement('p');
    statusLine.style.cssText = 'margin:0;font-size:.75rem;' + (
      entry.status.includes('Completed') ? 'color:var(--gp-green,#00e898)' :
      entry.status.includes('failed') || entry.status.includes('not go') ? 'color:var(--gp-red,#ff5c6a)' :
      'color:var(--gp-text3,#5a6a82)'
    );
    statusLine.textContent = entry.status;

    right.append(amtLine, statusLine);
    li.append(left, right);
    ul.append(li);
  }

  body.replaceChildren(ul);

  if (entries.length > HISTORY_PAGE) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.style.cssText = 'margin-top:12px;font-size:.85rem;padding:8px 18px';
    btn.textContent = showAll
      ? `Show less ↑`
      : `Show all ${entries.length} entries ↓`;
    btn.addEventListener('click', () => renderHistoryEntries(entries, bodyId, !showAll));
    body.append(btn);
  }
}

async function loadHistory() {
  const [{ payments }, { withdrawals }, { deposits }] = await Promise.all([
    api.get('/api/payments'),
    api.get('/api/withdrawals'),
    api.get('/api/deposits'),
  ]);

  const entries = [
    ...payments.map((p) => ({ at: p.created_at, text: `→ ${p.recipient_email}`, amount: p.amount_cents, currency: p.currency, status: messageForStatus(p.status) })),
    ...withdrawals.map((w) => ({ at: w.created_at, text: 'Withdrawal', amount: w.amount_cents, currency: w.currency, status: messageForMovement(w.status) })),
    ...deposits.map((d) => ({ at: d.created_at, text: 'Deposit', amount: d.amount_cents, currency: d.currency, status: messageForMovement(d.status) })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  if (entries.length === 0) {
    emptyState('history-body', 'No activity yet.', { href: 'new.html', label: 'Send money' });
    return;
  }
  renderHistoryEntries(entries, 'history-body', false);
}

// ---- Start ----

async function start() {
  if (!api.isSignedIn()) {
    $('signed-out').hidden = false;
    return;
  }
  $('dashboard').hidden = false;
  $('request-form').addEventListener('submit', onRequestSubmit);
  $('flow-form').addEventListener('submit', onFlowSubmit);
  $('flow-type').addEventListener('change', renderExtraFields);

  await Promise.all([
    section('wallet-body', 'wallet-error', loadWallet),
    section('money-body', 'money-error', loadMoney),
    section('requests-body', 'requests-error', loadRequests),
    section('subscriptions-body', 'subscriptions-error', loadSubscriptions),
    section('pools-body', 'pools-error', loadPools),
    section('flows-body', 'flows-error', loadFlows),
    section('history-body', 'history-error', loadHistory),
  ]);
}

start();
