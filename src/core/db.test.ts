import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { migrate, openDb } from './db.js';

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
});
