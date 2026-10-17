// Wiring for new.html: validates the form, creates the payment, and sends the payer to the checkout.
import { api } from '../api.js';
import { createPaymentOnly, fetchCurrencies } from '../flows.js';
import { messageForError } from '../messages.js';
import { newIdempotencyKey, validatePaymentForm } from '../payment-form.js';
import { setupWalletLinking } from '../wallet-link.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['recipient-email', 'amount', 'currency', 'message'];

let busy = false;
// The key stays the same while the same details are resubmitted after an error, so a retry cannot create a second payment.
let lastAttempt = null;

function setFieldError(field, text) {
  const el = $(`${field}-error`);
  el.textContent = text ?? '';
  el.hidden = !text;
}

function showStatus(text) {
  $('form-status').textContent = text;
}

function setBusy(value) {
  busy = value;
  $('submit-payment').disabled = value;
}

function readValues() {
  return {
    recipientEmail: $('recipient-email').value,
    amount: $('amount').value,
    currency: $('currency').value,
    message: $('message').value,
  };
}

async function onSubmit(event) {
  event.preventDefault();
  if (busy) return;

  for (const field of FIELDS) setFieldError(field, null);
  showStatus('');

  const currencies = [...$('currency').options].map((option) => option.value);
  const { errors, body } = validatePaymentForm(readValues(), { currencies });
  for (const [field, text] of Object.entries(errors)) {
    setFieldError(field === 'recipientEmail' ? 'recipient-email' : field, text);
  }
  if (!body) return;

  const signature = JSON.stringify(body);
  if (!lastAttempt || lastAttempt.signature !== signature) {
    lastAttempt = { signature, key: newIdempotencyKey() };
  }

  setBusy(true);
  showStatus('Starting payment…');
  try {
    const payment = await createPaymentOnly(api, body, lastAttempt.key);
    lastAttempt = null;
    // The payer chooses how to pay on the payment page: app balance, testnet, or Rapyd.
    location.assign(`payment.html?id=${encodeURIComponent(payment.id)}`);
  } catch (error) {
    if (error.code === 'unauthorized' || error.code === 'session_expired') {
      $('form-section').hidden = true;
      $('signed-out').hidden = false;
    }
    showStatus(messageForError(error));
    setBusy(false);
  }
}

async function start() {
  if (!api.isSignedIn()) {
    $('signed-out').hidden = false;
    return;
  }

  // Adding and linking a wallet happens here too, so the payer can link the wallet they pay from.
  $('wallet-section').hidden = false;
  const linking = setupWalletLinking({ client: api });
  linking.refresh().catch((error) => {
    $('wallet-status').textContent = messageForError(error);
  });

  $('form-section').hidden = false;
  try {
    const currencies = await fetchCurrencies(api);
    $('currency').replaceChildren(...currencies.map((code) => new Option(code, code)));
  } catch (error) {
    showStatus(messageForError(error));
    setBusy(true);
    return;
  }
  $('payment-form').addEventListener('submit', onSubmit);
}

start();
