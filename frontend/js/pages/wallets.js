// Wiring for wallets.html: the wallet linking form, shared with new.html (see js/wallet-link.js).
import { api } from '../api.js';
import { setupWalletLinking } from '../wallet-link.js';
import { messageForError } from '../messages.js';

const $ = (id) => document.getElementById(id);

function showError(text) {
  $('page-error').textContent = text;
  $('page-error').hidden = false;
}

async function start() {
  if (!api.isSignedIn()) {
    $('signed-out').hidden = false;
    return;
  }
  $('link-section').hidden = false;
  $('list-section').hidden = false;
  const linking = setupWalletLinking({ client: api });
  try {
    await linking.refresh();
  } catch (error) {
    if (error.code === 'unauthorized' || error.code === 'session_expired') {
      $('signed-out').hidden = false;
      $('link-section').hidden = true;
      $('list-section').hidden = true;
      return;
    }
    showError(messageForError(error));
  }
}

start();
