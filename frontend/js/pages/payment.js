// Wiring for payment.html: shows the payment's status and keeps it live.
import { api } from '../api.js';
import { fetchPayment } from '../flows.js';
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
}

function renderSummary(payment) {
  $('payment-summary').textContent =
    `${formatCents(payment.amount_cents, payment.currency)} to ${payment.recipient_email}`;
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
    renderStatus(payment.status);
    renderSummary(payment);
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
      }
      showPageError(messageForError(message));
    },
  });
}

start();
