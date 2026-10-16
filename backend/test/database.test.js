// Database checks (prompt 03). Uses a temporary SQLite file; no network needed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PLACEHOLDER_SECRET = 'placeholder-secret-value-0123456789abcdef';
const tempDir = mkdtempSync(join(tmpdir(), 'guacapay-db-'));

// Set environment before importing modules that read config.
process.env.JWT_SECRET = PLACEHOLDER_SECRET;
process.env.HMAC_SECRET = PLACEHOLDER_SECRET;
process.env.DATABASE_PATH = join(tempDir, 'test.db');

const { getDb, closeDb } = await import('../src/db.js');
const { runMigrations } = await import('../src/migrate.js');
const { hashSecret } = await import('../src/hash.js');

// First run of the whole suite: applies the initial schema.
const firstRun = runMigrations(getDb());

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

test('migrations apply once and are not re-applied', () => {
  assert.deepEqual(firstRun, ['001-initial.sql']);
  assert.deepEqual(runMigrations(getDb()), []);

  const recorded = getDb().prepare('SELECT name FROM schema_migrations').all();
  assert.deepEqual(recorded.map((row) => row.name), ['001-initial.sql']);
});

test('all tables exist with the expected columns', () => {
  const expected = {
    users: ['id', 'email', 'created_at'],
    otp_codes: ['id', 'email', 'code_hash', 'expires_at', 'attempts', 'used_at', 'created_at'],
    payments: [
      'id', 'sender_id', 'recipient_email', 'amount_cents', 'currency',
      'status', 'rapyd_checkout_id', 'created_at', 'updated_at',
    ],
    claims: ['id', 'payment_id', 'token_hash', 'status', 'destination', 'claimed_at', 'expires_at'],
    payment_events: ['id', 'payment_id', 'type', 'payload_json', 'created_at'],
  };

  for (const [table, columns] of Object.entries(expected)) {
    const actual = getDb().prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    assert.deepEqual(actual, columns, `columns of ${table}`);
  }
});

test('a payment can be written and read back with its constraints enforced', () => {
  const db = getDb();
  const senderId = randomUUID();
  const paymentId = randomUUID();

  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(senderId, 'sender@example.com');
  db.prepare(
    `INSERT INTO payments (id, sender_id, recipient_email, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(paymentId, senderId, 'recipient@example.com', 1500, 'USD', 'created');

  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  assert.equal(row.recipient_email, 'recipient@example.com');
  assert.equal(row.amount_cents, 1500);
  assert.equal(row.status, 'created');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const insertPayment = db.prepare(
    `INSERT INTO payments (id, sender_id, recipient_email, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  assert.throws(
    () => insertPayment.run(randomUUID(), senderId, 'x@example.com', 0, 'USD', 'created'),
    /CHECK constraint failed/,
    'amount must be positive',
  );
  assert.throws(
    () => insertPayment.run(randomUUID(), randomUUID(), 'x@example.com', 100, 'USD', 'created'),
    /FOREIGN KEY constraint failed/,
    'sender must exist',
  );
});

test('hashSecret is deterministic, fixed length, and never the input', () => {
  const hash = hashSecret('123456');

  assert.equal(hash, hashSecret('123456'));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, '123456');
  assert.notEqual(hash, hashSecret('654321'));
});
