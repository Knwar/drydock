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
  if (!cols.includes('work_type'))
    db.exec("ALTER TABLE tasks ADD COLUMN work_type TEXT CHECK (work_type IN ('feature','defect','debt','risk'))");
  if (!cols.includes('estimate_hours')) db.exec('ALTER TABLE tasks ADD COLUMN estimate_hours REAL');
  // Index lives here, not schema.sql: on a legacy DB schema.sql runs before the phase_id ALTER above.
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase_id)');
  // Workspace verticals: parent_id on projects created before it existed.
  const projectCols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
  if (!projectCols.includes('parent_id')) db.exec('ALTER TABLE projects ADD COLUMN parent_id TEXT');
  if (!projectCols.includes('autopilot'))
    db.exec('ALTER TABLE projects ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0');
  if (!projectCols.includes('board_settings')) db.exec('ALTER TABLE projects ADD COLUMN board_settings TEXT');
  // Index lives here, not schema.sql: on a legacy DB schema.sql runs before the ALTER above.
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id)');
  // Loop-prevention origin tag (Phase 5): add to outbox tables created before it existed.
  const outboxCols = (db.pragma('table_info(outbox)') as { name: string }[]).map((c) => c.name);
  if (!outboxCols.includes('origin'))
    db.exec("ALTER TABLE outbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'");
  // Agent profile avatars: image file name on team members created before it existed.
  const teamCols = (db.pragma('table_info(team_members)') as { name: string }[]).map((c) => c.name);
  if (!teamCols.includes('avatar')) db.exec('ALTER TABLE team_members ADD COLUMN avatar TEXT');
  // Activity role: the subagent type that ran a build, kept apart from the credited agent.
  const activityCols = (db.pragma('table_info(card_activity)') as { name: string }[]).map((c) => c.name);
  if (!activityCols.includes('role')) db.exec('ALTER TABLE card_activity ADD COLUMN role TEXT');
  if (!activityCols.includes('estimated'))
    db.exec('ALTER TABLE card_activity ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0');
  // Cost breakdown: rows recorded before it existed have no per-model usage, so their cost is estimated.
  if (!activityCols.includes('usage')) {
    db.exec('ALTER TABLE card_activity ADD COLUMN usage TEXT');
    if (!activityCols.includes('cost_estimated'))
      db.exec('ALTER TABLE card_activity ADD COLUMN cost_estimated INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE card_activity SET cost_estimated = 1 WHERE usage IS NULL');
  }
  const phaseCols = (db.pragma('table_info(phases)') as { name: string }[]).map((c) => c.name);
  if (!phaseCols.includes('budget_usd')) db.exec('ALTER TABLE phases ADD COLUMN budget_usd REAL');
  if (!phaseCols.includes('target_date')) db.exec('ALTER TABLE phases ADD COLUMN target_date TEXT');
  if (cols.includes('assigned_agent')) backfillActivityAgents(db); // absent only on hand-built test tables
}

/** Subagent types that older hooks recorded as card_activity.agent. */
const SUBAGENT_TYPES = ['builder', 'reviewer', 'planner', 'manager'];

/**
 * Re-credit build runs recorded under a subagent type (or no agent) to the
 * card's assigned team member, keeping the type in `role`. Idempotent: a
 * rewritten row names the member, so it no longer matches. Rows on unassigned
 * cards, and rows already naming someone else, are left alone. Returns the
 * number of rows changed.
 */
export function backfillActivityAgents(db: DB): number {
  return db
    .prepare(
      `UPDATE card_activity
         SET role = COALESCE(role, agent),
             agent = (SELECT COALESCE(m.name, t.assigned_agent) FROM tasks t
                        LEFT JOIN team_members m ON m.id = t.assigned_agent
                       WHERE t.id = card_activity.task_id)
       WHERE (agent IS NULL OR agent IN (${SUBAGENT_TYPES.map(() => '?').join(', ')}))
         AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = card_activity.task_id AND tasks.assigned_agent IS NOT NULL
                     AND tasks.assigned_agent NOT IN (${SUBAGENT_TYPES.map(() => '?').join(', ')}))`,
    )
    .run(...SUBAGENT_TYPES, ...SUBAGENT_TYPES).changes;
}
