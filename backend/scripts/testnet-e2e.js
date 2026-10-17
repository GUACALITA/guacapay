// End-to-end proof on the Interledger test network (prompt 31). Manual only; never part of `npm test`.
// Uses two real test wallets that are already linked in the app's database, and the sender's consent that a person approved.
// It never creates a wallet or account, never completes a consent, and never prints a key, token or login code.
//
// Run from backend/ with the repo-root .env filled in (see docs/TESTING.md):
//   TESTNET_SENDER_WALLET   the sender wallet address (https://...)
//   TESTNET_RECIPIENT_WALLET the recipient wallet address (https://...)
//   TESTNET_RECIPIENT_EMAIL  the email the payment is addressed to (no email is sent to it by this script)
//   TESTNET_AMOUNT_CENTS     optional, default 10 (0.10 in the wallet's asset)
//   CUSTODY_WALLET_ID / CUSTODY_WALLET_ADDRESS   the platform custody wallet (prompt 23)
//   PAYMENT_CURRENCIES       must include the wallet's asset code, for example EUR
// Exit codes: 0 completed, 1 failed at a step, 2 stopped because the sender's consent is not approved yet.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '..', '..', '.env') });

// The script's own minimum: 0.10 must be allowed for this proof. Set only when not already configured.
process.env.PAYMENT_MIN_CENTS ??= '1';

const { getDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { config } = await import('../src/config.js');
const { getWalletAddress } = await import('../src/providers/openpayments.js');
const { checkCustodyWallet } = await import('../src/custody/service.js');
const { requestConsent } = await import('../src/grants/service.js');
const { createPayment } = await import('../src/payments/service.js');
const { payFromWallet } = await import('../src/transfers/payments.js');
const { issueClaim, verifyClaimEmail, confirmClaim } = await import('../src/claims/service.js');
const { STATUS } = await import('../src/payments/states.js');

const SENDER = (process.env.TESTNET_SENDER_WALLET || '').trim();
const RECIPIENT = (process.env.TESTNET_RECIPIENT_WALLET || '').trim();
const RECIPIENT_EMAIL = (process.env.TESTNET_RECIPIENT_EMAIL || '').trim();
const AMOUNT_CENTS = Number(process.env.TESTNET_AMOUNT_CENTS || 10);
const LINK_LIMIT_CENTS = 1000;

// Thrown for any failure. The step name and a short reason are printed; nothing else is.
class StepError extends Error {
  constructor(step, reason, { stop = false } = {}) {
    super(reason);
    this.step = step;
    this.stop = stop;
  }
}

function report(step, detail = '') {
  console.log(`PASS ${step}${detail ? ` — ${detail}` : ''}`);
}

// Runs one step. Any error becomes a StepError with a reason that cannot carry a secret: only error codes or
// the library's message, which never includes keys or tokens.
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StepError) throw err;
    throw new StepError(name, err.code ?? err.message ?? 'unknown error');
  }
}

function requireEnv(name, value) {
  if (!value) throw new StepError('configuration', `${name} is not set in .env`);
}

// A mailer that keeps what it is given in memory instead of sending it. The login code is read from here, not from
// the recipient's inbox; this run does not prove the email delivery, only the claim and the transfers.
function captureMailer() {
  const sent = { links: [], codes: [] };
  return {
    sent,
    async sendClaimLink(email, link) {
      sent.links.push({ email, link });
    },
    async sendLoginCode(email, code) {
      sent.codes.push({ email, code });
    },
    async sendPaymentConfirmation() {},
  };
}

function legsOf(transferId) {
  return getDb()
    .prepare('SELECT kind, status FROM transfer_legs WHERE transfer_id = ? ORDER BY kind')
    .all(transferId);
}

function transfersOf(paymentId) {
  return getDb()
    .prepare('SELECT id, direction, status FROM transfers WHERE payment_id = ? ORDER BY rowid')
    .all(paymentId);
}

async function main() {
  requireEnv('TESTNET_SENDER_WALLET', SENDER);
  requireEnv('TESTNET_RECIPIENT_WALLET', RECIPIENT);
  requireEnv('TESTNET_RECIPIENT_EMAIL', RECIPIENT_EMAIL);
  requireEnv('CUSTODY_WALLET_ID', config.custody.walletId);
  requireEnv('CUSTODY_WALLET_ADDRESS', config.custody.address);
  if (!Number.isSafeInteger(AMOUNT_CENTS) || AMOUNT_CENTS < 1) {
    throw new StepError('configuration', 'TESTNET_AMOUNT_CENTS must be a positive whole number');
  }

  runMigrations(getDb());
  const db = getDb();

  // 1. Both public wallet documents are reachable, and they hold the same asset.
  const senderDoc = await step('read sender wallet', () => getWalletAddress(SENDER));
  const recipientDoc = await step('read recipient wallet', () => getWalletAddress(RECIPIENT));
  if (senderDoc.assetCode !== recipientDoc.assetCode || senderDoc.assetScale !== recipientDoc.assetScale) {
    throw new StepError('read both wallets', 'the wallets hold different assets');
  }
  if (!config.payments.currencies.includes(senderDoc.assetCode)) {
    throw new StepError('read both wallets', `PAYMENT_CURRENCIES must include ${senderDoc.assetCode}`);
  }
  report('read both wallets', `${senderDoc.assetCode} at scale ${senderDoc.assetScale}`);

  // 2. The sender's wallet is linked in the app. The script does not link it.
  const senderRow = db.prepare("SELECT * FROM wallets WHERE wallet_url = ? AND status != 'revoked'").get(senderDoc.id);
  if (!senderRow) {
    throw new StepError('sender wallet linked in the app', 'link the sender wallet in the app first (Wallets page)', { stop: true });
  }
  if (senderRow.status !== 'linked') {
    throw new StepError('sender wallet linked in the app', 'the sender wallet is not linked yet; approve the link in the app', { stop: true });
  }
  report('sender wallet linked in the app');

  // 3. The sender's consent is approved. If not, start it, print the approval link, and stop. This script never approves.
  const grant = db.prepare("SELECT id FROM grants WHERE wallet_id = ? AND status = 'granted' ORDER BY granted_at DESC LIMIT 1").get(senderRow.id);
  if (!grant) {
    const started = await step('sender consent', () =>
      requestConsent({
        userId: senderRow.user_id,
        walletId: senderRow.id,
        purpose: 'link',
        limitCents: LINK_LIMIT_CENTS,
      }),
    );
    if (started.approvalUrl) {
      console.log('STOP sender consent — approve this in the sender wallet, then run the script again:');
      console.log(started.approvalUrl);
      throw new StepError('sender consent', 'not approved yet', { stop: true });
    }
    throw new StepError('sender consent', 'the consent was granted at once, without approval; run the script again', { stop: true });
  }
  report('sender consent approved');

  // 4. The custody wallet is linked and has a permission.
  const custody = await step('custody wallet ready', () => checkCustodyWallet());
  if (!custody.ok) {
    throw new StepError('custody wallet ready', custody.reason);
  }
  report('custody wallet ready');

  // 5. Create the payment, addressed to the recipient's email. Paid from the sender's wallet.
  const { payment } = await step('create payment', () =>
    createPayment({
      senderId: senderRow.user_id,
      body: { recipient_email: RECIPIENT_EMAIL, amount_cents: AMOUNT_CENTS, currency: senderDoc.assetCode },
    }),
  );
  report('create payment', `amount ${AMOUNT_CENTS} cents ${senderDoc.assetCode}`);

  // 6. Pay in: sender wallet to custody. Completes only when the network reports the outgoing payment completed.
  const paid = await step('pay in: sender to custody', () =>
    payFromWallet({ paymentId: payment.id, userId: senderRow.user_id, walletId: senderRow.id }),
  );
  if (paid.status !== STATUS.PAID) {
    throw new StepError('pay in: sender to custody', `the transfer did not complete (${paid.reason ?? paid.status})`);
  }
  for (const transfer of transfersOf(payment.id)) {
    console.log(`     transfer ${transfer.id} direction ${transfer.direction} status ${transfer.status}`);
    for (const leg of legsOf(transfer.id)) console.log(`       leg ${leg.kind}: ${leg.status}`);
  }
  report('pay in: sender to custody');

  // 7. Claim: the claim link is issued, and the recipient's email code is verified. The code comes from the script's mailer.
  const mailer = captureMailer();
  await step('issue claim', () => issueClaim(payment.id, { mailer }));
  const claimToken = new URL(mailer.sent.links.at(-1).link).searchParams.get('token');
  await step('verify recipient email', () => verifyClaimEmail({ token: claimToken, email: RECIPIENT_EMAIL, mailer }));
  const code = mailer.sent.codes.at(-1).code;
  report('claim issued and verified');

  // 8. Pay out: custody to the recipient's wallet, through the same claim step the app uses.
  const claimed = await step('pay out: custody to recipient', () =>
    confirmClaim({ token: claimToken, code, destination: RECIPIENT, mailer }),
  );
  if (claimed.status !== STATUS.COMPLETED) {
    throw new StepError('pay out: custody to recipient', `the payout did not complete (${claimed.status})`);
  }
  for (const transfer of transfersOf(payment.id).filter((t) => t.direction === 'out')) {
    console.log(`     transfer ${transfer.id} direction ${transfer.direction} status ${transfer.status}`);
    for (const leg of legsOf(transfer.id)) console.log(`       leg ${leg.kind}: ${leg.status}`);
  }
  report('pay out: custody to recipient');

  // 9. Summary. No token, no code, no key.
  const finalStatus = db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status;
  console.log('');
  console.log('SUMMARY');
  console.log(`  amount: ${AMOUNT_CENTS} cents ${senderDoc.assetCode}`);
  console.log(`  sender wallet: ${SENDER}`);
  console.log(`  recipient wallet: ${RECIPIENT}`);
  console.log(`  payment: ${payment.id}`);
  console.log(`  transfers: ${transfersOf(payment.id).map((t) => `${t.direction}=${t.id}`).join(', ')}`);
  console.log(`  final status: ${finalStatus}`);
  if (finalStatus !== STATUS.COMPLETED) {
    throw new StepError('summary', `the payment is ${finalStatus}, not completed`);
  }
}

main()
  .then(() => {
    console.log('COMPLETED');
    process.exitCode = 0;
  })
  .catch((err) => {
    const step = err instanceof StepError ? err.step : 'unexpected';
    const reason = err instanceof StepError ? err.message : 'unexpected error (details withheld)';
    console.log(`FAILED at ${step}: ${reason}`);
    process.exitCode = err instanceof StepError && err.stop ? 2 : 1;
  });
