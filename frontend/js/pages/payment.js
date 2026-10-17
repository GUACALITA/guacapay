// Wiring for payment.html: shows the payment's status, the ways to pay while it is created, and keeps it live.
import { api } from '../api.js';
import {
  fetchPayment,
  payWithAppBalance,
  payWithTestnet,
  startRapydCheckout,
} from '../flows.js';
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
  // The payment choices only make sense while the payment is still waiting to be paid.
  $('pay-section').hidden = status !== 'created';
}

function renderSummary(payment) {
  $('payment-summary').textContent =
    `${formatCents(payment.amount_cents, payment.currency)} to ${payment.recipient_email}`;
}

function setPayBusy(busy) {
  for (const id of ['pay-balance', 'pay-testnet', 'pay-rapyd']) {
    $(id).disabled = busy;
  }
}

function wirePayChoices(paymentId) {
  $('pay-balance').addEventListener('click', async () => {
    setPayBusy(true);
    $('pay-status').textContent = 'Paying with app balance…';
    try {
      await payWithAppBalance(api, paymentId);
      $('pay-status').textContent = '';
      renderStatus('paid');
    } catch (error) {
      $('pay-status').textContent = messageForError(error);
    } finally {
      setPayBusy(false);
    }
  });

  $('pay-testnet').addEventListener('click', async () => {
    setPayBusy(true);
    $('pay-status').textContent = 'Checking testnet…';
    try {
      await payWithTestnet(api, paymentId);
    } catch (error) {
      $('pay-status').textContent = messageForError(error);
    } finally {
      setPayBusy(false);
    }
  });

  $('pay-rapyd').addEventListener('click', async () => {
    setPayBusy(true);
    $('pay-status').textContent = 'Opening Rapyd…';
    try {
      const checkout = await startRapydCheckout(api, paymentId);
      globalThis.location.assign(checkout.redirectUrl);
    } catch (error) {
      $('pay-status').textContent = messageForError(error);
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
    $('balance-card').hidden = true;
    return;
  }

  try {
    const payment = await fetchPayment(api, paymentId);
    $('status-section').hidden = false;
    renderSummary(payment);
    renderStatus(payment.status);
    if (payment.status === 'created') wirePayChoices(paymentId);
  } catch (error) {
    if (error.code === 'unauthorized' || error.code === 'session_expired') {
      $('signed-out').hidden = false;
      $('balance-card').hidden = true;
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
