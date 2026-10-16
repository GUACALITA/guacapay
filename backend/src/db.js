// The only module that opens the database. Other modules get the connection from here.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

let connection = null;

export function getDb() {
  if (connection) return connection;

  mkdirSync(dirname(config.databasePath), { recursive: true });

  connection = new Database(config.databasePath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  return connection;
}

export function closeDb() {
  if (connection) {
    connection.close();
    connection = null;
  }
}
