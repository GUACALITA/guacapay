// The app balance panel: shows the balance and recharges it through Rapyd. Used by new.html and payment.html.
import { api } from './api.js';
import { fetchBalances, startRecharge } from './flows.js';
import { messageForError } from './messages.js';
import { formatCents, parseAmountToCents } from './money.js';
import { newIdempotencyKey } from './payment-form.js';

const RECHARGE_CURRENCY = 'USD';

export async function renderBalance({ root = globalThis.document, client = api } = {}) {
  const amountEl = root.getElementById('balance-amount');
  if (!amountEl) return;

  try {
    const balances = await fetchBalances(client);
    const usd = balances.find((row) => row.currency === RECHARGE_CURRENCY);
    amountEl.textContent = `Your app balance: ${formatCents(usd ? usd.balance_cents : 0, RECHARGE_CURRENCY)}`;
  } catch (error) {
    amountEl.textContent = messageForError(error);
  }
}

export function wireRecharge({ root = globalThis.document, client = api, navigate = (url) => globalThis.location.assign(url) } = {}) {
  const form = root.getElementById('recharge-form');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = root.getElementById('recharge-status');
    const errorEl = root.getElementById('recharge-error');
    const button = root.getElementById('recharge-submit');

    const cents = parseAmountToCents(root.getElementById('recharge-amount').value);
    if (cents === null) {
      errorEl.textContent = 'Enter an amount greater than zero, with at most two decimals.';
      errorEl.hidden = false;
      return;
    }
    errorEl.textContent = '';
    errorEl.hidden = true;

    button.disabled = true;
    status.textContent = 'Opening Rapyd…';
    try {
      const result = await startRecharge(client, cents, RECHARGE_CURRENCY, newIdempotencyKey());
      navigate(result.redirectUrl);
    } catch (error) {
      status.textContent = messageForError(error);
      button.disabled = false;
    }
  });
}

if (globalThis.document?.getElementById('balance-card')) {
  if (api.isSignedIn()) {
    globalThis.document.getElementById('balance-card').hidden = false;
    renderBalance();
    wireRecharge();
  }
}
