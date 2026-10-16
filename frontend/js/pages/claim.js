// Wiring for claim.html: email, code, then destination. The token comes from the link and is kept only in memory.
import { api } from '../api.js';
import { confirmClaim, sendClaimCode } from '../flows.js';
import { messageForClaimResult, messageForError } from '../messages.js';

const $ = (id) => document.getElementById(id);
const CODE_PATTERN = /^\d{6}$/;

// The token is read from the URL, used for the API calls, and never written anywhere else.
const token = new URLSearchParams(location.search).get('token');
let code = '';

function setFieldError(id, text) {
  $(id).textContent = text ?? '';
  $(id).hidden = !text;
}

function showStatus(text) {
  $('claim-status').textContent = text;
}

function setBusy(buttonId, busy) {
  $(buttonId).disabled = busy;
}

function showStep(id) {
  for (const step of ['claim-email-form', 'claim-code-form', 'claim-destination-form']) {
    $(step).hidden = step !== id;
  }
}

function showResult(text) {
  $('claim-flow').hidden = true;
  $('claim-result').hidden = false;
  $('claim-result-text').textContent = text;
}

$('claim-email-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('claim-email').value.trim();
  setFieldError('claim-email-error', email ? null : 'Enter your email address.');
  if (!email) return;

  setBusy('send-claim-code', true);
  showStatus('Sending code…');
  try {
    await sendClaimCode(api, token, email);
    showStatus('');
    showStep('claim-code-form');
    $('claim-code').focus();
  } catch (error) {
    showStatus(messageForError(error));
  } finally {
    setBusy('send-claim-code', false);
  }
});

$('claim-code-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const entered = $('claim-code').value.trim();
  setFieldError('claim-code-error', CODE_PATTERN.test(entered) ? null : 'Enter the 6-digit code.');
  if (!CODE_PATTERN.test(entered)) return;

  // The code is checked together with the destination, because a claim can only be confirmed once.
  code = entered;
  showStatus('');
  showStep('claim-destination-form');
  $('claim-destination').focus();
});

$('claim-destination-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const destination = $('claim-destination').value.trim();
  const looksValid = /^https:\/\/\S+\/\S+$/.test(destination);
  setFieldError('claim-destination-error', looksValid ? null : 'Enter a wallet address that starts with https.');
  if (!looksValid) return;

  setBusy('submit-claim', true);
  showStatus('Claiming…');
  try {
    const result = await confirmClaim(api, { token, code, destinationWalletAddress: destination });
    showResult(messageForClaimResult(result.status));
  } catch (error) {
    showStatus(messageForError(error));
    // A used code cannot be tried again; go back and ask for a new one.
    if (error.code === 'invalid_code' || error.code === 'too_many_attempts') {
      code = '';
      showStep('claim-code-form');
    }
  } finally {
    setBusy('submit-claim', false);
  }
});

if (!token) {
  $('claim-missing').hidden = false;
} else {
  $('claim-flow').hidden = false;
  showStep('claim-email-form');
}
