import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  assignCard,
  createTask,
  createTeamMember,
  getAgentBoard,
  getOrCreateProject,
  getStats,
  updateTeamMember,
} from './board.js';
import { backfillActivityAgents, migrate, openDb } from './db.js';

// The original tasks table as it existed before the additive ALTERs (subtasks/
// phase_id/skill/blocked_at/blocked_reason). Includes the columns the app has
// always had — notably project_id/lane/position, which the schema's
// idx_tasks_project_lane index references.
const LEGACY_TASKS_DDL = `CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  title          TEXT NOT NULL,
  lane           TEXT NOT NULL DEFAULT 'backlog',
  requirements   TEXT,
  tag            TEXT,
  assigned_agent TEXT,
  worktree_path  TEXT,
  branch         TEXT,
  depends_on     TEXT,
  review_rounds  INTEGER NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
)`;

describe('openDb', () => {
  it('opens an in-memory db with the schema applied', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]).map((r) => r.name);
    assert.ok(tables.includes('projects'));
    assert.ok(tables.includes('tasks'));
    assert.ok(tables.includes('task_events'));
  });

  it('creates the summary-query indexes on a fresh db', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const idx of [
      'idx_tasks_phase',
      'idx_card_activity_project',
      'idx_card_activity_task',
      'idx_reviews_task',
      'idx_events_task',
    ]) {
      assert.ok(names.includes(idx), `missing ${idx}`);
    }
  });

  it('creates the parent directory for a file-backed db', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-db-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'nested', 'board.db'); // parent does not exist yet
    const db = openDb(path);
    t.after(() => db.close());
    assert.ok(existsSync(path));
  });
});

describe('migrate', () => {
  it('adds the newer columns to a legacy tasks table', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    // A realistic pre-migrate legacy tasks table: the original columns the app
    // always had, WITHOUT the newer ALTER-added ones (subtasks/phase_id/skill/
    // blocked_at/blocked_reason). This exercises migrate()'s add-column path.
    db.exec(LEGACY_TASKS_DDL);
    const before = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
    assert.ok(!before.includes('subtasks'));

    migrate(db);
    const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
    for (const added of ['subtasks', 'phase_id', 'skill', 'blocked_at', 'blocked_reason']) {
      assert.ok(cols.includes(added), `migrate() should add ${added}`);
    }
  });

  it('adds parent_id and its index to a legacy projects table', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    // The projects table as it existed before workspaces (no parent_id).
    db.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    )`);
    migrate(db);
    const cols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('parent_id'));
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_parent'")
      .get();
    assert.ok(idx, 'migrate() should create idx_projects_parent');
    assert.doesNotThrow(() => migrate(db)); // idempotent
  });

  it('adds autopilot (default 0) to a legacy projects table, keeping existing rows', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    )`);
    db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run('p1', 'P', '/tmp/p', 1);
    migrate(db);
    const row = db.prepare('SELECT autopilot FROM projects WHERE id = ?').get('p1') as { autopilot: number };
    assert.equal(row.autopilot, 0);
    assert.doesNotThrow(() => migrate(db)); // idempotent
  });

  it('adds avatar to a legacy team_members table, keeping existing rows', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE team_members (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, skill TEXT, color TEXT, created_at INTEGER NOT NULL
    )`);
    db.prepare('INSERT INTO team_members (id, name, created_at) VALUES (?, ?, ?)').run('m1', 'Ada', 1);
    migrate(db);
    const row = db.prepare('SELECT name, avatar FROM team_members WHERE id = ?').get('m1') as { name: string; avatar: string | null };
    assert.deepEqual({ ...row }, { name: 'Ada', avatar: null });
    assert.doesNotThrow(() => migrate(db)); // idempotent
  });

  it('fresh db: projects.autopilot defaults to 0', (t) => {
    const db = openDb();
    t.after(() => db.close());
    db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run('p1', 'P', '/tmp/p', 1);
    const row = db.prepare('SELECT autopilot FROM projects WHERE id = ?').get('p1') as { autopilot: number };
    assert.equal(row.autopilot, 0);
  });

  it('creates idx_tasks_phase on a legacy tasks table without phase_id', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(LEGACY_TASKS_DDL);
    assert.doesNotThrow(() => migrate(db));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_phase'").get();
    assert.ok(idx, 'migrate() should create idx_tasks_phase');
  });

  it('is a no-op when the newer columns already exist', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    // A DB already carrying subtasks: migrate()'s guards must skip re-adding it.
    db.exec(LEGACY_TASKS_DDL.replace(')', ', subtasks TEXT)'));
    assert.doesNotThrow(() => migrate(db));
  });

  it('adds tasks.work_type once to an old-schema db opened twice; existing rows read NULL', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-db-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'board.db');
    const old = new Database(path);
    old.exec(LEGACY_TASKS_DDL); // no work_type
    old
      .prepare('INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('t1', 'p1', 'Old card', 1, 1);
    old.close();

    for (let i = 0; i < 2; i++) openDb(path).close();

    const db = openDb(path);
    t.after(() => db.close());
    const cols = (db.pragma('table_info(tasks)') as { name: string }[]).filter((c) => c.name === 'work_type');
    assert.equal(cols.length, 1);
    const row = db.prepare('SELECT work_type FROM tasks WHERE id = ?').get('t1') as { work_type: string | null };
    assert.equal(row.work_type, null);
    db.prepare("UPDATE tasks SET work_type = 'defect' WHERE id = 't1'").run();
    assert.throws(() => db.prepare("UPDATE tasks SET work_type = 'bogus' WHERE id = 't1'").run(), /CHECK/);
  });

  it('fresh db: has tasks.work_type (CHECKed) and the snapshot/usage tables with their keys', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const name of ['phase_snapshots', 'milestone_snapshots', 'usage_samples']) {
      assert.ok(tables.includes(name), `missing ${name}`);
    }
    const pk = (table: string) =>
      (db.pragma(`table_info(${table})`) as { name: string; pk: number }[])
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    assert.deepEqual(pk('phase_snapshots'), ['phase_id', 'date']);
    assert.deepEqual(pk('milestone_snapshots'), ['milestone_id', 'date']);
    assert.deepEqual(pk('usage_samples'), ['at']);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_phase_snapshots_project'").get();
    assert.ok(idx, 'missing idx_phase_snapshots_project');
    const taskCols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
    assert.ok(taskCols.includes('work_type'));
  });
});

describe('backfillActivityAgents', () => {
  // A legacy card_activity table (before `role`), as the live DB has it.
  const LEGACY_ACTIVITY_DDL = `CREATE TABLE card_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
    agent TEXT, agent_id TEXT, tokens INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    lines_added INTEGER NOT NULL DEFAULT 0, lines_removed INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  )`;
  const rows = (db: Database.Database) =>
    (db.prepare('SELECT task_id, agent, role FROM card_activity ORDER BY id').all() as object[]).map((r) => ({ ...r }));

  it('re-credits subagent-type rows to the assigned member at migrate, and is idempotent', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(LEGACY_TASKS_DDL);
    db.exec(LEGACY_ACTIVITY_DDL);
    db.exec(`CREATE TABLE team_members (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, skill TEXT, color TEXT, created_at INTEGER NOT NULL
    )`);
    db.prepare('INSERT INTO team_members (id, name, created_at) VALUES (?, ?, ?)').run('m-ada', 'Ada', 1);
    db.prepare('INSERT INTO team_members (id, name, created_at) VALUES (?, ?, ?)').run('m-bob', 'Bob', 1);
    const task = db.prepare(
      'INSERT INTO tasks (id, project_id, title, assigned_agent, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
    );
    task.run('t-ada', 'p', 'a', 'Ada');
    task.run('t-id', 'p', 'b', 'm-bob'); // assigned by member id → credited by name
    task.run('t-none', 'p', 'c', null);
    const run = db.prepare('INSERT INTO card_activity (project_id, task_id, agent, created_at) VALUES (?, ?, ?, 1)');
    run.run('p', 't-ada', 'builder');
    run.run('p', 't-ada', 'reviewer');
    run.run('p', 't-ada', null);
    run.run('p', 't-ada', 'Turing'); // already a person → untouched
    run.run('p', 't-id', 'builder');
    run.run('p', 't-none', 'builder'); // unassigned → untouched

    migrate(db);
    const expected = [
      { task_id: 't-ada', agent: 'Ada', role: 'builder' },
      { task_id: 't-ada', agent: 'Ada', role: 'reviewer' },
      { task_id: 't-ada', agent: 'Ada', role: null },
      { task_id: 't-ada', agent: 'Turing', role: null },
      { task_id: 't-id', agent: 'Bob', role: 'builder' },
      { task_id: 't-none', agent: 'builder', role: null },
    ];
    assert.deepEqual(rows(db), expected);
    // idempotent: a second pass (direct or via migrate) changes nothing
    assert.equal(backfillActivityAgents(db), 0);
    migrate(db);
    assert.deepEqual(rows(db), expected);
  });

  it('backfilled history follows a member rename', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const p = getOrCreateProject(db, '/tmp/backfill-rename');
    const ada = createTeamMember(db, 'Ada');
    const card = createTask(db, p.id, 'card');
    assignCard(db, card.id, 'Ada', `.trees/${card.id}`, `card/${card.id}`);
    db.prepare(
      `INSERT INTO card_activity (project_id, task_id, agent, ms, created_at) VALUES (?, ?, 'builder', 7200000, 1)`,
    ).run(p.id, card.id);
    assert.equal(backfillActivityAgents(db), 1);
    updateTeamMember(db, ada.id, { name: 'Ada L' });
    assert.equal(backfillActivityAgents(db), 0);
    const [entry] = getAgentBoard(db, p.id);
    assert.deepEqual([entry.name, entry.cards, entry.hours], ['Ada L', 1, 2]);
    assert.deepEqual(getStats(db, p.id).agents.map((a) => a.agent), ['Ada L']);
  });
});
