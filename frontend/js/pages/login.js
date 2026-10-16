// Wiring for index.html: email step, code step, and signed-in state.
import { api } from '../api.js';
import { requestLoginCode, verifyLoginCode } from '../flows.js';
import { messageForError } from '../messages.js';

const $ = (id) => document.getElementById(id);

function showStatus(text) {
  $('login-status').textContent = text;
}

function setFieldError(id, text) {
  const el = $(id);
  el.textContent = text ?? '';
  el.hidden = !text;
}

function setBusy(buttonId, busy) {
  $(buttonId).disabled = busy;
}

function showSignedInState() {
  const signedIn = api.isSignedIn();
  $('sign-in').hidden = signedIn;
  $('signed-in').hidden = !signedIn;
}

let pendingEmail = '';

$('email-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('login-email').value.trim();
  setFieldError('login-email-error', email ? null : 'Enter your email address.');
  if (!email) return;

  setBusy('send-code', true);
  showStatus('Sending code…');
  try {
    await requestLoginCode(api, email);
    pendingEmail = email;
    $('code-email').textContent = email;
    $('email-form').hidden = true;
    $('code-form').hidden = false;
    $('login-code').focus();
    showStatus('');
  } catch (error) {
    showStatus(messageForError(error));
  } finally {
    setBusy('send-code', false);
  }
});

$('code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('login-code').value.trim();
  setFieldError('login-code-error', /^\d{6}$/.test(code) ? null : 'Enter the 6-digit code.');
  if (!/^\d{6}$/.test(code)) return;

  setBusy('verify-code', true);
  showStatus('Checking code…');
  try {
    await verifyLoginCode(api, pendingEmail, code);
    location.assign('new.html');
  } catch (error) {
    showStatus(messageForError(error));
  } finally {
    setBusy('verify-code', false);
  }
});

$('change-email').addEventListener('click', () => {
  $('code-form').hidden = true;
  $('email-form').hidden = false;
  $('login-code').value = '';
  showStatus('');
});

$('sign-out').addEventListener('click', () => {
  api.setToken(null);
  showSignedInState();
});

showSignedInState();
