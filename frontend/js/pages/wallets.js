// Wiring for wallets.html: lists the user's wallets, adds one by address, and starts consent for a pending one.
// It never asks for a password, a code from the wallet, or a key.
import { api } from '../api.js';
import { messageForError } from '../messages.js';

const $ = (id) => document.getElementById(id);
const STATUS_TEXT = Object.freeze({
  pending: 'Waiting for your approval in the wallet',
  linked: 'Linked',
  revoked: 'Revoked',
});

let linkLimitCents = 1000;

async function loadSetupConfig() {
  try {
    const response = await fetch('config/setup.json', { cache: 'no-store' });
    if (!response.ok) return;
    const config = await response.json();
    if (Number.isInteger(config.linkLimitCents) && config.linkLimitCents > 0) {
      linkLimitCents = config.linkLimitCents;
    }
  } catch {
    // Keep the default limit.
  }
}

function showError(text) {
  $('page-error').textContent = text;
  $('page-error').hidden = false;
}

// Builds one row with textContent only. Wallet data comes from the server and is shown as text, never as HTML.
function renderWallet(wallet) {
  const item = document.createElement('li');
  const address = document.createElement('p');
  address.textContent = wallet.wallet_url;
  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = `${wallet.asset_code} · ${STATUS_TEXT[wallet.status] ?? 'Status unknown'}`;
  item.append(address, status);

  if (wallet.status === 'pending') {
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve linking in your wallet';
    approve.addEventListener('click', () => approveWallet(wallet.id, approve));
    item.append(approve);
  }
  return item;
}

async function loadWallets() {
  const { wallets } = await api.get('/api/wallets');
  $('wallet-list').replaceChildren(...wallets.map(renderWallet));
  $('wallet-empty').hidden = wallets.length > 0;
}

// Asks for consent. The wallet's own page opens next; the approval finishes there, not in this form.
async function approveWallet(walletId, button) {
  button.disabled = true;
  $('wallet-status').textContent = 'Asking your wallet for approval…';
  try {
    const result = await api.post('/api/grants', { wallet_id: walletId, purpose: 'link', limit_cents: linkLimitCents });
    if (result.approvalUrl) {
      globalThis.location.assign(result.approvalUrl);
      return;
    }
    $('wallet-status').textContent = 'Linked.';
    await loadWallets();
  } catch (error) {
    $('wallet-status').textContent = messageForError(error);
    button.disabled = false;
  }
}

function setFieldError(text) {
  $('wallet-url-error').textContent = text ?? '';
  $('wallet-url-error').hidden = !text;
}

$('wallet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setFieldError(null);
  const url = $('wallet-url').value.trim();
  if (!url.startsWith('https://')) {
    setFieldError('Enter a wallet address that starts with https://');
    return;
  }

  $('add-wallet').disabled = true;
  $('wallet-status').textContent = 'Reading the wallet…';
  try {
    await api.post('/api/wallets', { wallet_url: url });
    $('wallet-url').value = '';
    $('wallet-status').textContent = 'Wallet added. Approve the link in your wallet to finish.';
    await loadWallets();
  } catch (error) {
    $('wallet-status').textContent = messageForError(error);
  } finally {
    $('add-wallet').disabled = false;
  }
});

async function start() {
  if (!api.isSignedIn()) {
    $('signed-out').hidden = false;
    return;
  }
  $('link-section').hidden = false;
  $('list-section').hidden = false;
  await loadSetupConfig();
  try {
    await loadWallets();
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
