// Applies numbered SQL files from backend/migrations/ in order.
// Each file runs once; applied files are recorded in schema_migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, closeDb } from './db.js';
import { logger } from './logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');
const MIGRATION_FILE = /^\d{3}-.+\.sql$/;

// Returns the names of migrations applied by this call (empty if none were pending).
export function runMigrations(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => MIGRATION_FILE.test(file)).sort();

  const applyOne = db.transaction((name, sql) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
  });

  const newlyApplied = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    applyOne(file, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    newlyApplied.push(file);
  }
  return newlyApplied;
}

// Command line: npm run migrate
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const applied = runMigrations();
    logger.info('migrations complete', { applied });
  } finally {
    closeDb();
  }
}
