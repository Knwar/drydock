// Drydock's own tables, next to kankanban's (core/schema.sql). Each feature
// module registers its DDL with defineSchema; ensureSchema applies all of it
// once per DB, so the bootstrap DB and a workspace DB both get every table.
import type { DB } from '../core/db.js';

const parts: { ddl: string; migrate?: (db: DB) => void }[] = [];
const ready = new WeakSet<DB>();

export function defineSchema(ddl: string, migrate?: (db: DB) => void): void {
  parts.push({ ddl, migrate });
}

export function ensureSchema(db: DB): void {
  if (ready.has(db)) return;
  for (const p of parts) {
    db.exec(p.ddl);
    p.migrate?.(db);
  }
  ready.add(db);
}

/** Tables only ever gain columns: add any a newer version declares that an older DB lacks. */
export function addMissingColumns(db: DB, table: string, columns: Record<string, string>): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, def] of Object.entries(columns)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
