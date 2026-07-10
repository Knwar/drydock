import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Open (creating if needed) and migrate the board database. */
export function openDb(path = ':memory:'): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

/** Additive migrations for DBs created before a column existed. */
export function migrate(db: DB): void {
  const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  if (!cols.includes('subtasks')) db.exec('ALTER TABLE tasks ADD COLUMN subtasks TEXT');
  if (!cols.includes('phase_id')) db.exec('ALTER TABLE tasks ADD COLUMN phase_id TEXT');
  if (!cols.includes('skill')) db.exec('ALTER TABLE tasks ADD COLUMN skill TEXT');
  if (!cols.includes('blocked_at')) db.exec('ALTER TABLE tasks ADD COLUMN blocked_at INTEGER');
  if (!cols.includes('blocked_reason')) db.exec('ALTER TABLE tasks ADD COLUMN blocked_reason TEXT');
  // Outbox event backbone (Phase 1): durable log the Phase 3 dispatcher will drain.
  // status/attempts/last_attempt_at are written by Phase 3 — Phase 1 only creates the table.
  db.exec(`CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL,
    task_id         TEXT,
    type            TEXT NOT NULL,
    payload         TEXT,
    created_at      INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending',
    attempts        INTEGER DEFAULT 0,
    last_attempt_at INTEGER
  )`);
}
