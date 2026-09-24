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
  migrate(db);
  return db;
}

/** Apply the schema (single source of truth) + additive migrations for legacy DBs. */
export function migrate(db: DB): void {
  // schema.sql is the single source of table/index DDL (all CREATE ... IF NOT EXISTS, so idempotent).
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  if (!cols.includes('subtasks')) db.exec('ALTER TABLE tasks ADD COLUMN subtasks TEXT');
  if (!cols.includes('phase_id')) db.exec('ALTER TABLE tasks ADD COLUMN phase_id TEXT');
  if (!cols.includes('skill')) db.exec('ALTER TABLE tasks ADD COLUMN skill TEXT');
  if (!cols.includes('blocked_at')) db.exec('ALTER TABLE tasks ADD COLUMN blocked_at INTEGER');
  if (!cols.includes('blocked_reason')) db.exec('ALTER TABLE tasks ADD COLUMN blocked_reason TEXT');
  // Workspace verticals: parent_id on projects created before it existed.
  const projectCols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
  if (!projectCols.includes('parent_id')) db.exec('ALTER TABLE projects ADD COLUMN parent_id TEXT');
  // Index lives here, not schema.sql: on a legacy DB schema.sql runs before the ALTER above.
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id)');
  // Loop-prevention origin tag (Phase 5): add to outbox tables created before it existed.
  const outboxCols = (db.pragma('table_info(outbox)') as { name: string }[]).map((c) => c.name);
  if (!outboxCols.includes('origin'))
    db.exec("ALTER TABLE outbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'");
}
