// Email (prompt 13). Uses a fake transport, so nothing is sent. Runs on a temporary database.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-email-'));
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.GATEWAY_TOKEN = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.PAYMENT_MIN_CENTS = '100';
process.env.PAYMENT_MAX_CENTS = '1000000';
process.env.PAYMENT_CURRENCIES = 'USD';
process.env.BASE_URL = 'https://guacapay.test';
process.env.SMTP_HOST = '';

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { renderEmail } = await import('../src/email/render.js');
const { createMailer, recipientReference } = await import('../src/email/send.js');
const { mailerFromConfig } = await import('../src/email/index.js');
const { issueToken } = await import('../src/auth/tokens.js');
const { AppError } = await import('../src/errors.js');
const { createPayment, transitionPayment } = await import('../src/payments/service.js');
const { attachCheckout } = await import('../src/payments/checkout.js');
const { STATUS } = await import('../src/payments/states.js');
const { issueClaim, verifyClaimEmail, confirmClaim } = await import('../src/claims/service.js');

runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

// Records every message instead of sending it.
function fakeTransport({ failWith } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(message) {
      if (failWith) throw failWith;
      sent.push(message);
    },
  };
}

// Captures what the logger prints during fn().
async function captureLogs(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (line) => lines.push(line);
  console.error = (line) => lines.push(line);
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  return lines.join('\n');
}

function makeUser(email = `${randomUUID()}@example.com`) {
  const id = randomUUID();
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, email);
  return { id, email, token: issueToken(id) };
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('HTML values are escaped, plain-text values are not', () => {
  const link = 'https://guacapay.test/claim.html?token=abc&x=<script>';
  const { text, html } = renderEmail('claim-link', { link, amount: '5.00 USD' });

  assert.ok(text.includes(link), 'plain text keeps the link as it is');
  assert.ok(html.includes('token=abc&amp;x=&lt;script&gt;'), 'HTML escapes ampersands and angle brackets');
  assert.ok(!html.includes('<script>'));
});

test('a template with a missing value fails instead of sending a placeholder', () => {
  assert.throws(() => renderEmail('login-code', {}), /placeholder "code" has no value/);
});

test('the login code email is in English, has the code in both versions, and no placeholders are left', async () => {
  const transport = fakeTransport();
  const mailer = createMailer({ transport, from: 'guacapay <no-reply@guacapay.local>' });
  const email = `${randomUUID()}@example.com`;

  await mailer.sendLoginCode(email, '424242');

  const [message] = transport.sent;
  assert.equal(message.to, email);
  assert.equal(message.subject, 'Your guacapay sign-in code');
  assert.ok(message.text.includes('424242'));
  assert.ok(message.html.includes('424242'));
  assert.ok(!/\{\{\w+\}\}/.test(message.text + message.html));
  assert.ok(message.text.includes('expires in 10 minutes'));
});

test('the claim email carries the link and the amount', async () => {
  const transport = fakeTransport();
  const mailer = createMailer({ transport, from: 'guacapay <no-reply@guacapay.local>' });

  await mailer.sendClaimLink('bob@example.com', 'https://guacapay.test/claim.html?token=tok', {
    amountText: '25.00 USD',
  });

  const [message] = transport.sent;
  assert.equal(message.subject, 'You have money waiting on guacapay');
  assert.ok(message.text.includes('https://guacapay.test/claim.html?token=tok'));
  assert.ok(message.text.includes('25.00 USD'));
  assert.ok(message.html.includes('Claim the money'));
});

test('a failed send becomes a clear error, and the logs name the reason without the address or the code', async () => {
  const transport = fakeTransport({ failWith: Object.assign(new Error('connect refused to bob@example.com'), { code: 'ECONNREFUSED' }) });
  const mailer = createMailer({ transport, from: 'guacapay <no-reply@guacapay.local>' });
  const address = 'bob@example.com';

  let thrown;
  const logs = await captureLogs(async () => {
    try {
      await mailer.sendLoginCode(address, '987654');
    } catch (err) {
      thrown = err;
    }
  });

  assert.ok(thrown instanceof AppError);
  assert.equal(thrown.code, 'email_failed');
  assert.equal(thrown.status, 503);
  assert.match(logs, /"reason":"ECONNREFUSED"/);
  assert.ok(!logs.includes(address), 'the address does not appear in logs');
  assert.ok(!logs.includes('987654'), 'the code does not appear in logs');
});

test('a successful send is logged with its type and a recipient reference only', async () => {
  const transport = fakeTransport();
  const mailer = createMailer({ transport, from: 'guacapay <no-reply@guacapay.local>' });
  const address = 'carol@example.com';

  const logs = await captureLogs(() => mailer.sendLoginCode(address, '111222'));

  assert.match(logs, /"type":"loginCode"/);
  assert.ok(logs.includes(`"recipient":"${recipientReference(address)}"`));
  assert.ok(!logs.includes(address));
  assert.ok(!logs.includes('111222'));
});

test('without SMTP configured, the app says so clearly and sends nothing', async () => {
  const mailer = mailerFromConfig();
  await assert.rejects(
    () => mailer.sendLoginCode('dan@example.com', '000111'),
    (err) => err.code === 'email_not_configured' && err.status === 503,
  );
});

test('sign-in fails with a clear error when the mail server is down', async () => {
  const transport = fakeTransport({ failWith: Object.assign(new Error('down'), { code: 'ECONNREFUSED' }) });
  const mailer = createMailer({ transport, from: 'guacapay <no-reply@guacapay.local>' });
  const email = `${randomUUID()}@example.com`;

  await captureLogs(() =>
    withServer(createApp({ mailer }), async (base) => {
      const response = await fetch(`${base}/api/auth/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.error.code, 'email_failed');
    }),
  );
});

test('sign-in works end to end when mail is delivered, and the code arrives by email', async () => {
  const transport = fakeTransport();
  const mailer = createMailer({ transport, from: 'guacapay <no-reply@guacapay.local>' });
  const email = `${randomUUID()}@example.com`;

  await withServer(createApp({ mailer }), async (base) => {
    const requested = await fetch(`${base}/api/auth/request-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(requested.status, 202);

    const code = transport.sent.at(-1).text.match(/^(\d{6})$/m)[1];
    const verified = await fetch(`${base}/api/auth/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    assert.equal(verified.status, 200);
  });
});

test('a claim link email is sent when a payment becomes claimable', async () => {
  const sender = makeUser();
  const { payment } = createPayment({
    senderId: sender.id,
    body: { recipient_email: `${randomUUID()}@example.com`, amount_cents: 2500, currency: 'USD' },
  });
  attachCheckout(payment.id, `checkout_${randomUUID().replace(/-/g, '')}`);
  transitionPayment(payment.id, STATUS.PAID);

  const transport = fakeTransport();
  const mailer = createMailer({ transport, from: 'guacapay <no-reply@guacapay.local>' });
  await issueClaim(payment.id, { mailer });

  const [message] = transport.sent;
  assert.equal(message.to, payment.recipient_email);
  assert.ok(message.text.includes('25.00 USD'));
  assert.match(message.text, /https:\/\/guacapay\.test\/claim\.html\?token=/);
});

test('a completed claim emails the sender, and a failed email does not undo the completed claim', async () => {
  const sender = makeUser();
  const recipient = `${randomUUID()}@example.com`;
  const { payment } = createPayment({
    senderId: sender.id,
    body: { recipient_email: recipient, amount_cents: 1000, currency: 'USD' },
  });
  attachCheckout(payment.id, `checkout_${randomUUID().replace(/-/g, '')}`);
  transitionPayment(payment.id, STATUS.PAID);

  const link = [];
  await issueClaim(payment.id, {
    mailer: {
      async sendClaimLink(email, url) {
        link.push(url);
      },
    },
  });
  const token = new URL(link[0]).searchParams.get('token');

  const codes = [];
  const quiet = { async sendLoginCode(email, code) { codes.push(code); }, async sendPaymentConfirmation() {} };
  await verifyClaimEmail({ token, email: recipient, mailer: quiet });

  const senderEmails = [];
  let result;
  const logs = await captureLogs(async () => {
    result = await confirmClaim({
      token,
      code: codes[0],
      destination: 'https://ilp.interledger-test.dev/71dd8185',
      transfer: async () => ({ transferId: 'tx' }),
      mailer: {
        async sendPaymentConfirmation(email) {
          senderEmails.push(email);
          throw new AppError('email_failed', 503, 'x');
        },
      },
    });
  });

  assert.deepEqual(result, { status: 'completed' }, 'the claim still completes');
  assert.match(logs, /payment confirmation not sent/);
  assert.equal(getDb().prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'completed');
  assert.equal(senderEmails.length, 1);
  assert.equal(senderEmails[0], sender.email, 'the confirmation goes to the sender');
});
