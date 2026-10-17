// Wiring for payment.html: shows the payment's status, lets the sender pay from a linked wallet, and keeps it live.
import { api } from '../api.js';
import { fetchPayment, fetchWallets, payWithWallet } from '../flows.js';
import { connectLiveStatus } from '../live-status.js';
import { messageForError, messageForStatus } from '../messages.js';
import { formatCents } from '../money.js';

const $ = (id) => document.getElementById(id);

const FINAL_STATUSES = new Set(['completed', 'failed', 'expired']);
const PAYABLE_STATUSES = new Set(['created', 'awaiting_payment', 'failed']);

function showPageError(text) {
  $('page-error').textContent = text;
  $('page-error').hidden = false;
}

function renderStatus(status) {
  const badge = $('status-badge');
  badge.textContent = messageForStatus(status);
  badge.dataset.status = status;
  $('pay-section').hidden = status !== 'created';
}

function renderSummary(payment) {
  $('payment-amount').textContent = formatCents(payment.amount_cents, payment.currency);
  $('payment-to').textContent = `To ${payment.recipient_email}`;
}

function setPayBusy(busy) {
  $('pay-wallet').disabled = busy;
  $('pay-wallet-submit').disabled = busy;
}

async function loadQR(paymentId) {
  try {
    const resp = await fetch(`/api/payments/${paymentId}/qr`, {
      headers: { Authorization: `Bearer ${api.getToken()}` },
    });
    if (!resp.ok) return;
    const svg = await resp.text();
    // Encode as data URI — CSP allows data: in img-src.
    const b64 = btoa(unescape(encodeURIComponent(svg)));
    $('qr-img').src = `data:image/svg+xml;base64,${b64}`;
    $('qr-section').hidden = false;
  } catch {
    // QR is optional; silently skip on error.
  }
}

// Lists only wallets that hold the payment's currency. Others are not offered.
async function loadWallets(currency) {
  const linked = (await fetchWallets(api)).filter((w) => w.status === 'linked');
  const wallets = linked.filter((w) => w.asset_code === currency);
  $('pay-wallet').replaceChildren(...wallets.map((w) => new Option(`${w.wallet_url} (${w.asset_code})`, w.id)));
  if (wallets.length === 0) {
    const link = document.createElement('a');
    link.href = 'new.html';
    link.textContent = `Add a ${currency} wallet`;
    $('pay-empty').replaceChildren(`No linked wallet holds ${currency}. `, link, '.');
  }
  $('pay-empty').hidden = wallets.length > 0;
  $('pay-form').hidden = wallets.length === 0;
  return wallets.length > 0;
}

async function renewConsent(walletId, limitCents) {
  const params = new URLSearchParams(location.search);
  params.set('auto_force', '1');
  const returnTo = location.pathname + '?' + params.toString();
  const resp = await fetch(`/api/wallets/${walletId}/renew-consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.getToken()}` },
    body: JSON.stringify({ return_to: returnTo, limit_cents: limitCents }),
  });
  const data = await resp.json();
  return data.approvalUrl ?? null;
}

function wirePayForm(paymentId, amountCents) {
  $('pay-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setPayBusy(true);
    $('pay-status').textContent = 'Paying from your wallet…';
    const walletId = $('pay-wallet').value;
    try {
      const outcome = await payWithWallet(api, paymentId, walletId);
      renderStatus(outcome.status);
      const needsConsent = ['no_active_grant', 'grant_expired', 'openpayments_rejected', 'outgoing_failed'].includes(outcome.reason);
      if (needsConsent) {
        $('pay-status').textContent = 'Redirecting to Interledger to authorize the payment…';
        const approvalUrl = await renewConsent(walletId, amountCents);
        if (approvalUrl) { window.location.href = approvalUrl; return; }
      }
      if (outcome.status === 'awaiting_payment') {
        $('pay-status').textContent = 'The transfer is still running. This page will update when it finishes.';
      } else if (outcome.status === 'failed' && outcome.reason) {
        $('pay-status').textContent = messageForError({ code: outcome.reason });
      } else {
        $('pay-status').textContent = '';
      }
    } catch (error) {
      $('pay-status').textContent = messageForError(error);
    } finally {
      setPayBusy(false);
    }
  });
}

function wireDevForce(paymentId) {
  $('dev-section').hidden = false;
  $('dev-force-btn').addEventListener('click', async () => {
    $('dev-force-btn').disabled = true;
    $('dev-status').textContent = 'Forzando pago…';
    try {
      const resp = await fetch(`/api/payments/${encodeURIComponent(paymentId)}/dev-force-paid`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${api.getToken()}` },
      });
      const data = await resp.json();
      if (data.status === 'paid') {
        $('dev-status').textContent = '✅ Pago forzado — correo de reclamo enviado a MailPit.';
        renderStatus('claimable');
        $('dev-section').hidden = true;
      } else {
        $('dev-status').textContent = data.error?.message ?? 'Error inesperado.';
        $('dev-force-btn').disabled = false;
      }
    } catch {
      $('dev-status').textContent = 'No se pudo contactar el servidor.';
      $('dev-force-btn').disabled = false;
    }
  });
}

async function start() {
  const searchParams = new URLSearchParams(location.search);
  const paymentId = searchParams.get('id');
  const autoForce = searchParams.get('auto_force') === '1';
  if (!paymentId) { showPageError('No payment selected.'); return; }
  if (!api.isSignedIn()) { $('signed-out').hidden = false; return; }

  // Remove auto_force from the URL so a refresh does not re-trigger it.
  if (autoForce) {
    const clean = new URL(location.href);
    clean.searchParams.delete('auto_force');
    history.replaceState(null, '', clean.toString());
  }

  try {
    const payment = await fetchPayment(api, paymentId);
    $('status-section').hidden = false;
    renderSummary(payment);
    renderStatus(payment.status);
    if (!FINAL_STATUSES.has(payment.status)) loadQR(paymentId);
    if (payment.status === 'created' && (await loadWallets(payment.currency))) wirePayForm(paymentId, payment.amount_cents);
    if (PAYABLE_STATUSES.has(payment.status)) wireDevForce(paymentId);
    if (autoForce && PAYABLE_STATUSES.has(payment.status)) $('dev-force-btn').click();
  } catch (error) {
    if (error.code === 'unauthorized' || error.code === 'session_expired') {
      $('signed-out').hidden = false;
      return;
    }
    showPageError(messageForError(error));
    return;
  }

  connectLiveStatus({
    paymentId,
    token: api.getToken(),
    onUpdate: (message) => renderStatus(message.status),
    onError: (message) => {
      if (message.code === 'unauthorized' || message.code === 'session_expired') {
        $('signed-out').hidden = false;
        $('status-section').hidden = true;
        $('pay-section').hidden = true;
      }
      showPageError(messageForError(message));
    },
  });
}

start();
