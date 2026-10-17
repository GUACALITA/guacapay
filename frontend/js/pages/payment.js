// Wiring for payment.html: shows the payment's status, lets the sender pay from a linked wallet, and keeps it live.
import { api } from '../api.js';
import { fetchPayment, fetchWallets, payWithWallet } from '../flows.js';
import { connectLiveStatus } from '../live-status.js';
import { messageForError, messageForStatus } from '../messages.js';
import { formatCents } from '../money.js';

const $ = (id) => document.getElementById(id);

function showPageError(text) {
  $('page-error').textContent = text;
  $('page-error').hidden = false;
}

function renderStatus(status) {
  $('status-text').textContent = messageForStatus(status);
  // Paying only makes sense while the payment is still waiting for the first transfer.
  $('pay-section').hidden = status !== 'created';
}

function renderSummary(payment) {
  $('payment-summary').textContent =
    `${formatCents(payment.amount_cents, payment.currency)} to ${payment.recipient_email}`;
}

function setPayBusy(busy) {
  $('pay-wallet').disabled = busy;
  $('pay-wallet-submit').disabled = busy;
}

// Lists only the wallets that finished consent. Returns false when there is none to pay from.
// Only wallets that hold the payment's currency can pay it. Others are not offered.
async function loadWallets(currency) {
  const linked = (await fetchWallets(api)).filter((wallet) => wallet.status === 'linked');
  const wallets = linked.filter((wallet) => wallet.asset_code === currency);
  $('pay-wallet').replaceChildren(...wallets.map((wallet) => new Option(`${wallet.wallet_url} (${wallet.asset_code})`, wallet.id)));
  if (wallets.length === 0) {
    const link = document.createElement('a');
    link.href = 'new.html';
    link.textContent = `Add a ${currency} wallet`;
    $('pay-empty').replaceChildren(`No linked wallet holds ${currency}. `, link, ' first.');
  }
  $('pay-empty').hidden = wallets.length > 0;
  $('pay-form').hidden = wallets.length === 0;
  return wallets.length > 0;
}

function wirePayForm(paymentId) {
  $('pay-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setPayBusy(true);
    $('pay-status').textContent = 'Paying from your wallet…';
    try {
      const outcome = await payWithWallet(api, paymentId, $('pay-wallet').value);
      renderStatus(outcome.status);
      $('pay-status').textContent =
        outcome.status === 'awaiting_payment' ? 'The transfer is still running. This page will update when it finishes.' : '';
    } catch (error) {
      $('pay-status').textContent = messageForError(error);
    } finally {
      setPayBusy(false);
    }
  });
}

async function start() {
  // The ID comes from the URL. It is used to ask for the payment, and never shown on the page.
  const paymentId = new URLSearchParams(location.search).get('id');

  if (!paymentId) {
    showPageError('No payment selected.');
    return;
  }
  if (!api.isSignedIn()) {
    $('signed-out').hidden = false;
    return;
  }

  try {
    const payment = await fetchPayment(api, paymentId);
    $('status-section').hidden = false;
    renderSummary(payment);
    renderStatus(payment.status);
    if (payment.status === 'created' && (await loadWallets(payment.currency))) wirePayForm(paymentId);
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
