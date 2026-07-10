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
  // status is a FAN-OUT marker: pending (not yet fanned out) -> processed (delivery rows created).
  // Per-target delivered/failed/dead lives in the deliveries table, not on the outbox row.
  db.exec(`CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL,
    task_id         TEXT,
    type            TEXT NOT NULL,
    payload         TEXT,
    created_at      INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending',
    attempts        INTEGER DEFAULT 0,
    last_attempt_at INTEGER,
    origin          TEXT NOT NULL DEFAULT 'local'
  )`);
  // Loop-prevention origin tag (Phase 5): add to outbox tables created before it existed.
  const outboxCols = (db.pragma('table_info(outbox)') as { name: string }[]).map((c) => c.name);
  if (!outboxCols.includes('origin'))
    db.exec("ALTER TABLE outbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'");
  // Subscription registry (Phase 2): queryable "who wants which events" the Phase 3 dispatcher reads.
  // This card only creates the table; CRUD/matcher/dispatcher land in later cards.
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    id           TEXT PRIMARY KEY,
    project_id   TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('webhook','connector','bridge')),
    event_filter TEXT NOT NULL,
    target       TEXT NOT NULL,
    secret       TEXT,
    scopes       TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL
  )`);
  // Deliveries (Phase 3): per-(outbox event x subscription) delivery state machine + attempt log.
  // The UNIQUE (outbox_id, subscription_id) makes fan-out idempotent; the dispatcher lands in later cards.
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    outbox_id        INTEGER NOT NULL,
    subscription_id  TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_status_code INTEGER,
    last_error       TEXT,
    next_attempt_at  INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (outbox_id, subscription_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at)');
  // Sync links (Phase 5): local<->remote link state for the bridge foundations.
  // This card only creates the table + CRUD; the sync engine lands in later cards.
  // The UNIQUE (provider, local_id) keeps one link per (provider, local card).
  db.exec(`CREATE TABLE IF NOT EXISTS sync_links (
    id             TEXT PRIMARY KEY,
    project_id     TEXT,
    local_id       TEXT NOT NULL,
    provider       TEXT NOT NULL,
    external_id    TEXT,
    local_hash     TEXT,
    remote_hash    TEXT,
    last_synced_at INTEGER,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    UNIQUE (provider, local_id)
  )`);
}
