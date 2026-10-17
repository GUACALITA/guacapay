// The wallet linking form, shared by wallets.html and new.html: lists the user's wallets, adds one by its address,
// and starts approval for a pending one. It never asks for a password, a code from the wallet, or a key.
// Wallet data is shown with textContent only.
import { messageForError } from './messages.js';

const STATUS_TEXT = Object.freeze({
  pending: 'Waiting for your approval in the wallet',
  linked: 'Linked',
  revoked: 'Revoked',
});

const DEFAULT_LINK_LIMIT_CENTS = 1000;

// The element ids the form expects. Both pages provide them.
const IDS = Object.freeze({
  form: 'wallet-form',
  url: 'wallet-url',
  urlError: 'wallet-url-error',
  submit: 'add-wallet',
  status: 'wallet-status',
  list: 'wallet-list',
  empty: 'wallet-empty',
});

async function loadLinkLimit(fetchImpl) {
  try {
    const response = await fetchImpl('config/setup.json', { cache: 'no-store' });
    if (!response.ok) return DEFAULT_LINK_LIMIT_CENTS;
    const config = await response.json();
    return Number.isInteger(config.linkLimitCents) && config.linkLimitCents > 0 ? config.linkLimitCents : DEFAULT_LINK_LIMIT_CENTS;
  } catch {
    return DEFAULT_LINK_LIMIT_CENTS;
  }
}

// Wires the form in `doc`. Returns { refresh }, which reloads the list. Throws only from refresh(), so the caller decides what to show.
export function setupWalletLinking({ doc = globalThis.document, client, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  const $ = (key) => doc.getElementById(IDS[key]);
  let linkLimitCents = DEFAULT_LINK_LIMIT_CENTS;
  const limitReady = loadLinkLimit(fetchImpl).then((cents) => {
    linkLimitCents = cents;
  });

  // Builds one row with textContent only. Wallet data comes from the server and is shown as text, never as HTML.
  function renderWallet(wallet) {
    const item = doc.createElement('li');
    const address = doc.createElement('p');
    address.textContent = wallet.wallet_url;
    const status = doc.createElement('p');
    status.className = 'muted';
    status.textContent = `${wallet.asset_code} · ${STATUS_TEXT[wallet.status] ?? 'Status unknown'}`;
    item.append(address, status);

    if (wallet.status === 'pending') {
      const approve = doc.createElement('button');
      approve.type = 'button';
      approve.textContent = 'Approve linking in your wallet';
      approve.addEventListener('click', () => approveWallet(wallet.id, approve));
      item.append(approve);
    }
    return item;
  }

  async function refresh() {
    const { wallets } = await client.get('/api/wallets');
    $('list').replaceChildren(...wallets.map(renderWallet));
    $('empty').hidden = wallets.length > 0;
  }

  // Asks for consent. Shows the approval link on the page so the user can click it.
  async function approveWallet(walletId, button) {
    button.disabled = true;
    $('status').textContent = 'Asking your wallet for approval…';
    try {
      await limitReady;
      const result = await client.post('/api/grants', { wallet_id: walletId, purpose: 'link', limit_cents: linkLimitCents });
      if (result.approvalUrl) {
        const container = doc.createElement('div');
        container.style.cssText = 'margin-top:12px;padding:14px;background:var(--gp-card2,#1a2333);border:1px solid var(--gp-amber,#f5a623);border-radius:12px';
        const label = doc.createElement('p');
        label.style.cssText = 'margin:0 0 10px;font-size:.85rem;color:var(--gp-amber,#f5a623);font-weight:600';
        label.textContent = '⚠️ Approval required — click the button below to open your Interledger wallet:';
        const link = doc.createElement('a');
        link.href = result.approvalUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'display:inline-block;padding:10px 20px;background:var(--gp-green,#00e898);color:#0a0e14;border-radius:8px;font-weight:700;font-size:.9rem;text-decoration:none';
        link.textContent = 'Approve in Interledger wallet →';
        container.append(label, link);
        button.parentElement.append(container);
        $('status').textContent = '';
        return;
      }
      $('status').textContent = 'Linked.';
      await refresh();
    } catch (error) {
      $('status').textContent = messageForError(error);
      button.disabled = false;
    }
  }

  function setFieldError(text) {
    $('urlError').textContent = text ?? '';
    $('urlError').hidden = !text;
  }

  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFieldError(null);
    // Accepts the address with or without https://, and ignores stray leading "$" characters.
    let url = $('url').value.trim().replace(/^\$+\s*/, '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https:\/\//i.test(url)) {
      setFieldError('Use a wallet address that starts with https://');
      return;
    }
    if (!/^https:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    $('submit').disabled = true;
    $('status').textContent = 'Reading the wallet…';
    try {
      await client.post('/api/wallets', { wallet_url: url });
      $('url').value = '';
      $('status').textContent = 'Wallet added. Approve the link in your wallet to finish.';
      await refresh();
    } catch (error) {
      $('status').textContent = messageForError(error);
    } finally {
      $('submit').disabled = false;
    }
  });

  return { refresh };
}
