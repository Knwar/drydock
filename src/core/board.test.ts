import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  advancePhase,
  appendEvent,
  assignCard,
  cardTotals,
  checkSubtask,
  createPhase,
  createSyncLink,
  createTask,
  createTeamMember,
  createVertical,
  deleteTask,
  deleteTeamMember,
  detectSyncConflicts,
  getSyncLink,
  getSyncLinkByLocal,
  getTask,
  getActiveCards,
  getActivePhase,
  getAgentBoard,
  getNowBuilding,
  getUpNext,
  getAttention,
  humanSpan,
  findProject,
  getWorkspace,
  getWorkspaceSummary,
  getWorkspaceCards,
  laneCounts,
  getBoard,
  getNextCard,
  getNextPhase,
  getOrCreateProject,
  getPhase,
  getPhases,
  setPhaseBudget,
  getRecentEvents,
  getStats,
  listSyncLinks,
  listTeam,
  listVerticals,
  mergeVerticals,
  MergeError,
  validateVertical,
  moveTask,
  placePhaselessCards,
  raiseBlocker,
  recordActivity,
  recordReview,
  redirectTask,
  resolveBlocker,
  resolveSyncConflict,
  setAutopilot,
  setSubtasks,
  setTeamAvatar,
  splitIntoVerticals,
  SplitError,
  suggestCardPlacement,
  updatePhase,
  taskContentHash,
  updateSyncLink,
  updateTask,
  updateTeamMember,
} from './board.js';
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  getSubscriptionSecret,
  listDeliveries,
  listSubscriptions,
  subscriptionMatches,
  updateSubscription,
} from './subscriptions.js';
import { migrate, openDb } from './db.js';
import type { CardFilter, TaskEvent } from './types.js';

function setup() {
  const db = openDb();
  const project = getOrCreateProject(db, '/tmp/demo-app', 'Demo App');
  return { db, project };
}

describe('workspaces', () => {
  function wsSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-ws-'));
    for (const sub of ['mobile', 'web', 'api']) mkdirSync(join(dir, sub));
    const db = openDb();
    const workspace = getOrCreateProject(db, dir, 'Shop');
    const cleanup = () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { db, dir, workspace, cleanup };
  }

  it('new projects are top-level (parent_id null)', (t) => {
    const { workspace, cleanup } = wsSetup();
    t.after(cleanup);
    assert.equal(workspace.parent_id, null);
  });

  it('creates a vertical that cwd lookup resolves to, and logs vertical_create', (t) => {
    const { db, dir, workspace, cleanup } = wsSetup();
    t.after(cleanup);
    const v = createVertical(db, workspace.id, 'Mobile', join(dir, 'mobile') + '/');
    assert.equal(v.parent_id, workspace.id);
    assert.equal(v.name, 'Mobile');
    assert.equal(v.root_path, join(dir, 'mobile'));
    assert.equal(findProject(db, join(dir, 'mobile'))?.id, v.id);
    const ev = getRecentEvents(db, workspace.id).find((e) => e.type === 'vertical_create');
    assert.deepEqual(JSON.parse(ev!.payload!), { vertical_id: v.id, name: 'Mobile' });
  });

  it('rejects a vertical as parent, a missing dir, the workspace root, and an unknown workspace', (t) => {
    const { db, dir, workspace, cleanup } = wsSetup();
    t.after(cleanup);
    const v = createVertical(db, workspace.id, 'Mobile', join(dir, 'mobile'));
    assert.throws(() => createVertical(db, v.id, 'Web', join(dir, 'web')), /vertical/);
    assert.throws(() => createVertical(db, workspace.id, 'X', join(dir, 'nope')), /not an existing directory/);
    assert.throws(() => createVertical(db, workspace.id, 'Root', dir + '/'), /differ/);
    assert.throws(() => createVertical(db, 'no-such-id', 'Web', join(dir, 'web')), /no such project/);
  });

  it('adopts an existing childless top-level project at that path', (t) => {
    const { db, dir, workspace, cleanup } = wsSetup();
    t.after(cleanup);
    const api = getOrCreateProject(db, join(dir, 'api'), 'old-api');
    const v = createVertical(db, workspace.id, 'API', join(dir, 'api'));
    assert.equal(v.id, api.id);
    assert.equal(v.parent_id, workspace.id);
    assert.equal(findProject(db, join(dir, 'api'))?.name, 'API');
  });

  it('refuses to adopt an existing project that has children (or is already a vertical)', (t) => {
    const { db, dir, workspace, cleanup } = wsSetup();
    t.after(cleanup);
    const other = getOrCreateProject(db, join(dir, 'web'), 'Other WS');
    createVertical(db, other.id, 'Api', join(dir, 'api'));
    assert.throws(() => createVertical(db, workspace.id, 'Web', join(dir, 'web')), /cannot be adopted/);
    assert.throws(() => createVertical(db, workspace.id, 'Api', join(dir, 'api')), /cannot be adopted/);
    assert.equal(findProject(db, join(dir, 'web'))?.parent_id, null);
  });

  it('validateVertical throws for every case createVertical rejects, and writes nothing', (t) => {
    const { db, dir, workspace, cleanup } = wsSetup();
    t.after(cleanup);
    const v = createVertical(db, workspace.id, 'Mobile', join(dir, 'mobile'));
    const other = getOrCreateProject(db, join(dir, 'web'), 'Other WS');
    createVertical(db, other.id, 'Api', join(dir, 'api'));
    const cases: [string, string, RegExp][] = [
      [v.id, join(dir, 'web'), /verticals cannot have verticals/],
      ['no-such-id', join(dir, 'web'), /no such project/],
      [workspace.id, join(dir, 'nope'), /not an existing directory/],
      [workspace.id, dir + '/', /differ/],
      [workspace.id, join(dir, 'web'), /cannot be adopted/], // has children
      [workspace.id, join(dir, 'api'), /cannot be adopted/], // already a vertical
    ];
    for (const [ws, root, err] of cases) assert.throws(() => validateVertical(db, ws, root), err);
    mkdirSync(join(dir, 'mobile2'));
    const before = listVerticals(db, workspace.id).length;
    const ok = validateVertical(db, workspace.id, join(dir, 'mobile2'));
    assert.equal(ok.workspace.id, workspace.id);
    assert.equal(listVerticals(db, workspace.id).length, before);
  });

  it('lists verticals and resolves the workspace from either id', (t) => {
    const { db, dir, workspace, cleanup } = wsSetup();
    t.after(cleanup);
    const m = createVertical(db, workspace.id, 'Mobile', join(dir, 'mobile'));
    const w = createVertical(db, workspace.id, 'Web', join(dir, 'web'));
    assert.deepEqual(listVerticals(db, workspace.id).map((p) => p.id), [m.id, w.id]);
    for (const id of [workspace.id, w.id]) {
      const view = getWorkspace(db, id);
      assert.equal(view.workspace.id, workspace.id);
      assert.deepEqual(view.verticals.map((p) => p.id), [m.id, w.id]);
    }
  });

  it('getWorkspace: standalone project has no verticals; unknown id throws', () => {
    const { db } = setup();
    const solo = getOrCreateProject(db, '/tmp/solo-app');
    assert.deepEqual(getWorkspace(db, solo.id), { workspace: solo, verticals: [] });
    assert.throws(() => getWorkspace(db, 'no-such-id'), /no such project/);
  });
});

describe('projects', () => {
  it('get_or_create is idempotent on root_path', () => {
    const { db, project } = setup();
    const again = getOrCreateProject(db, '/tmp/demo-app');
    assert.equal(again.id, project.id);
    assert.equal(again.name, 'Demo App');
  });

  it('dedups a root_path that differs only by a trailing slash (UI picker vs init script)', () => {
    // The macOS folder picker hands back a trailing slash; init-project.sh strips
    // it via `cd … && pwd`. Both must map to the same project, not register twice.
    const { db, project } = setup(); // registered '/tmp/demo-app'
    const again = getOrCreateProject(db, '/tmp/demo-app/');
    assert.equal(again.id, project.id);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n, 1);
  });

  it('derives name from path when omitted', () => {
    const { db } = setup();
    const p = getOrCreateProject(db, '/tmp/other-app');
    assert.equal(p.name, 'other-app');
  });
});

describe('autopilot', () => {
  it('defaults to 0 for new projects and verticals', (t) => {
    const { db, project } = setup();
    assert.equal(project.autopilot, 0);
    assert.equal(getOrCreateProject(db, '/tmp/demo-app').autopilot, 0); // read back from the row
    const dir = mkdtempSync(join(tmpdir(), 'kankan-ap-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'web'));
    const ws = getOrCreateProject(db, dir);
    assert.equal(createVertical(db, ws.id, 'Web', join(dir, 'web')).autopilot, 0);
  });

  it('setAutopilot persists and logs an autopilot event', () => {
    const { db, project } = setup();
    assert.equal(setAutopilot(db, project.id, true).autopilot, 1);
    assert.equal(getOrCreateProject(db, '/tmp/demo-app').autopilot, 1);
    const ev = getRecentEvents(db, project.id).find((e) => e.type === 'autopilot');
    assert.deepEqual(JSON.parse(ev!.payload!), { on: true });
    assert.equal(setAutopilot(db, project.id, false).autopilot, 0);
    assert.equal(getOrCreateProject(db, '/tmp/demo-app').autopilot, 0);
  });

  it('unknown project throws', () => {
    const { db } = setup();
    assert.throws(() => setAutopilot(db, 'nope', true), /no such project/);
  });
});

describe('tasks', () => {
  it('creates in backlog with incrementing position', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'First');
    const b = createTask(db, project.id, 'Second', { tag: 'ui' });
    assert.equal(a.lane, 'backlog');
    assert.equal(b.position, a.position + 1);
    assert.equal(b.tag, 'ui');
  });

  it('logs a create event', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const events = getRecentEvents(db, project.id);
    assert.equal(events[0].type, 'create');
    assert.equal(events[0].task_id, task.id);
  });

  it('updates requirements and depends_on', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const updated = updateTask(db, task.id, {
      requirements: '## Spec\n- do the thing',
      depends_on: ['abc123'],
    });
    assert.equal(updated.requirements, '## Spec\n- do the thing');
    assert.deepEqual(JSON.parse(updated.depends_on!), ['abc123']);
    assert.ok(updated.updated_at >= task.updated_at);
  });

  it('rejects an empty patch and unknown tasks', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    assert.throws(() => updateTask(db, task.id, {}), /empty patch/);
    assert.throws(() => updateTask(db, 'nope', { tag: 'ui' }), /no such task/);
  });
});

describe('moves', () => {
  it('moves between lanes and logs from/to', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const moved = moveTask(db, task.id, 'in_progress', 'builder-1');
    assert.equal(moved.lane, 'in_progress');
    const event = getRecentEvents(db, project.id)[0];
    assert.equal(event.type, 'move');
    assert.deepEqual(JSON.parse(event.payload!), { from: 'backlog', to: 'in_progress' });
    assert.equal(event.agent, 'builder-1');
  });

  it('rejects invalid lanes', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    assert.throws(() => moveTask(db, task.id, 'doing'), /invalid lane/);
  });

  it('same-lane move is a no-op (no event)', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const before = getRecentEvents(db, project.id).length;
    moveTask(db, task.id, 'backlog');
    assert.equal(getRecentEvents(db, project.id).length, before);
  });
});

describe('assignment', () => {
  it('records agent, worktree and branch', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const assigned = assignCard(db, task.id, 'builder-1', `.trees/${task.id}`, `card/${task.id}`);
    assert.equal(assigned.assigned_agent, 'builder-1');
    assert.equal(assigned.worktree_path, `.trees/${task.id}`);
    assert.equal(assigned.branch, `card/${task.id}`);
    assert.ok(getRecentEvents(db, project.id).some((e) => e.type === 'assign'));
  });

  it('picks up the assigned team member’s skill (persona)', () => {
    const { db, project } = setup();
    const ada = createTeamMember(db, 'Ada', { skill: 'flutter-dev' });
    const t = createTask(db, project.id, 'UI card', { requirements: 'x' });
    assert.equal(assignCard(db, t.id, ada.id, `.trees/${t.id}`, `card/${t.id}`).skill, 'flutter-dev');
    const t2 = createTask(db, project.id, 'UI 2', { requirements: 'y' });
    assert.equal(assignCard(db, t2.id, 'Ada', `.trees/${t2.id}`, `card/${t2.id}`).skill, 'flutter-dev'); // by name
    const t3 = createTask(db, project.id, 'card 3', { requirements: 'z' });
    assert.equal(assignCard(db, t3.id, 'nobody', `.trees/${t3.id}`, `card/${t3.id}`, 'node-ts-quality').skill, 'node-ts-quality'); // explicit wins
  });

  it('an assigned card leaves backlog/queued for in_progress', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Work me', { requirements: 'x' });
    moveTask(db, t.id, 'queued');
    const a = assignCard(db, t.id, 'builder-1', `.trees/${t.id}`, `card/${t.id}`);
    assert.equal(a.lane, 'in_progress');
  });

  it('does not yank a card already past queued back to in_progress', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'In review', { requirements: 'x' });
    moveTask(db, t.id, 'in_review');
    const a = assignCard(db, t.id, 'builder-1', `.trees/${t.id}`, `card/${t.id}`);
    assert.equal(a.lane, 'in_review');
  });

  it('concurrent assigns each advance their own card (no first-queued race)', () => {
    const { db, project } = setup();
    const x = createTask(db, project.id, 'X', { requirements: 'x' });
    const y = createTask(db, project.id, 'Y', { requirements: 'y' });
    moveTask(db, x.id, 'queued');
    moveTask(db, y.id, 'queued');
    assignCard(db, x.id, 'builder-1', `.trees/${x.id}`, `card/${x.id}`);
    assignCard(db, y.id, 'builder-2', `.trees/${y.id}`, `card/${y.id}`);
    const board = getBoard(db, project.id);
    assert.equal(board.find((c) => c.id === x.id)!.lane, 'in_progress');
    assert.equal(board.find((c) => c.id === y.id)!.lane, 'in_progress');
  });
});

describe('next card', () => {
  it('returns top backlog card with satisfied deps', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'Schema');
    const b = createTask(db, project.id, 'API', { depends_on: [a.id] });
    // b depends on a (not done) -> a is next
    assert.equal(getNextCard(db, project.id)!.id, a.id);
    moveTask(db, a.id, 'done');
    // a done -> b eligible
    assert.equal(getNextCard(db, project.id)!.id, b.id);
    moveTask(db, b.id, 'done');
    assert.equal(getNextCard(db, project.id), null);
  });

  it('skips blocked cards in favor of later eligible ones', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'Blocked', { depends_on: ['missing-dep'] });
    const b = createTask(db, project.id, 'Free');
    assert.equal(getNextCard(db, project.id)!.id, b.id);
    assert.equal(a.position < b.position, true);
  });
});

describe('reviews', () => {
  it('records verdicts and bumps review_rounds', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    const r1 = recordReview(db, task.id, 'fail', [
      { file: 'src/x.ts', line: 10, severity: 'major', note: 'off by one' },
    ]);
    assert.equal(r1.round, 1);
    const r2 = recordReview(db, task.id, 'pass');
    assert.equal(r2.round, 2);
    const event = getRecentEvents(db, project.id)[0];
    assert.equal(event.type, 'review');
    assert.deepEqual(JSON.parse(event.payload!), { verdict: 'pass', round: 2, findings: 0 });
  });
});

describe('subtasks (acceptance criteria)', () => {
  it('sets criteria unchecked and reports progress in summaries', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    setSubtasks(db, task.id, ['write code', 'write tests', 'verify']);
    const [card] = getBoard(db, project.id);
    assert.deepEqual(card.subs, { done: 0, total: 3 });
    const event = getRecentEvents(db, project.id)[0];
    assert.equal(event.type, 'subtasks');
  });

  it('checks one criterion and logs progress', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    setSubtasks(db, task.id, ['a', 'b']);
    const { task: updated, moved } = checkSubtask(db, task.id, 0, true, 'builder-1');
    assert.equal(moved, false);
    assert.deepEqual(JSON.parse(updated.subtasks!), [
      { text: 'a', done: true },
      { text: 'b', done: false },
    ]);
    const event = getRecentEvents(db, project.id)[0];
    assert.equal(event.type, 'check');
    assert.deepEqual(JSON.parse(event.payload!).progress, { done: 1, total: 2 });
  });

  it('auto-moves to in_review when the last criterion is checked in_progress', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    setSubtasks(db, task.id, ['a', 'b']);
    moveTask(db, task.id, 'in_progress');
    checkSubtask(db, task.id, 0);
    assert.equal(checkSubtask(db, task.id, 1).moved, true);
    assert.equal(getBoard(db, project.id)[0].lane, 'in_review');
  });

  it('does not auto-move from other lanes or on uncheck', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'First');
    setSubtasks(db, task.id, ['a']);
    // all checked but still queued -> stays put
    assert.equal(checkSubtask(db, task.id, 0).moved, false);
    assert.equal(getBoard(db, project.id)[0].lane, 'backlog');
    // unchecking never moves
    moveTask(db, task.id, 'in_progress');
    assert.equal(checkSubtask(db, task.id, 0, false).moved, false);
    assert.throws(() => checkSubtask(db, task.id, 5), /no subtask/);
  });

  it('cards without criteria have null subs', () => {
    const { db, project } = setup();
    createTask(db, project.id, 'Plain');
    assert.equal(getBoard(db, project.id)[0].subs, null);
  });
});

describe('board reads', () => {
  it('returns terse card summaries only', () => {
    const { db, project } = setup();
    createTask(db, project.id, 'First', { requirements: 'long spec text' });
    const [card] = getBoard(db, project.id);
    assert.deepEqual(Object.keys(card).sort(), ['agent', 'blocked', 'blocked_reason', 'id', 'lane', 'lane_since', 'phase_id', 'rounds', 'skill', 'subs', 'tag', 'title', 'updated_at', 'work_type']);
  });

  it('active cards are the in_progress lane', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'First');
    createTask(db, project.id, 'Second');
    moveTask(db, a.id, 'in_progress');
    const active = getActiveCards(db, project.id);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, a.id);
  });

  it('events are scoped to their project', () => {
    const { db, project } = setup();
    const other = getOrCreateProject(db, '/tmp/other-app');
    appendEvent(db, { project_id: other.id, type: 'note', payload: { msg: 'hi' } });
    assert.equal(getRecentEvents(db, project.id).length, 0);
  });
});

describe('outbox', () => {
  it('tees every appendEvent into the outbox in the same transaction', () => {
    const { db, project } = setup();
    const ev = appendEvent(db, {
      project_id: project.id,
      task_id: 't1',
      type: 'note',
      payload: { msg: 'hi' },
    });
    // (a) task_events row exists
    const teRow = db.prepare('SELECT * FROM task_events WHERE id = ?').get(ev.id) as TaskEvent;
    assert.ok(teRow);
    assert.equal(teRow.type, 'note');
    // (b) matching outbox row with same type + payload
    const obRow = db
      .prepare('SELECT * FROM outbox WHERE project_id = ? AND task_id = ?')
      .get(project.id, 't1') as {
      type: string;
      payload: string;
      created_at: number;
      status: string;
      attempts: number;
      last_attempt_at: number | null;
    };
    assert.ok(obRow);
    assert.equal(obRow.type, ev.type);
    assert.equal(obRow.payload, ev.payload);
    assert.equal(obRow.created_at, ev.created_at);
    // (c) status='pending', attempts=0
    assert.equal(obRow.status, 'pending');
    assert.equal(obRow.attempts, 0);
    assert.equal(obRow.last_attempt_at, null);
  });

  it('writes one outbox row per event, unconditionally, for every mutation', () => {
    const { db, project } = setup();
    createTask(db, project.id, 'First'); // logs a create event
    const events = db.prepare('SELECT COUNT(*) AS c FROM task_events WHERE project_id = ?').get(project.id) as { c: number };
    const outbox = db.prepare('SELECT COUNT(*) AS c FROM outbox WHERE project_id = ?').get(project.id) as { c: number };
    assert.equal(events.c, outbox.c);
    assert.ok(events.c > 0);
  });

  it("defaults the outbox origin to 'local' when appendEvent gets no origin", () => {
    const { db, project } = setup();
    appendEvent(db, { project_id: project.id, task_id: 't-loc', type: 'note', payload: { m: 1 } });
    const row = db
      .prepare('SELECT origin FROM outbox WHERE project_id = ? AND task_id = ?')
      .get(project.id, 't-loc') as { origin: string };
    assert.equal(row.origin, 'local');
  });

  it("writes the given origin onto the outbox row (e.g. 'remote')", () => {
    const { db, project } = setup();
    appendEvent(db, {
      project_id: project.id,
      task_id: 't-rem',
      type: 'note',
      payload: { m: 2 },
      origin: 'remote',
    });
    const row = db
      .prepare('SELECT origin FROM outbox WHERE project_id = ? AND task_id = ?')
      .get(project.id, 't-rem') as { origin: string };
    assert.equal(row.origin, 'remote');
  });
});

describe('migrate: outbox.origin', () => {
  it('adds origin to a pre-existing outbox table without it, and is idempotent', () => {
    // Simulate an OLD DB: outbox created before the origin column existed.
    // migrate() applies schema.sql (whose idx_tasks_project_lane references
    // project_id/lane/position), so seed a realistic legacy tasks table that
    // already carries those original columns.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE tasks (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      title         TEXT NOT NULL,
      lane          TEXT NOT NULL DEFAULT 'backlog',
      position      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE outbox (
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
    db.prepare(
      "INSERT INTO outbox (project_id, task_id, type, payload, created_at) VALUES ('p', 'old', 'note', NULL, 1)",
    ).run();
    const before = (db.pragma('table_info(outbox)') as { name: string }[]).map((c) => c.name);
    assert.ok(!before.includes('origin'));

    migrate(db);
    const after = (db.pragma('table_info(outbox)') as { name: string }[]).map((c) => c.name);
    assert.ok(after.includes('origin'));
    // existing row backfills to the 'local' default
    const row = db.prepare("SELECT origin FROM outbox WHERE task_id = 'old'").get() as { origin: string };
    assert.equal(row.origin, 'local');

    // idempotent: a second migrate() must not throw (no duplicate ALTER)
    assert.doesNotThrow(() => migrate(db));
  });
});

describe('taskContentHash', () => {
  const base = {
    title: 'Ship it',
    requirements: 'do the thing',
    lane: 'backlog' as const,
    tag: 'db',
    subtasks: JSON.stringify([
      { text: 'a', done: false },
      { text: 'b', done: true },
    ]),
  };

  it('is stable across unrelated fields and object key order', () => {
    const h1 = taskContentHash(base);
    // reorder keys + add unrelated fields (id/timestamps/position) → same hash
    const h2 = taskContentHash({
      id: 'xyz',
      position: 99,
      created_at: 123,
      updated_at: 456,
      tag: 'db',
      lane: 'backlog',
      requirements: 'do the thing',
      title: 'Ship it',
      subtasks: base.subtasks,
    } as unknown as typeof base);
    assert.equal(h1, h2);
  });

  it('treats an array of subtasks the same as its JSON-string form', () => {
    const asArray = taskContentHash({
      ...base,
      subtasks: [
        { text: 'a', done: false },
        { text: 'b', done: true },
      ],
    });
    assert.equal(asArray, taskContentHash(base));
  });

  it('changes when a syncable field changes (title)', () => {
    assert.notEqual(taskContentHash(base), taskContentHash({ ...base, title: 'Different' }));
  });

  it('changes when a subtask changes', () => {
    const changed = taskContentHash({
      ...base,
      subtasks: JSON.stringify([
        { text: 'a', done: true }, // done flipped
        { text: 'b', done: true },
      ]),
    });
    assert.notEqual(taskContentHash(base), changed);
  });

  it('returns a 64-char hex sha256 digest', () => {
    assert.match(taskContentHash(base), /^[0-9a-f]{64}$/);
  });
});

describe('phases', () => {
  it('creates phases planned with incrementing position and logs an event', () => {
    const { db, project } = setup();
    const p1 = createPhase(db, project.id, 'Foundations', { goal: 'scaffold' });
    const p2 = createPhase(db, project.id, 'API');
    assert.equal(p1.status, 'planned');
    assert.equal(p1.goal, 'scaffold');
    assert.equal(p2.position, p1.position + 1);
    assert.equal(getRecentEvents(db, project.id)[0].type, 'phase_create');
  });

  it('advance kicks off the first, then completes+activates the next, then finishes', () => {
    const { db, project } = setup();
    const p1 = createPhase(db, project.id, 'One');
    const p2 = createPhase(db, project.id, 'Two');
    assert.equal(getActivePhase(db, project.id), null);
    // kickoff: nothing active → activate the first
    assert.equal(advancePhase(db, project.id)!.id, p1.id);
    assert.equal(getActivePhase(db, project.id)!.id, p1.id);
    assert.equal(getNextPhase(db, project.id)!.id, p2.id);
    // advance: p1 done, p2 active
    assert.equal(advancePhase(db, project.id)!.id, p2.id);
    assert.equal(getPhase(db, p1.id).status, 'done');
    assert.equal(getActivePhase(db, project.id)!.id, p2.id);
    // advance again: p2 done, none left → null
    assert.equal(advancePhase(db, project.id), null);
    assert.equal(getPhase(db, p2.id).status, 'done');
  });

  it('get_next_card is scoped to the active phase', () => {
    const { db, project } = setup();
    const p1 = createPhase(db, project.id, 'One');
    const p2 = createPhase(db, project.id, 'Two');
    const c2 = createTask(db, project.id, 'Two card', { phase_id: p2.id });
    const c1 = createTask(db, project.id, 'One card', { phase_id: p1.id });
    advancePhase(db, project.id); // p1 active
    // c2 was created first, but only p1's card is eligible
    assert.equal(getNextCard(db, project.id)!.id, c1.id);
    advancePhase(db, project.id); // p1 done, p2 active
    assert.equal(getNextCard(db, project.id)!.id, c2.id);
  });

  it('reports per-phase card progress and carries phase_id on summaries', () => {
    const { db, project } = setup();
    const p1 = createPhase(db, project.id, 'One');
    const a = createTask(db, project.id, 'a', { phase_id: p1.id });
    createTask(db, project.id, 'b', { phase_id: p1.id });
    moveTask(db, a.id, 'done');
    const [view] = getPhases(db, project.id);
    assert.deepEqual(view.progress, { done: 1, total: 2 });
    assert.equal(view.budget_usd, null);
    setPhaseBudget(db, p1.id, 42.5);
    assert.equal(getPhases(db, project.id)[0].budget_usd, 42.5);
    assert.equal(getBoard(db, project.id)[0].phase_id, p1.id);
  });

  it('update_phase activate parks the current active phase', () => {
    const { db, project } = setup();
    const p1 = createPhase(db, project.id, 'One');
    const p2 = createPhase(db, project.id, 'Two');
    advancePhase(db, project.id); // p1 active
    assert.equal(updatePhase(db, p2.id, { status: 'active' }).status, 'active');
    assert.equal(getPhase(db, p1.id).status, 'planned');
    assert.equal(getPhases(db, project.id).filter((p) => p.status === 'active').length, 1);
    const types = getRecentEvents(db, project.id).slice(0, 2).map((e) => e.type);
    assert.deepEqual(types.sort(), ['phase_activate', 'phase_park']);
  });

  it('update_phase closes a non-active phase without touching the active one', () => {
    const { db, project } = setup();
    const p1 = createPhase(db, project.id, 'One');
    const p2 = createPhase(db, project.id, 'Two');
    advancePhase(db, project.id); // p1 active
    assert.equal(updatePhase(db, p2.id, { status: 'done' }).status, 'done');
    assert.equal(getActivePhase(db, project.id)!.id, p1.id);
  });

  it('update_phase reorders to contiguous positions and clamps out-of-range', () => {
    const { db, project } = setup();
    const a = createPhase(db, project.id, 'A');
    const b = createPhase(db, project.id, 'B');
    const c = createPhase(db, project.id, 'C');
    updatePhase(db, c.id, { position: 1 });
    let order = getPhases(db, project.id);
    assert.deepEqual(order.map((p) => p.id), [c.id, a.id, b.id]);
    assert.deepEqual(order.map((p) => p.position), [1, 2, 3]);
    updatePhase(db, c.id, { position: 99 });
    order = getPhases(db, project.id);
    assert.deepEqual(order.map((p) => p.id), [a.id, b.id, c.id]);
    assert.deepEqual(order.map((p) => p.position), [1, 2, 3]);
    updatePhase(db, c.id, { position: 0 });
    assert.equal(getPhases(db, project.id)[0].id, c.id);
  });

  it('update_phase rejects an invalid status; same status is a no-op', () => {
    const { db, project } = setup();
    const p1 = createPhase(db, project.id, 'One');
    assert.throws(() => updatePhase(db, p1.id, { status: 'bogus' as never }), /invalid phase status/);
    assert.throws(() => updatePhase(db, 'nope', { status: 'done' }), /no such phase/);
    const before = getRecentEvents(db, project.id).length;
    updatePhase(db, p1.id, { status: 'planned' });
    assert.equal(getRecentEvents(db, project.id).length, before);
    assert.equal(getPhase(db, p1.id).status, 'planned');
  });
});

describe('attention', () => {
  // shift a card's events/reviews into the past to trip time-based signals
  const agedEvents = (db: ReturnType<typeof openDb>, taskId: string, ms: number) =>
    db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(ms, taskId);
  const agedReviews = (db: ReturnType<typeof openDb>, taskId: string, ms: number) =>
    db.prepare('UPDATE reviews SET created_at = created_at - ? WHERE task_id = ?').run(ms, taskId);

  it('flags a backlog card with no spec', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'No spec');
    const [item] = getAttention(db, project.id);
    assert.equal(item.kind, 'needs_spec');
    assert.equal(item.severity, 'warn');
    assert.equal(item.card_id, t.id);
  });

  it('does not flag needs_spec once requirements exist', () => {
    const { db, project } = setup();
    createTask(db, project.id, 'Has spec', { requirements: 'do it' });
    assert.equal(getAttention(db, project.id).length, 0);
  });

  it('flags two failed reviews as a blocker', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Flaky', { requirements: 'x' });
    moveTask(db, t.id, 'in_review');
    recordReview(db, t.id, 'fail');
    recordReview(db, t.id, 'fail');
    const [item] = getAttention(db, project.id);
    assert.equal(item.kind, 'review_failed');
    assert.equal(item.severity, 'blocker');
  });

  it('flags a passed-but-unmerged card as a possible conflict', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Merged?', { requirements: 'x' });
    moveTask(db, t.id, 'in_review');
    recordReview(db, t.id, 'pass');
    agedReviews(db, t.id, 11 * 60_000);
    const [item] = getAttention(db, project.id);
    assert.equal(item.kind, 'merge_conflict');
    assert.equal(item.severity, 'blocker');
  });

  it('escalates a quiet in_progress card from warn to blocker', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Stuck', { requirements: 'x' });
    moveTask(db, t.id, 'in_progress');
    agedEvents(db, t.id, 20 * 60_000);
    assert.equal(getAttention(db, project.id)[0].kind, 'stalled');
    assert.equal(getAttention(db, project.id)[0].severity, 'warn');
    agedEvents(db, t.id, 30 * 60_000); // ~50m quiet total
    assert.equal(getAttention(db, project.id)[0].severity, 'blocker');
  });

  it('names the quiet / waiting spans in human units, not raw minutes', () => {
    const { db, project } = setup();
    const quiet = createTask(db, project.id, 'Quiet', { requirements: 'x' });
    moveTask(db, quiet.id, 'in_progress');
    agedEvents(db, quiet.id, (3 * 24 + 21) * 3_600_000); // 5580m
    const review = createTask(db, project.id, 'Review', { requirements: 'x' });
    moveTask(db, review.id, 'in_review');
    agedEvents(db, review.id, 125 * 60_000);
    const reasons = new Map(getAttention(db, project.id).map((i) => [i.card_id, i.reason]));
    assert.equal(reasons.get(quiet.id), 'Agent quiet 3d 21h — may be stuck');
    assert.equal(reasons.get(review.id), 'In review 2h 5m, no verdict — dispatch reviewer');
  });

  it('humanSpan: minutes, hours + minutes, days + hours; a zero tail dropped', () => {
    assert.equal(humanSpan(0), '0m');
    assert.equal(humanSpan(16 * 60_000), '16m');
    assert.equal(humanSpan(60 * 60_000), '1h');
    assert.equal(humanSpan(125 * 60_000), '2h 5m');
    assert.equal(humanSpan(48 * 3_600_000), '2d');
    assert.equal(humanSpan(5566 * 60_000), '3d 20h');
  });

  it('flags an in_review card with no verdict after the grace window', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Waiting', { requirements: 'x' });
    moveTask(db, t.id, 'in_review');
    agedEvents(db, t.id, 11 * 60_000);
    assert.equal(getAttention(db, project.id)[0].kind, 'awaiting_review');
  });

  it('excludes done cards and ranks blockers before warnings', () => {
    const { db, project } = setup();
    createTask(db, project.id, 'Needs spec'); // warn
    const fail = createTask(db, project.id, 'Fails', { requirements: 'x' });
    moveTask(db, fail.id, 'in_review');
    recordReview(db, fail.id, 'fail');
    recordReview(db, fail.id, 'fail'); // blocker
    const done = createTask(db, project.id, 'Done', { requirements: 'x' });
    moveTask(db, done.id, 'done');
    const items = getAttention(db, project.id);
    assert.equal(items.length, 2); // done excluded
    assert.equal(items[0].kind, 'review_failed'); // blocker first
    assert.equal(items[1].kind, 'needs_spec');
  });

  it('counts how many open cards a card blocks', () => {
    const { db, project } = setup();
    const base = createTask(db, project.id, 'Base', { requirements: 'x' });
    createTask(db, project.id, 'Dep A', { requirements: 'x', depends_on: [base.id] });
    createTask(db, project.id, 'Dep B', { requirements: 'x', depends_on: [base.id] });
    moveTask(db, base.id, 'in_progress');
    agedEvents(db, base.id, 20 * 60_000);
    const item = getAttention(db, project.id).find((i) => i.card_id === base.id);
    assert.equal(item!.blocking, 2);
  });
});

describe('workspace summary', () => {
  function build() {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-sum-'));
    for (const sub of ['mobile', 'web']) mkdirSync(join(dir, sub));
    const db = openDb();
    const ws = getOrCreateProject(db, dir, 'Shop');
    const mobile = createVertical(db, ws.id, 'Mobile', join(dir, 'mobile'));
    const web = createVertical(db, ws.id, 'Web', join(dir, 'web'));
    const cleanup = () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { db, ws, mobile, web, cleanup };
  }

  it('summarizes each board and merges attention, most severe board first', (t) => {
    const { db, ws, mobile, web, cleanup } = build();
    t.after(cleanup);
    // workspace board: one spec-less backlog card → a 'warn' attention item
    createTask(db, ws.id, 'Unspecced');
    // mobile: cards across lanes, a blocker, an active phase at 1/2
    const phase = createPhase(db, mobile.id, 'Launch');
    advancePhase(db, mobile.id);
    createTask(db, mobile.id, 'Backlog', { requirements: 'x' });
    const q = createTask(db, mobile.id, 'Queued', { requirements: 'x' });
    moveTask(db, q.id, 'queued');
    const rev = createTask(db, mobile.id, 'Reviewing', { requirements: 'x' });
    moveTask(db, rev.id, 'in_review');
    const a = createTask(db, mobile.id, 'Building A', { requirements: 'x', phase_id: phase.id });
    assignCard(db, a.id, 'Ada', '.trees/a', 'card/a');
    const b = createTask(db, mobile.id, 'Building B', { requirements: 'x' });
    moveTask(db, b.id, 'in_progress');
    raiseBlocker(db, b.id, 'which db?');
    const d = createTask(db, mobile.id, 'Shipped', { requirements: 'x', phase_id: phase.id });
    moveTask(db, d.id, 'done');
    recordActivity(db, { project_id: mobile.id, task_id: a.id, agent: 'Ada', tokens: 1000, tokens_out: 200, lines_added: 30, lines_removed: 5, ms: 60000 });
    recordActivity(db, { project_id: mobile.id, task_id: d.id, agent: 'Ada', tokens: 500, tokens_out: 100, lines_added: 10, lines_removed: 2, ms: 30000 });
    // web: quiet, fully specced
    createTask(db, web.id, 'Later', { requirements: 'x' });

    for (const id of [ws.id, mobile.id]) {
      const sum = getWorkspaceSummary(db, id);
      assert.deepEqual(sum.workspace, { id: ws.id, name: 'Shop' });
      assert.deepEqual(
        sum.boards.map((bd) => bd.project.id),
        [ws.id, mobile.id, web.id],
      );
    }
    const sum = getWorkspaceSummary(db, ws.id);
    const [wsB, mB, webB] = sum.boards;
    assert.deepEqual(mB.project, { id: mobile.id, name: 'Mobile', root_path: mobile.root_path, parent_id: ws.id, autopilot: 0 });
    assert.deepEqual(mB.lanes, { backlog: 1, queued: 1, in_progress: 2, in_review: 1, done: 1 });
    assert.deepEqual(
      mB.active.map(({ lane_since, ...c }) => (assert.equal(typeof lane_since, 'number'), c)),
      [
        { id: a.id, title: 'Building A', lane: 'in_progress', agent: 'Ada', blocked: false, work_type: null },
        { id: b.id, title: 'Building B', lane: 'in_progress', agent: null, blocked: true, work_type: null },
        { id: rev.id, title: 'Reviewing', lane: 'in_review', agent: null, blocked: false, work_type: null },
      ],
    );
    assert.equal(mB.blocked, 1);
    assert.deepEqual(mB.phase, { id: phase.id, title: 'Launch', done: 1, total: 2 });
    assert.deepEqual(mB.totals, { cards: 2, tokens: 1500, tokens_out: 300, lines_added: 40, lines_removed: 7, ms: 90000 });

    assert.deepEqual(wsB.lanes, { backlog: 1, queued: 0, in_progress: 0, in_review: 0, done: 0 });
    assert.deepEqual(wsB.active, []);
    assert.equal(wsB.blocked, 0);
    assert.equal(wsB.phase, null);
    assert.deepEqual(wsB.totals, { cards: 0, tokens: 0, tokens_out: 0, lines_added: 0, lines_removed: 0, ms: 0 });
    assert.equal(webB.lanes.backlog, 1);

    // attention: mobile (holds the blocker) before the workspace (warn only); web has none
    assert.deepEqual(
      sum.attention.map((i) => [i.project_id, i.project_name, i.kind, i.severity]),
      [
        [mobile.id, 'Mobile', 'blocked', 'blocker'],
        [ws.id, 'Shop', 'needs_spec', 'warn'],
      ],
    );
    assert.equal(sum.attention[0].card_id, b.id);
  });

  it('a standalone project has exactly one board; unknown ids throw', () => {
    const { db, project } = setup();
    const sum = getWorkspaceSummary(db, project.id);
    assert.equal(sum.boards.length, 1);
    assert.equal(sum.boards[0].project.id, project.id);
    assert.deepEqual(sum.attention, []);
    assert.throws(() => getWorkspaceSummary(db, 'nope'), /no such project/);
  });
});

describe('workspace summary cost', () => {
  it('stays fast on a large workspace (3 verticals x 300 cards x 30 phases)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-perf-'));
    const db = openDb();
    try {
      const ws = getOrCreateProject(db, dir, 'Big');
      const lanes = ['backlog', 'queued', 'in_progress', 'in_review', 'done'];
      const insert = db.prepare(
        `INSERT INTO tasks (id, project_id, phase_id, title, lane, requirements, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'x', ?, ?, ?)`,
      );
      db.transaction(() => {
        for (let v = 0; v < 3; v++) {
          mkdirSync(join(dir, `v${v}`));
          const vert = createVertical(db, ws.id, `V${v}`, join(dir, `v${v}`));
          const phases = Array.from({ length: 30 }, (_, i) => createPhase(db, vert.id, `P${i}`));
          advancePhase(db, vert.id);
          const ts = Date.now();
          for (let i = 0; i < 300; i++) {
            insert.run(`v${v}t${i}`, vert.id, phases[i % 30].id, `Card ${i}`, lanes[i % 5], i, ts, ts);
          }
        }
      })();

      const start = performance.now();
      const summary = getWorkspaceSummary(db, ws.id);
      const elapsed = performance.now() - start;
      assert.equal(summary.boards.length, 4);
      assert.equal(summary.boards[1].phase?.total, 10);
      // Pathological-regression guard only (loaded machines/parallel runs are noisy);
      // the EXPLAIN QUERY PLAN test below is the real index regression check.
      const budget = Number(process.env.KANKAN_PERF_BUDGET_MS) || 2000;
      assert.ok(elapsed < budget, `getWorkspaceSummary took ${elapsed.toFixed(1)}ms (budget ${budget}ms)`);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('active-phase progress query uses idx_tasks_phase', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS total, SUM(lane = 'done') AS done FROM tasks WHERE phase_id = ?`)
      .all('x') as { detail: string }[];
    assert.ok(
      plan.some((r) => /USING (COVERING )?INDEX idx_tasks_phase/.test(r.detail)),
      JSON.stringify(plan),
    );
  });
});

describe('activity stats', () => {
  it('aggregates tokens/lines/time per card and per agent', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'A');
    const b = createTask(db, project.id, 'B');
    recordActivity(db, { project_id: project.id, task_id: a.id, agent: 'Ada', agent_id: 'x1', tokens: 1000, tokens_out: 200, lines_added: 30, lines_removed: 5, ms: 60000 });
    recordActivity(db, { project_id: project.id, task_id: a.id, agent: 'Ada', agent_id: 'x2', tokens: 500, tokens_out: 100, lines_added: 10, lines_removed: 2, ms: 30000 }); // 2nd round, same card
    recordActivity(db, { project_id: project.id, task_id: b.id, agent: 'Turing', agent_id: 'y1', tokens: 800, tokens_out: 150, lines_added: 20, lines_removed: 0, ms: 45000 });

    assert.deepEqual(cardTotals(db, a.id), { tokens: 1500, tokens_out: 300, lines_added: 40, lines_removed: 7, ms: 90000 });

    const stats = getStats(db, project.id);
    assert.equal(stats.totals.cards, 2);
    assert.equal(stats.totals.tokens, 2300);
    assert.equal(stats.agents.length, 2);
    const ada = stats.agents.find((s) => s.agent === 'Ada')!;
    assert.equal(ada.cards, 1); // distinct cards touched
    assert.equal(ada.tokens, 1500);
    assert.equal(ada.ms, 90000);
  });
});

describe('delete + redirect', () => {
  it('deletes a card with its reviews/events and logs a project-level delete', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Doomed', { requirements: 'x' });
    recordReview(db, t.id, 'fail');
    deleteTask(db, t.id);
    assert.equal(getBoard(db, project.id).length, 0);
    const reviews = db.prepare('SELECT COUNT(*) AS c FROM reviews WHERE task_id = ?').get(t.id) as { c: number };
    assert.equal(reviews.c, 0);
    const events = getRecentEvents(db, project.id);
    assert.equal(events[0].type, 'delete');
    assert.equal(events[0].task_id, null); // project-level, survives the card
  });

  it('unblocks dependents when their blocker is deleted', () => {
    const { db, project } = setup();
    const base = createTask(db, project.id, 'Base');
    const dep = createTask(db, project.id, 'Dep', { depends_on: [base.id] });
    // dep is blocked on base; base is next
    assert.equal(getNextCard(db, project.id)!.id, base.id);
    deleteTask(db, base.id);
    // base gone + scrubbed from dep.depends_on → dep is now eligible
    assert.equal(getNextCard(db, project.id)!.id, dep.id);
  });

  it('rejects deleting an unknown card', () => {
    const { db } = setup();
    assert.throws(() => deleteTask(db, 'nope'), /no such task/);
  });

  it('redirect resets assignment, rounds, criteria and lane, and sets a new direction', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Wrong approach', { requirements: 'old' });
    setSubtasks(db, t.id, ['a', 'b']);
    assignCard(db, t.id, 'builder-1', `.trees/${t.id}`, `card/${t.id}`);
    moveTask(db, t.id, 'in_review');
    recordReview(db, t.id, 'fail');
    recordReview(db, t.id, 'fail');
    const r = redirectTask(db, t.id, { requirements: 'new direction', note: 'wrong library' });
    assert.equal(r.lane, 'backlog');
    assert.equal(r.assigned_agent, null);
    assert.equal(r.worktree_path, null);
    assert.equal(r.branch, null);
    assert.equal(r.review_rounds, 0);
    assert.equal(r.subtasks, null);
    assert.equal(r.requirements, 'new direction');
    assert.equal(getRecentEvents(db, project.id)[0].type, 'redirect');
  });

  it('redirect without requirements keeps the existing spec', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Keep spec', { requirements: 'original' });
    const r = redirectTask(db, t.id);
    assert.equal(r.requirements, 'original');
    assert.equal(r.lane, 'backlog');
  });
});

describe('blockers', () => {
  it('raise_blocker flags the card in place (no lane change) and logs a block event', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Ambiguous', { requirements: 'x' });
    moveTask(db, t.id, 'in_progress');
    const b = raiseBlocker(db, t.id, 'Which auth provider?', 'builder-1');
    assert.equal(b.lane, 'in_progress'); // stays put — it's a flag, not a lane
    assert.ok(b.blocked_at);
    assert.equal(b.blocked_reason, 'Which auth provider?');
    const ev = getRecentEvents(db, project.id)[0];
    assert.equal(ev.type, 'block');
    assert.equal(ev.agent, 'builder-1');
    assert.equal(getBoard(db, project.id)[0].blocked, true);
  });

  it('surfaces a blocked card as the top-priority attention item, above derived signals', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Stuck', { requirements: 'x' });
    moveTask(db, t.id, 'in_progress');
    db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(50 * 60_000, t.id); // also long-stalled
    raiseBlocker(db, t.id, 'Confirm the destructive migration');
    const [item] = getAttention(db, project.id);
    assert.equal(item.kind, 'blocked'); // wins over 'stalled'
    assert.equal(item.severity, 'blocker');
    assert.equal(item.reason, 'Confirm the destructive migration');
    assert.equal(item.card_id, t.id);
  });

  it('ranks a fresh blocker above an older same-severity stall on another card', () => {
    const { db, project } = setup();
    const stalled = createTask(db, project.id, 'Old stall', { requirements: 'x' });
    moveTask(db, stalled.id, 'in_progress');
    db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(50 * 60_000, stalled.id); // long-stalled = blocker
    const blocked = createTask(db, project.id, 'Just blocked', { requirements: 'x' });
    moveTask(db, blocked.id, 'in_progress');
    raiseBlocker(db, blocked.id, 'decide this');
    const items = getAttention(db, project.id);
    assert.equal(items[0].card_id, blocked.id); // explicit blocker wins the tie
    assert.equal(items[0].kind, 'blocked');
    assert.equal(items[1].kind, 'stalled');
  });

  it('resolve_blocker clears the flag and logs an unblock event', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Answered', { requirements: 'x' });
    raiseBlocker(db, t.id, 'q?');
    const r = resolveBlocker(db, t.id, 'use provider Y');
    assert.equal(r.blocked_at, null);
    assert.equal(r.blocked_reason, null);
    assert.equal(getRecentEvents(db, project.id)[0].type, 'unblock');
    assert.equal(getAttention(db, project.id).length, 0);
  });

  it('redirect, re-assign, and moving to done each clear a blocker', () => {
    const { db, project } = setup();
    // redirect clears
    const a = createTask(db, project.id, 'A', { requirements: 'x' });
    raiseBlocker(db, a.id, 'q');
    assert.equal(redirectTask(db, a.id).blocked_at, null);
    // re-assign clears
    const b = createTask(db, project.id, 'B', { requirements: 'x' });
    moveTask(db, b.id, 'in_progress');
    raiseBlocker(db, b.id, 'q');
    assert.equal(assignCard(db, b.id, 'builder-1', `.trees/${b.id}`, `card/${b.id}`).blocked_at, null);
    // move → done clears
    const c = createTask(db, project.id, 'C', { requirements: 'x' });
    moveTask(db, c.id, 'in_progress');
    raiseBlocker(db, c.id, 'q');
    assert.equal(moveTask(db, c.id, 'done').blocked_at, null);
  });
});

describe('team roster', () => {
  it('creates, lists, updates and deletes members', () => {
    const { db } = setup();
    const a = createTeamMember(db, 'Ada', { skill: 'flutter-dev', color: '#61afef' });
    assert.ok(a.id);
    assert.equal(a.name, 'Ada');
    assert.equal(a.skill, 'flutter-dev');
    createTeamMember(db, 'Turing'); // no skill
    assert.equal(listTeam(db).length, 2);

    const upd = updateTeamMember(db, a.id, { skill: 'node-ts-quality' });
    assert.equal(upd.skill, 'node-ts-quality');
    assert.equal(upd.name, 'Ada'); // untouched fields preserved

    deleteTeamMember(db, a.id);
    const team = listTeam(db);
    assert.equal(team.length, 1);
    assert.equal(team[0].name, 'Turing');
    assert.equal(team[0].skill, null);
  });

  it('rename carries history over: card_activity / tasks / task_events, across projects', (t) => {
    const { db, project } = setup();
    t.after(() => db.close());
    const other = getOrCreateProject(db, '/tmp/other-app', 'Other');
    const ada = createTeamMember(db, 'Ada');
    createTeamMember(db, 'Turing');
    for (const p of [project, other]) {
      const task = createTask(db, p.id, 'card', { requirements: 'x' });
      assignCard(db, task.id, 'Ada', `.trees/${task.id}`, `card/${task.id}`);
      appendEvent(db, { project_id: p.id, task_id: task.id, type: 'note', agent: 'Ada' });
      recordActivity(db, { project_id: p.id, task_id: task.id, agent: 'Ada', tokens: 100, tokens_out: 10, lines_added: 1, lines_removed: 0, ms: 1 });
      recordActivity(db, { project_id: p.id, task_id: task.id, agent: 'Turing', tokens: 50, tokens_out: 5, lines_added: 1, lines_removed: 0, ms: 1 });
    }

    const renamed = updateTeamMember(db, ada.id, { name: '  Grace  ' });
    assert.equal(renamed.name, 'Grace'); // trimmed
    const count = (sql: string, name: string) => (db.prepare(sql).get(name) as { n: number }).n;
    for (const [sql, expected] of [
      ['SELECT COUNT(*) AS n FROM card_activity WHERE agent = ?', 2],
      ['SELECT COUNT(*) AS n FROM tasks WHERE assigned_agent = ?', 2],
      ['SELECT COUNT(*) AS n FROM task_events WHERE agent = ?', 2],
    ] as const) {
      assert.equal(count(sql, 'Ada'), 0, sql);
      assert.ok(count(sql, 'Grace') >= expected, sql);
    }
    assert.equal(count('SELECT COUNT(*) AS n FROM card_activity WHERE agent = ?', 'Turing'), 2); // others untouched
    for (const p of [project, other]) {
      const agents = getStats(db, p.id).agents.map((a) => a.agent).sort();
      assert.deepEqual(agents, ['Grace', 'Turing']);
    }
  });

  it('rejects duplicate and empty names without changing anything', (t) => {
    const { db, project } = setup();
    t.after(() => db.close());
    const ada = createTeamMember(db, 'Ada');
    createTeamMember(db, 'Turing');
    const task = createTask(db, project.id, 'card', { requirements: 'x' });
    recordActivity(db, { project_id: project.id, task_id: task.id, agent: 'Ada', tokens: 1, tokens_out: 0, lines_added: 0, lines_removed: 0, ms: 1 });
    assert.throws(() => updateTeamMember(db, ada.id, { name: 'Turing' }), /already exists/);
    assert.throws(() => updateTeamMember(db, ada.id, { name: '  Turing ' }), /already exists/);
    assert.throws(() => updateTeamMember(db, ada.id, { name: '   ' }), /empty/);
    assert.throws(() => updateTeamMember(db, ada.id, { name: '' }), /empty/);
    assert.equal(listTeam(db).find((m) => m.id === ada.id)!.name, 'Ada');
    assert.equal(getStats(db, project.id).agents[0].agent, 'Ada');
    assert.equal(updateTeamMember(db, ada.id, { name: 'Ada' }).name, 'Ada'); // own name is fine
  });

  it('rejects a rename onto a name already in history; renaming back still works', (t) => {
    const { db, project } = setup();
    t.after(() => db.close());
    const ada = createTeamMember(db, 'Ada');
    const task = createTask(db, project.id, 'card', { requirements: 'x' });
    const act = (agent: string) =>
      recordActivity(db, { project_id: project.id, task_id: task.id, agent, tokens: 1, tokens_out: 0, lines_added: 0, lines_removed: 0, ms: 1 });
    act('Ada');
    act('Ghost'); // an ex-member label that only lives in card_activity
    assert.throws(() => updateTeamMember(db, ada.id, { name: 'Ghost' }), /already used in this board's history/);
    const t2 = createTask(db, project.id, 'card 2', { requirements: 'x' });
    assignCard(db, t2.id, 'Phantom', '.trees/x', 'card/x'); // tasks.assigned_agent + task_events.agent
    assert.throws(() => updateTeamMember(db, ada.id, { name: 'Phantom' }), /history/);
    appendEvent(db, { project_id: project.id, type: 'note', agent: 'Echo' }); // task_events only
    assert.throws(() => updateTeamMember(db, ada.id, { name: 'Echo' }), /history/);
    assert.equal(updateTeamMember(db, ada.id, { name: 'Grace' }).name, 'Grace');
    assert.equal(updateTeamMember(db, ada.id, { name: 'Ada' }).name, 'Ada'); // back to the previous name
    assert.equal(getStats(db, project.id).agents.find((a) => a.agent === 'Ada')!.tokens, 1);
  });

  it('setTeamAvatar persists and clears the avatar file name', (t) => {
    const { db } = setup();
    t.after(() => db.close());
    const ada = createTeamMember(db, 'Ada');
    assert.equal(ada.avatar, null);
    assert.equal(setTeamAvatar(db, ada.id, `${ada.id}-abc.png`).avatar, `${ada.id}-abc.png`);
    assert.equal(listTeam(db)[0].avatar, `${ada.id}-abc.png`);
    assert.equal(setTeamAvatar(db, ada.id, null).avatar, null);
    assert.throws(() => setTeamAvatar(db, 'nope', null), /no such team member/);
  });
});

describe('subscriptionMatches', () => {
  it('wildcard matches every event type', () => {
    assert.equal(subscriptionMatches('*', 'create'), true);
    assert.equal(subscriptionMatches('*', 'phase_done'), true);
  });

  it('single-token filter matches only that type', () => {
    assert.equal(subscriptionMatches('move', 'move'), true);
    assert.equal(subscriptionMatches('move', 'create'), false);
  });

  it('list membership matches any listed type and nothing else', () => {
    assert.equal(subscriptionMatches('create,move,review', 'move'), true);
    assert.equal(subscriptionMatches('create,move,review', 'review'), true);
    assert.equal(subscriptionMatches('create,move,review', 'assign'), false);
  });

  it('trims whitespace around tokens', () => {
    assert.equal(subscriptionMatches(' create , move ,  review ', 'move'), true);
    assert.equal(subscriptionMatches(' create , move ', 'assign'), false);
  });
});

describe('subscriptions (CRUD + redaction)', () => {
  it('creates and gets back a redacted view (create→get round-trip)', () => {
    const { db, project } = setup();
    const created = createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: 'create,move',
      target: 'https://example.com/hook',
      secret: 's3cr3t',
      scopes: 'read',
    });
    assert.ok(created.id);
    assert.equal(created.enabled, 1);
    const fetched = getSubscription(db, created.id);
    assert.deepEqual(fetched, created);
    assert.equal(fetched!.kind, 'webhook');
    assert.equal(fetched!.event_filter, 'create,move');
    assert.equal(fetched!.target, 'https://example.com/hook');
    assert.equal(fetched!.scopes, 'read'); // scopes returned as-is, no redaction
  });

  it('redacts the secret: view has has_secret and no secret field', () => {
    const { db, project } = setup();
    const withSecret = createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/a',
      secret: 'shhh',
    });
    const noSecret = createSubscription(db, {
      project_id: project.id,
      kind: 'connector',
      event_filter: '*',
      target: 'https://example.com/b',
    });
    assert.equal(withSecret.has_secret, true);
    assert.equal(noSecret.has_secret, false);
    // the raw secret is nowhere in the public view
    assert.ok(!('secret' in withSecret));
    assert.equal((withSecret as unknown as Record<string, unknown>).secret, undefined);
    assert.ok(JSON.stringify(getSubscription(db, withSecret.id)).indexOf('shhh') === -1);
  });

  it('getSubscriptionSecret returns the raw secret (internal delivery accessor)', () => {
    const { db, project } = setup();
    const sub = createSubscription(db, {
      project_id: project.id,
      kind: 'webhook',
      event_filter: '*',
      target: 'https://example.com/hook',
      secret: 'raw-secret',
    });
    assert.equal(getSubscriptionSecret(db, sub.id), 'raw-secret');
    const noSecret = createSubscription(db, {
      project_id: project.id,
      kind: 'bridge',
      event_filter: '*',
      target: 'https://example.com/nb',
    });
    assert.equal(getSubscriptionSecret(db, noSecret.id), null);
    assert.equal(getSubscriptionSecret(db, 'nope'), null);
  });

  it('list returns project-scoped subs plus globals; get returns null for missing', () => {
    const { db, project } = setup();
    const other = getOrCreateProject(db, '/tmp/other-sub-app');
    const global = createSubscription(db, { project_id: null, kind: 'webhook', event_filter: '*', target: 'https://example.com/g' });
    const mine = createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: '*', target: 'https://example.com/m' });
    const theirs = createSubscription(db, { project_id: other.id, kind: 'webhook', event_filter: '*', target: 'https://example.com/t' });

    const scoped = listSubscriptions(db, project.id).map((s) => s.id).sort();
    assert.deepEqual(scoped, [global.id, mine.id].sort()); // mine + global, not theirs
    assert.equal(listSubscriptions(db).length, 3); // omitted project → all
    assert.equal(getSubscription(db, 'missing'), null);
  });

  it('update toggles enabled and returns the redacted view', () => {
    const { db, project } = setup();
    const sub = createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: '*', target: 'https://example.com/x', secret: 'k' });
    assert.equal(sub.enabled, 1);
    const off = updateSubscription(db, sub.id, { enabled: false });
    assert.equal(off.enabled, 0);
    assert.equal(off.has_secret, true); // still redacted, secret preserved
    assert.ok(!('secret' in off));
    assert.equal(updateSubscription(db, sub.id, { enabled: true }).enabled, 1);
    assert.throws(() => updateSubscription(db, 'nope', { enabled: false }), /no such subscription/);
  });

  it('delete removes the row and reports whether one was deleted', () => {
    const { db, project } = setup();
    const sub = createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: '*', target: 'https://example.com/x' });
    assert.equal(deleteSubscription(db, sub.id), true);
    assert.equal(getSubscription(db, sub.id), null);
    assert.equal(deleteSubscription(db, sub.id), false); // already gone
  });

  it('validation throws on bad kind and on a bogus event_filter token', () => {
    const { db, project } = setup();
    assert.throws(
      () => createSubscription(db, { project_id: project.id, kind: 'email' as never, event_filter: '*', target: 'https://example.com/x' }),
      /invalid subscription kind/,
    );
    assert.throws(
      () => createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: 'create,bogus', target: 'https://example.com/x' }),
      /invalid event_filter token/,
    );
    // a real EventType list is accepted
    assert.ok(createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: 'create,move,phase_done', target: 'https://example.com/x' }).id);
  });

  it('rejects a cloud-metadata target at creation (SSRF defense → would be HTTP 400)', () => {
    const { db, project } = setup();
    assert.throws(
      () => createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: '*', target: 'http://169.254.169.254/latest/meta-data/' }),
      /metadata/i,
    );
    // and it stored nothing
    assert.equal(listSubscriptions(db, project.id).length, 0);
  });
});

describe('deliveries (read-only listing + DLQ)', () => {
  // No write API for deliveries (the dispatcher owns that) — insert rows directly.
  const insertDelivery = (
    db: ReturnType<typeof openDb>,
    d: { outbox_id: number; subscription_id: string; status?: string; attempts?: number },
  ) =>
    db
      .prepare(
        `INSERT INTO deliveries (outbox_id, subscription_id, status, attempts, last_status_code, last_error, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(d.outbox_id, d.subscription_id, d.status ?? 'pending', d.attempts ?? 0, Date.now(), Date.now());

  it('filters by subscription_id', () => {
    const { db } = setup();
    insertDelivery(db, { outbox_id: 1, subscription_id: 'sub-a' });
    insertDelivery(db, { outbox_id: 2, subscription_id: 'sub-b' });
    insertDelivery(db, { outbox_id: 3, subscription_id: 'sub-a' });
    const rows = listDeliveries(db, { subscription_id: 'sub-a' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.subscription_id === 'sub-a'));
  });

  it('filters by status, including the DLQ (status=dead)', () => {
    const { db } = setup();
    insertDelivery(db, { outbox_id: 1, subscription_id: 'sub-a', status: 'pending' });
    insertDelivery(db, { outbox_id: 2, subscription_id: 'sub-a', status: 'dead' });
    insertDelivery(db, { outbox_id: 3, subscription_id: 'sub-a', status: 'delivered' });
    insertDelivery(db, { outbox_id: 4, subscription_id: 'sub-a', status: 'dead' });
    const dead = listDeliveries(db, { status: 'dead' });
    assert.equal(dead.length, 2);
    assert.ok(dead.every((r) => r.status === 'dead'));
    // combined filters narrow further
    insertDelivery(db, { outbox_id: 5, subscription_id: 'sub-b', status: 'dead' });
    assert.equal(listDeliveries(db, { subscription_id: 'sub-b', status: 'dead' }).length, 1);
  });

  it('returns rows newest-first (id DESC) with the mapped columns', () => {
    const { db } = setup();
    insertDelivery(db, { outbox_id: 1, subscription_id: 'sub-a' }); // id 1
    insertDelivery(db, { outbox_id: 2, subscription_id: 'sub-a' }); // id 2
    insertDelivery(db, { outbox_id: 3, subscription_id: 'sub-a' }); // id 3
    const rows = listDeliveries(db, {});
    assert.deepEqual(
      rows.map((r) => r.id),
      [3, 2, 1],
    );
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'attempts',
      'created_at',
      'id',
      'last_error',
      'last_status_code',
      'next_attempt_at',
      'outbox_id',
      'status',
      'subscription_id',
      'updated_at',
    ]);
  });

  it('defaults the limit to 100 and caps it at 500', () => {
    const { db } = setup();
    for (let i = 1; i <= 120; i++) insertDelivery(db, { outbox_id: i, subscription_id: 'sub-a' });
    // default caps the listing at 100
    assert.equal(listDeliveries(db, {}).length, 100);
    // an explicit limit under the max is honored
    assert.equal(listDeliveries(db, { limit: 10 }).length, 10);
    // an over-max limit is clamped to 500 (only 120 rows exist, so we assert the
    // clamp via a request larger than the row count would return everything)
    assert.equal(listDeliveries(db, { limit: 9999 }).length, 120);
    // seed past the cap to prove the 500 ceiling is enforced
    for (let i = 121; i <= 600; i++) insertDelivery(db, { outbox_id: i, subscription_id: 'sub-a' });
    assert.equal(listDeliveries(db, { limit: 9999 }).length, 500);
  });

  it('falls back to the default limit for a non-numeric limit (?limit=abc)', () => {
    const { db } = setup();
    for (let i = 1; i <= 120; i++) insertDelivery(db, { outbox_id: i, subscription_id: 'sub-a' });
    assert.equal(listDeliveries(db, { limit: Number('abc') }).length, 100);
  });
});

describe('sync_links (CRUD)', () => {
  it('creates and gets back the row (create→get round-trip)', () => {
    const { db, project } = setup();
    const link = createSyncLink(db, {
      project_id: project.id,
      local_id: 'card-1',
      provider: 'jira',
      external_id: 'JIRA-42',
    });
    assert.ok(link.id);
    assert.equal(link.provider, 'jira');
    assert.equal(link.local_id, 'card-1');
    assert.equal(link.external_id, 'JIRA-42');
    // sync bookkeeping starts null — the engine sets it later
    assert.equal(link.local_hash, null);
    assert.equal(link.remote_hash, null);
    assert.equal(link.last_synced_at, null);
    assert.equal(link.created_at, link.updated_at);
    const fetched = getSyncLink(db, link.id);
    assert.deepEqual(fetched, link);
    assert.equal(getSyncLink(db, 'missing'), null);
  });

  it('defaults project_id and external_id to null when omitted', () => {
    const { db } = setup();
    const link = createSyncLink(db, { local_id: 'card-2', provider: 'linear' });
    assert.equal(link.project_id, null);
    assert.equal(link.external_id, null);
  });

  it('getSyncLinkByLocal finds the link for a (provider, local_id) pair', () => {
    const { db, project } = setup();
    const jira = createSyncLink(db, { project_id: project.id, local_id: 'card-3', provider: 'jira' });
    createSyncLink(db, { project_id: project.id, local_id: 'card-3', provider: 'linear' });
    const found = getSyncLinkByLocal(db, 'jira', 'card-3');
    assert.equal(found!.id, jira.id);
    assert.equal(getSyncLinkByLocal(db, 'jira', 'nope'), null);
  });

  it('lists filtered by provider (oldest-first)', () => {
    const { db, project } = setup();
    const a = createSyncLink(db, { project_id: project.id, local_id: 'c-a', provider: 'jira' });
    createSyncLink(db, { project_id: project.id, local_id: 'c-b', provider: 'linear' });
    const c = createSyncLink(db, { project_id: project.id, local_id: 'c-c', provider: 'jira' });
    const jira = listSyncLinks(db, { provider: 'jira' });
    assert.deepEqual(
      jira.map((l) => l.id),
      [a.id, c.id],
    );
    assert.equal(listSyncLinks(db).length, 3); // no filter → all
    assert.equal(listSyncLinks(db, { provider: 'linear' }).length, 1);
  });

  it('lists filtered by project_id', () => {
    const { db, project } = setup();
    const other = getOrCreateProject(db, '/tmp/other-sync-app');
    createSyncLink(db, { project_id: project.id, local_id: 'm', provider: 'jira' });
    createSyncLink(db, { project_id: other.id, local_id: 't', provider: 'jira' });
    assert.equal(listSyncLinks(db, { project_id: project.id }).length, 1);
    assert.equal(listSyncLinks(db, { provider: 'jira', project_id: other.id }).length, 1);
  });

  it('updateSyncLink sets local_hash/last_synced_at and bumps updated_at', () => {
    const { db, project } = setup();
    const link = createSyncLink(db, { project_id: project.id, local_id: 'card-4', provider: 'jira' });
    const updated = updateSyncLink(db, link.id, {
      external_id: 'JIRA-99',
      local_hash: 'lh',
      remote_hash: 'rh',
      last_synced_at: 1234,
    });
    assert.equal(updated.external_id, 'JIRA-99');
    assert.equal(updated.local_hash, 'lh');
    assert.equal(updated.remote_hash, 'rh');
    assert.equal(updated.last_synced_at, 1234);
    assert.ok(updated.updated_at >= link.updated_at);
    assert.equal(updated.created_at, link.created_at); // created_at untouched
    // a partial patch leaves other fields as-is
    const again = updateSyncLink(db, link.id, { local_hash: 'lh2' });
    assert.equal(again.local_hash, 'lh2');
    assert.equal(again.external_id, 'JIRA-99'); // unchanged by this patch
    assert.throws(() => updateSyncLink(db, 'nope', { local_hash: 'x' }), /no such sync_link/);
  });

  it('UNIQUE(provider, local_id) rejects a duplicate', () => {
    const { db, project } = setup();
    createSyncLink(db, { project_id: project.id, local_id: 'dup', provider: 'jira' });
    assert.throws(
      () => createSyncLink(db, { project_id: project.id, local_id: 'dup', provider: 'jira' }),
      /UNIQUE/,
    );
    // same local_id under a different provider is allowed
    assert.ok(createSyncLink(db, { project_id: project.id, local_id: 'dup', provider: 'linear' }).id);
  });

  it('migrate() is idempotent (re-running keeps the table + rows)', () => {
    const { db, project } = setup();
    const link = createSyncLink(db, { project_id: project.id, local_id: 'card-5', provider: 'jira' });
    migrate(db); // re-run: CREATE TABLE IF NOT EXISTS is a no-op, row survives
    assert.deepEqual(getSyncLink(db, link.id), link);
  });
});

describe('sync_conflict attention', () => {
  // Wire a link into a synced state, then mutate the card + remote hash to
  // reach the requested state. `localHash` is the hash STORED on the link
  // (== the card's content at last sync); `remoteHash` is the stored remote.
  const link = (
    db: ReturnType<typeof openDb>,
    projectId: string,
    localId: string,
    patch: { local_hash?: string | null; remote_hash?: string | null; last_synced_at?: number | null },
  ) => {
    const l = createSyncLink(db, { project_id: projectId, local_id: localId, provider: 'jira' });
    return updateSyncLink(db, l.id, patch);
  };

  it('flags a divergent link (local moved, remote moved, disagree) as a blocker', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Both changed', { requirements: 'x' });
    const synced = taskContentHash(getTask(db, t.id)); // content at last sync
    link(db, project.id, t.id, { local_hash: synced, remote_hash: 'remote-moved', last_synced_at: 1000 });
    // local moves after sync → current hash != synced != remote
    updateTask(db, t.id, { requirements: 'y' });
    const item = getAttention(db, project.id).find((i) => i.kind === 'sync_conflict');
    assert.ok(item, 'expected a sync_conflict item');
    assert.equal(item!.severity, 'blocker');
    assert.equal(item!.card_id, t.id);
    assert.match(item!.reason, /Sync conflict with jira/);
  });

  it('does not flag a converged link (current local hash == remote hash)', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Converged', { requirements: 'x' });
    const synced = taskContentHash(getTask(db, t.id));
    updateTask(db, t.id, { requirements: 'agreed' });
    const current = taskContentHash(getTask(db, t.id));
    // remote landed on the SAME content the local moved to → no disagreement
    link(db, project.id, t.id, { local_hash: synced, remote_hash: current, last_synced_at: 1000 });
    assert.equal(getAttention(db, project.id).filter((i) => i.kind === 'sync_conflict').length, 0);
  });

  it('does not flag an unsynced link (local_hash / last_synced_at null)', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Never synced', { requirements: 'x' });
    // remote_hash set but no local_hash + no last_synced_at → never synced
    link(db, project.id, t.id, { remote_hash: 'remote-moved' });
    assert.equal(getAttention(db, project.id).filter((i) => i.kind === 'sync_conflict').length, 0);
  });

  it('does not flag a local-only change (remote unchanged)', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'Local only', { requirements: 'x' });
    const synced = taskContentHash(getTask(db, t.id));
    // remote never moved: remote_hash == local_hash
    link(db, project.id, t.id, { local_hash: synced, remote_hash: synced, last_synced_at: 1000 });
    updateTask(db, t.id, { requirements: 'y' }); // a normal local edit
    assert.equal(getAttention(db, project.id).filter((i) => i.kind === 'sync_conflict').length, 0);
  });

  // Build a genuinely conflicted link (local moved, remote moved, both disagree)
  // and return { t, conflicted }. Same recipe as the "flags a divergent link" test.
  const conflict = (db: ReturnType<typeof openDb>, projectId: string) => {
    const t = createTask(db, projectId, 'Both changed', { requirements: 'x' });
    const synced = taskContentHash(getTask(db, t.id)); // content at last sync
    const conflicted = link(db, projectId, t.id, {
      local_hash: synced,
      remote_hash: 'remote-moved',
      last_synced_at: 1000,
    });
    updateTask(db, t.id, { requirements: 'y' }); // local moves → current != synced != remote
    return { t, conflicted };
  };

  it("resolveSyncConflict 'local' clears the conflict (both hashes == current local)", () => {
    const { db, project } = setup();
    const { t, conflicted } = conflict(db, project.id);
    // precondition: it IS a conflict / Attention item before we resolve
    assert.equal(detectSyncConflicts(db, project.id).length, 1);
    assert.ok(getAttention(db, project.id).some((i) => i.kind === 'sync_conflict' && i.card_id === t.id));

    const updated = resolveSyncConflict(db, conflicted.id, 'local');
    const currentLocalHash = taskContentHash(getTask(db, t.id));
    assert.equal(updated.local_hash, currentLocalHash);
    assert.equal(updated.remote_hash, currentLocalHash); // both sides agree on local
    assert.ok(updated.last_synced_at != null);

    // no longer a conflict, and no sync_conflict Attention item for this card
    assert.equal(detectSyncConflicts(db, project.id).length, 0);
    assert.equal(
      getAttention(db, project.id).filter((i) => i.kind === 'sync_conflict' && i.card_id === t.id).length,
      0,
    );
  });

  it("resolveSyncConflict 'remote' clears the conflict (local_hash == remote_hash)", () => {
    const { db, project } = setup();
    const { t, conflicted } = conflict(db, project.id);
    assert.equal(detectSyncConflicts(db, project.id).length, 1);
    assert.ok(getAttention(db, project.id).some((i) => i.kind === 'sync_conflict' && i.card_id === t.id));

    const updated = resolveSyncConflict(db, conflicted.id, 'remote');
    assert.equal(updated.local_hash, conflicted.remote_hash); // == 'remote-moved'
    assert.equal(updated.local_hash, updated.remote_hash); // remote-moved divergence cleared
    assert.ok(updated.last_synced_at != null);

    assert.equal(detectSyncConflicts(db, project.id).length, 0);
    assert.equal(
      getAttention(db, project.id).filter((i) => i.kind === 'sync_conflict' && i.card_id === t.id).length,
      0,
    );
  });

  it('resolveSyncConflict throws on an unknown linkId', () => {
    const { db } = setup();
    assert.throws(() => resolveSyncConflict(db, 'nope', 'local'), /no such sync_link/);
  });
});

describe('cross-board depends_on', () => {
  function xbSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-xb-'));
    for (const sub of ['api', 'mobile']) mkdirSync(join(dir, sub));
    const db = openDb();
    const workspace = getOrCreateProject(db, dir, 'Shop');
    const a = createVertical(db, workspace.id, 'API', join(dir, 'api'));
    const b = createVertical(db, workspace.id, 'Mobile', join(dir, 'mobile'));
    const cleanup = () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { db, workspace, a, b, cleanup };
  }

  it('gates a card on vertical B while its dependency on vertical A is not done', (t) => {
    const { db, a, b, cleanup } = xbSetup();
    t.after(cleanup);
    const auth = createTask(db, a.id, 'API auth');
    createTask(db, b.id, 'Mobile login', { depends_on: [auth.id] });
    assert.equal(getNextCard(db, b.id), null);
    moveTask(db, auth.id, 'in_progress');
    assert.equal(getNextCard(db, b.id), null);
  });

  it('makes the B card next once its A dependency is done', (t) => {
    const { db, a, b, cleanup } = xbSetup();
    t.after(cleanup);
    const auth = createTask(db, a.id, 'API auth');
    const login = createTask(db, b.id, 'Mobile login', { depends_on: [auth.id] });
    assert.equal(getNextCard(db, b.id), null);
    moveTask(db, auth.id, 'done');
    assert.equal(getNextCard(db, b.id)!.id, login.id);
  });

  it('gating holds inside an active phase on B', (t) => {
    const { db, a, b, cleanup } = xbSetup();
    t.after(cleanup);
    const auth = createTask(db, a.id, 'API auth');
    const phase = createPhase(db, b.id, 'Login');
    const login = createTask(db, b.id, 'Mobile login', { depends_on: [auth.id], phase_id: phase.id });
    advancePhase(db, b.id); // phase active
    assert.equal(getActivePhase(db, b.id)!.id, phase.id);
    assert.equal(getNextCard(db, b.id), null);
    moveTask(db, auth.id, 'done');
    assert.equal(getNextCard(db, b.id)!.id, login.id);
  });

  it('a dependency id on no board blocks the card forever (never eligible)', (t) => {
    const { db, b, cleanup } = xbSetup();
    t.after(cleanup);
    const ghost = createTask(db, b.id, 'Waits on ghost', { depends_on: ['no-such-card'] });
    assert.equal(getNextCard(db, b.id), null);
    const free = createTask(db, b.id, 'Free');
    assert.equal(getNextCard(db, b.id)!.id, free.id);
    assert.equal(ghost.position < free.position, true);
  });

  it('deleting a card on A strips it from a B dependent so B becomes next', (t) => {
    const { db, a, b, cleanup } = xbSetup();
    t.after(cleanup);
    const auth = createTask(db, a.id, 'API auth');
    const login = createTask(db, b.id, 'Mobile login', { depends_on: [auth.id] });
    assert.equal(getNextCard(db, b.id), null);
    deleteTask(db, auth.id);
    assert.equal(getTask(db, login.id).depends_on, null);
    assert.equal(getNextCard(db, b.id)!.id, login.id);
  });

  it('deleteTask reports every changed dependent (all boards) in unblocked', (t) => {
    const { db, a, b, cleanup } = xbSetup();
    t.after(cleanup);
    const auth = createTask(db, a.id, 'API auth');
    const other = createTask(db, a.id, 'API other');
    const sameBoard = createTask(db, a.id, 'API tokens', { depends_on: [auth.id, other.id] });
    const login = createTask(db, b.id, 'Mobile login', { depends_on: [auth.id] });
    const unrelated = createTask(db, b.id, 'Mobile unrelated', { depends_on: [other.id] });
    const removed = deleteTask(db, auth.id);
    assert.deepEqual([...removed.unblocked].sort(), [sameBoard.id, login.id].sort());
    assert.equal(getTask(db, sameBoard.id).depends_on, JSON.stringify([other.id]));
    assert.equal(getTask(db, unrelated.id).depends_on, JSON.stringify([other.id]));
  });

  it('deleteTask never lists the deleted card itself in unblocked (self-dependency)', (t) => {
    const { db, a, b, cleanup } = xbSetup();
    t.after(cleanup);
    const self = createTask(db, a.id, 'API self');
    db.prepare('UPDATE tasks SET depends_on = ? WHERE id = ?').run(JSON.stringify([self.id]), self.id);
    const login = createTask(db, b.id, 'Mobile login', { depends_on: [self.id] });
    const removed = deleteTask(db, self.id);
    assert.deepEqual(removed.unblocked, [login.id]);
  });
});

describe('home view reads', () => {
  function home() {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-home-'));
    for (const sub of ['mobile', 'web']) mkdirSync(join(dir, sub));
    const db = openDb();
    const ws = getOrCreateProject(db, dir, 'Shop');
    const cleanup = () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    const verticals = () => ({
      mobile: createVertical(db, ws.id, 'Mobile', join(dir, 'mobile')),
      web: createVertical(db, ws.id, 'Web', join(dir, 'web')),
    });
    return { db, ws, verticals, cleanup };
  }

  it('up next: queued first, then pick order; waiting cards included with their deps', (t) => {
    const { db, ws, verticals, cleanup } = home();
    t.after(cleanup);
    const { mobile } = verticals();
    const other = createTask(db, mobile.id, 'Other board dep', { requirements: 'x' });
    const done = createTask(db, ws.id, 'Done dep');
    moveTask(db, done.id, 'done');
    const b1 = createTask(db, ws.id, 'Backlog 1', { tag: 'api' });
    const b2 = createTask(db, ws.id, 'Backlog 2 waits', { depends_on: [b1.id, other.id, 'ghost', done.id] });
    const q = createTask(db, ws.id, 'Queued', { tag: 'ui' });
    moveTask(db, q.id, 'queued');
    const b3 = createTask(db, ws.id, 'Backlog 3');

    const { items, total_pending } = getUpNext(db, mobile.id, 10); // vertical id → that board only
    assert.deepEqual(items.map((i) => i.id), [other.id]);
    assert.equal(total_pending, 1);

    // workspace id covers workspace + mobile + web: queued first, then round-robin backlog
    const single = getUpNext(db, ws.id, 3);
    assert.deepEqual(single.items.map((i) => i.id), [q.id, b1.id, other.id]);
    assert.equal(single.total_pending, 5); // q + b1 b2 b3 + other
    assert.deepEqual(single.items[0], {
      id: q.id,
      title: 'Queued',
      lane: 'queued',
      tag: 'ui',
      work_type: null,
      board: { id: ws.id, name: 'Shop' },
      ready: true,
      waiting_on: [],
    });

    const all = getUpNext(db, ws.id, 10).items;
    assert.deepEqual(all.map((i) => i.id), [q.id, b1.id, other.id, b2.id, b3.id]);
    const waiting = all.find((i) => i.id === b2.id)!;
    assert.equal(waiting.ready, false);
    assert.deepEqual(waiting.waiting_on, [
      { id: b1.id, title: 'Backlog 1', board_name: 'Shop' },
      { id: other.id, title: 'Other board dep', board_name: 'Mobile' }, // cross-board
      { id: 'ghost', title: null, board_name: null }, // unknown dep
    ]); // the done dep is not waited on
  });

  it('up next: pick order is phase-scoped; default n = 3', (t) => {
    const { db, ws, cleanup } = home();
    t.after(cleanup);
    const phase = createPhase(db, ws.id, 'P1');
    advancePhase(db, ws.id);
    createTask(db, ws.id, 'Unphased');
    const ids = [1, 2, 3, 4].map((i) => createTask(db, ws.id, `In phase ${i}`, { phase_id: phase.id }).id);
    const { items, total_pending } = getUpNext(db, ws.id);
    assert.deepEqual(items.map((i) => i.id), ids.slice(0, 3));
    assert.equal(total_pending, 4); // the out-of-phase card isn't pending pick
  });

  it('up next workspace merge: all queued (board order) first, then backlog round-robin', (t) => {
    const { db, ws, verticals, cleanup } = home();
    t.after(cleanup);
    const { mobile, web } = verticals();
    const wb1 = createTask(db, ws.id, 'ws b1');
    const wb2 = createTask(db, ws.id, 'ws b2');
    const mq = createTask(db, mobile.id, 'mobile q');
    moveTask(db, mq.id, 'queued');
    const mb1 = createTask(db, mobile.id, 'mobile b1');
    const webq = createTask(db, web.id, 'web q');
    moveTask(db, webq.id, 'queued');
    const wsq = createTask(db, ws.id, 'ws q');
    moveTask(db, wsq.id, 'queued');
    const webb1 = createTask(db, web.id, 'web b1');
    const webb2 = createTask(db, web.id, 'web b2');
    const { items, total_pending } = getUpNext(db, ws.id, 20);
    assert.deepEqual(
      items.map((i) => i.id),
      [wsq.id, mq.id, webq.id, wb1.id, mb1.id, webb1.id, wb2.id, webb2.id],
    );
    assert.equal(total_pending, 8);
    assert.deepEqual(items[1].board, { id: mobile.id, name: 'Mobile' });
    // every pending card with its board (Up next's "View all" highlight), in pick order
    assert.deepEqual(getUpNext(db, ws.id, 3).pending.map((p) => [p.id, p.board.id]), items.map((i) => [i.id, i.board.id]));
  });

  it('now building: in_progress then in_review, subtasks, next criterion, since, blocked; workspace-wide', (t) => {
    const { db, ws, verticals, cleanup } = home();
    t.after(cleanup);
    const { mobile } = verticals();
    const rev = createTask(db, ws.id, 'Reviewing');
    moveTask(db, rev.id, 'in_review');
    const a = createTask(db, mobile.id, 'Building');
    assignCard(db, a.id, 'Ada', '.trees/a', 'card/a');
    setSubtasks(db, a.id, ['one', 'two', 'three']);
    checkSubtask(db, a.id, 0);
    raiseBlocker(db, a.id, 'which db?');
    const b = createTask(db, ws.id, 'Plain');
    moveTask(db, b.id, 'in_progress');
    createTask(db, ws.id, 'Not active');
    // pin the move-into-lane times; the latest move into the current lane wins
    db.prepare(`UPDATE task_events SET created_at = 1000 WHERE task_id = ? AND type = 'move'`).run(a.id);
    moveTask(db, a.id, 'in_review');
    moveTask(db, a.id, 'in_progress');
    db.prepare(
      `UPDATE task_events SET created_at = 5000 WHERE id = (SELECT MAX(id) FROM task_events WHERE task_id = ? AND type = 'move')`,
    ).run(a.id);
    // no move event at all → falls back to updated_at
    db.prepare(`DELETE FROM task_events WHERE task_id = ? AND type = 'move'`).run(b.id);
    const bUpdated = getTask(db, b.id).updated_at;

    const items = getNowBuilding(db, ws.id);
    assert.deepEqual(items.map((i) => i.id), [b.id, a.id, rev.id]);
    assert.deepEqual(items[1], {
      id: a.id,
      title: 'Building',
      lane: 'in_progress',
      board: { id: mobile.id, name: 'Mobile' },
      agent: 'Ada',
      subtasks: { done: 1, total: 3 },
      next_criterion: 'two',
      since: 5000,
      blocked: true,
      work_type: null,
    });
    assert.equal(items[0].since, bUpdated);
    assert.deepEqual(items[0].subtasks, { done: 0, total: 0 });
    assert.equal(items[0].next_criterion, null);
    assert.equal(items[2].lane, 'in_review');
    // a vertical id covers just that board
    assert.deepEqual(getNowBuilding(db, mobile.id).map((i) => i.id), [a.id]);
  });

  it('agent board: every member, zeros included, workspace sums, lines desc then name', (t) => {
    const { db, ws, verticals, cleanup } = home();
    t.after(cleanup);
    const { mobile } = verticals();
    const ada = createTeamMember(db, 'Ada', { skill: 'frontend', color: '#f00' });
    createTeamMember(db, 'Zed');
    createTeamMember(db, 'Bob');
    const c1 = createTask(db, ws.id, 'c1');
    const c2 = createTask(db, mobile.id, 'c2');
    const run = (project_id: string, task_id: string, agent: string, lines_added: number, ms: number) =>
      recordActivity(db, { project_id, task_id, agent, tokens: 1, tokens_out: 1, lines_added, lines_removed: 2, ms });
    run(ws.id, c1.id, 'Ada', 10, 3_600_000);
    run(ws.id, c1.id, 'Ada', 5, 1_800_000);
    run(mobile.id, c2.id, 'Ada', 20, 360_000);
    run(mobile.id, c2.id, 'stranger', 999, 1); // not a team member → not listed

    const board = getAgentBoard(db, ws.id);
    assert.deepEqual(board.map((m) => m.name), ['Ada', 'Bob', 'Zed']);
    assert.deepEqual(board[0], {
      id: ada.id,
      name: 'Ada',
      skill: 'frontend',
      color: '#f00',
      avatar: null,
      lines_added: 35,
      lines_removed: 6,
      hours: 1.6,
      cards: 2,
    });
    assert.deepEqual(
      { lines_added: board[1].lines_added, lines_removed: board[1].lines_removed, hours: board[1].hours, cards: board[1].cards },
      { lines_added: 0, lines_removed: 0, hours: 0, cards: 0 },
    );
    const mobileOnly = getAgentBoard(db, mobile.id)[0];
    assert.equal(mobileOnly.lines_added, 20);
    assert.equal(mobileOnly.cards, 1);
    assert.equal(mobileOnly.hours, 0.1);
  });
});

describe('suggestCardPlacement', () => {
  const targets = [
    { key: 'web', folder: 'apps/web' },
    { key: 'mobile', folder: 'apps/mobile' },
    { key: 'hooks', folder: 'apps/webhooks' },
  ];

  function withEdits(db: ReturnType<typeof setup>['db'], projectId: string, title: string, files: string[], tool = 'Edit') {
    const card = createTask(db, projectId, title);
    for (const file of files) appendEvent(db, { project_id: projectId, task_id: card.id, type: 'tool', payload: { tool, file } });
    return card;
  }

  it('suggests by edited folders, ignoring Bash and bad payloads, over open cards only', (t) => {
    const { db, project } = setup();
    t.after(() => db.close());
    const p = project.id;
    const web = withEdits(db, p, 'Checkout', ['apps/web/checkout/a.ts', 'apps/web/checkout/b.ts', 'apps/web/checkout/a.ts']);
    appendEvent(db, { project_id: p, task_id: web.id, type: 'tool', payload: { tool: 'Bash', file: 'apps/mobile/x npm test' } });
    db.prepare(`INSERT INTO task_events (project_id, task_id, type, payload, created_at) VALUES (?, ?, 'tool', '{not json', 0)`).run(p, web.id);
    const mobile = withEdits(db, p, 'Push', ['apps/mobile/push.ts'], 'Write');
    const mixed = withEdits(db, p, 'Mixed', ['apps/web/1', 'apps/web/2', 'apps/web/3', 'apps/mobile/1', 'apps/mobile/2']);
    const bash = withEdits(db, p, 'Bash only', ['npm test'], 'Bash');
    const none = createTask(db, p, 'Untouched');
    const root = withEdits(db, p, 'Root', ['package.json', 'README.md', 'package-lock.json', 'apps/web/x.ts'], 'MultiEdit');
    const done = withEdits(db, p, 'Shipped', ['apps/web/done.ts']);
    moveTask(db, done.id, 'done');
    const inProgress = withEdits(db, p, 'Hooks', ['apps/webhooks/stripe.ts', 'apps/web/page.ts'], 'NotebookEdit');
    moveTask(db, inProgress.id, 'in_progress');

    const out = suggestCardPlacement(db, p, targets);
    const by = new Map(out.map((r) => [r.card.id, r]));
    assert.ok(!by.has(done.id));
    assert.deepEqual(
      out.map((r) => r.card.id),
      [web.id, mobile.id, mixed.id, bash.id, none.id, root.id, inProgress.id],
    );
    assert.deepEqual(by.get(web.id), {
      card: { id: web.id, title: 'Checkout', lane: 'backlog' },
      suggestion: 'web',
      confidence: 'strong',
      evidence: 'apps/web',
      files: 2,
    });
    assert.equal(by.get(mobile.id)!.suggestion, 'mobile');
    assert.equal(by.get(mobile.id)!.confidence, 'strong');
    assert.deepEqual(
      { s: by.get(mixed.id)!.suggestion, c: by.get(mixed.id)!.confidence, f: by.get(mixed.id)!.files },
      { s: 'web', c: 'mixed', f: 5 },
    );
    for (const id of [bash.id, none.id]) {
      const r = by.get(id)!;
      assert.deepEqual([r.suggestion, r.confidence, r.evidence, r.files], [null, 'none', 'no file history', 0]);
    }
    const r = by.get(root.id)!;
    assert.deepEqual([r.suggestion, r.confidence, r.evidence], [null, 'mixed', 'touches shared files (package.json)']);
    // segment-aware: apps/webhooks is not apps/web, so a 1/1 tie goes to the earlier target
    const h = by.get(inProgress.id)!;
    assert.deepEqual([h.suggestion, h.confidence, h.files], ['web', 'mixed', 2]);
    assert.equal(suggestCardPlacement(db, p, [targets[2], targets[0]]).find((x) => x.card.id === inProgress.id)!.suggestion, 'hooks');
  });

  it('matches the longest prefix, root target lowest, and truncated 80-char paths', (t) => {
    const { db, project } = setup();
    t.after(() => db.close());
    const p = project.id;
    const long = ('apps/web/' + 'deeply/nested/'.repeat(10)).slice(0, 80);
    assert.equal(long.length, 80);
    const card = withEdits(db, p, 'Long', [long, 'apps/web/checkout/pay.ts', 'package.json']);
    const out = suggestCardPlacement(db, p, [
      { key: 'root', folder: '' },
      { key: 'web', folder: 'apps/web' },
      { key: 'checkout', folder: 'apps/web/checkout' },
    ]);
    assert.equal(out[0].card.id, card.id);
    // long → web, pay.ts → checkout, package.json → root: 1/1/1 tie → earliest target
    assert.deepEqual([out[0].suggestion, out[0].confidence], ['root', 'mixed']);
    const [only] = suggestCardPlacement(db, p, [{ key: 'web', folder: 'apps/web' }]);
    assert.deepEqual([only.suggestion, only.evidence, only.files], ['web', 'apps/web', 3]);
    assert.equal(only.confidence, 'mixed'); // 2/3 < 75%
  });

  it('normalises target folders and ignores absolute paths', (t) => {
    const { db, project } = setup();
    t.after(() => db.close());
    const p = project.id;
    const card = withEdits(db, p, 'Scratch', [
      'apps/web/a.ts',
      '/private/tmp/scratch1.md',
      '/private/tmp/scratch2.md',
      '/Users/me/.claude/memory/x.md',
    ]);
    const [r] = suggestCardPlacement(db, p, [{ key: 'web', folder: 'apps/web/' }]);
    assert.equal(r.card.id, card.id);
    assert.deepEqual([r.suggestion, r.confidence, r.files], ['web', 'strong', 1]);
    assert.equal(suggestCardPlacement(db, p, [{ key: 'web', folder: './apps/web' }])[0].suggestion, 'web');
    withEdits(db, p, 'Root', ['package.json']);
    const out = suggestCardPlacement(db, p, [{ key: 'root', folder: '.' }]);
    assert.deepEqual(out.map((x) => x.suggestion), ['root', 'root']);
  });
});

describe('splitIntoVerticals', () => {
  function splitSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-split-'));
    for (const sub of ['mobile', 'web', 'api', 'infra']) mkdirSync(join(dir, sub));
    const db = openDb();
    const source = getOrCreateProject(db, dir, 'Shop');
    const cleanup = () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { db, dir, source, cleanup };
  }
  const count = (db: Database.Database, table: string, col: string, id: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id) as { n: number }).n;

  it('standalone → verticals; moved cards carry activity/events/sync links; stay + done remain', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const a = createTask(db, source.id, 'A');
    const b = createTask(db, source.id, 'B', { depends_on: [a.id] });
    const c = createTask(db, source.id, 'C');
    const stay = createTask(db, source.id, 'Stay');
    const done = createTask(db, source.id, 'Done');
    moveTask(db, done.id, 'done');
    recordActivity(db, { project_id: source.id, task_id: a.id, tokens: 5, tokens_out: 1, lines_added: 2, lines_removed: 0, ms: 10 });
    createSyncLink(db, { project_id: source.id, local_id: a.id, provider: 'github' });
    createSyncLink(db, { project_id: source.id, local_id: stay.id, provider: 'github' });

    const res = splitIntoVerticals(db, source.id, {
      targets: [
        { name: 'Mobile', root: join(dir, 'mobile') },
        { name: 'Web', root: join(dir, 'web') },
        { name: 'API', root: join(dir, 'api') },
      ],
      assignments: { [a.id]: 0, [b.id]: 1, [c.id]: 2, [stay.id]: 'stay' },
    });
    const [m, w, api] = res.verticals;
    assert.deepEqual(res.verticals.map((v) => v.name), ['Mobile', 'Web', 'API']);
    for (const v of res.verticals) assert.equal(v.parent_id, source.id);
    assert.deepEqual(getWorkspace(db, m.id).verticals.map((v) => v.id), [m.id, w.id, api.id]);
    assert.deepEqual(res.moved, { [a.id]: m.id, [b.id]: w.id, [c.id]: api.id });

    assert.equal(getTask(db, a.id).project_id, m.id);
    assert.equal(getTask(db, b.id).project_id, w.id);
    assert.equal(getTask(db, b.id).depends_on, JSON.stringify([a.id])); // untouched
    assert.equal(getTask(db, stay.id).project_id, source.id);
    assert.equal(getTask(db, done.id).project_id, source.id);

    assert.equal(count(db, 'card_activity', 'project_id', m.id), 1);
    assert.equal(count(db, 'card_activity', 'project_id', source.id), 0);
    const aEvents = db.prepare('SELECT DISTINCT project_id FROM task_events WHERE task_id = ?').all(a.id);
    assert.deepEqual(aEvents, [{ project_id: m.id }]);
    const doneEvents = db.prepare('SELECT DISTINCT project_id FROM task_events WHERE task_id = ?').all(done.id);
    assert.deepEqual(doneEvents, [{ project_id: source.id }]);
    assert.equal(getSyncLinkByLocal(db, 'github', a.id)?.project_id, m.id);
    assert.equal(getSyncLinkByLocal(db, 'github', stay.id)?.project_id, source.id);

    for (const p of [source, m, w, api]) {
      const ev = getRecentEvents(db, p.id, 50).find((e) => e.type === 'vertical_split');
      assert.deepEqual(JSON.parse(ev!.payload!), { targets: ['Mobile', 'Web', 'API'], moved: 3 });
    }
  });

  it('source is a vertical → targets become siblings under the same workspace', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const mobile = createVertical(db, source.id, 'Mobile', join(dir, 'mobile'));
    const x = createTask(db, mobile.id, 'X');
    const y = createTask(db, mobile.id, 'Y');
    const res = splitIntoVerticals(db, mobile.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [x.id]: 0, [y.id]: 'stay' },
    });
    assert.equal(res.verticals[0].parent_id, source.id);
    assert.deepEqual(listVerticals(db, source.id).map((v) => v.name), ['Mobile', 'Web']);
    assert.equal(getTask(db, x.id).project_id, res.verticals[0].id);
    assert.equal(getTask(db, y.id).project_id, mobile.id);
  });

  it('an in-flight moved card → SplitError listing it, and nothing changed', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const a = createTask(db, source.id, 'A');
    const busy = createTask(db, source.id, 'Busy');
    moveTask(db, busy.id, 'in_progress');
    const review = createTask(db, source.id, 'Review');
    moveTask(db, review.id, 'in_review');
    const snapshot = () => ({
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
      events: count(db, 'task_events', 'project_id', source.id),
      phases: db.prepare('SELECT * FROM phases').all(),
    });
    const before = snapshot();
    assert.throws(
      () =>
        splitIntoVerticals(db, source.id, {
          targets: [{ name: 'Web', root: join(dir, 'web') }],
          assignments: { [a.id]: 0, [busy.id]: 0, [review.id]: 0 },
        }),
      (err: unknown) =>
        err instanceof SplitError && err.cardIds.sort().join() === [busy.id, review.id].sort().join(),
    );
    assert.deepEqual(snapshot(), before);
    // an in-flight card that STAYS is fine
    splitIntoVerticals(db, source.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [a.id]: 0, [busy.id]: 'stay', [review.id]: 'stay' },
    });
    assert.equal(getTask(db, busy.id).project_id, source.id);
  });

  it('rolls back created verticals when a later step fails', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const a = createTask(db, source.id, 'A');
    const projects = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    assert.throws(() =>
      splitIntoVerticals(db, source.id, {
        targets: [
          { name: 'Web', root: join(dir, 'web') },
          { name: 'Nope', root: join(dir, 'nope') }, // not a directory → createVertical throws
        ],
        assignments: { [a.id]: 0 },
      }),
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n, projects);
    assert.equal(findProject(db, join(dir, 'web')), undefined);
    assert.equal(getTask(db, a.id).project_id, source.id);
  });

  it('missing assignment for an open card or an invalid index → SplitError', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const a = createTask(db, source.id, 'A');
    const b = createTask(db, source.id, 'B');
    const targets = [{ name: 'Web', root: join(dir, 'web') }];
    assert.throws(
      () => splitIntoVerticals(db, source.id, { targets, assignments: { [a.id]: 0 } }),
      (err: unknown) => err instanceof SplitError && err.cardIds.join() === b.id,
    );
    assert.throws(
      () => splitIntoVerticals(db, source.id, { targets, assignments: { [a.id]: 0, [b.id]: 1 } }),
      (err: unknown) => err instanceof SplitError && err.cardIds.join() === b.id,
    );
    assert.equal(listVerticals(db, source.id).length, 0);
  });

  it('phase copies: one per (phase, target); active only when target has none; done stays done', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const p1 = createPhase(db, source.id, 'P1', { goal: 'g1', plan: 'plan1' });
    const p2 = createPhase(db, source.id, 'P2', { goal: 'g2' });
    const p3 = createPhase(db, source.id, 'P3');
    advancePhase(db, source.id); // P1 active
    advancePhase(db, source.id); // P1 done, P2 active; P3 planned
    // the Web target is an adopted project that already has an active phase
    const webProj = getOrCreateProject(db, join(dir, 'web'), 'old-web');
    const own = createPhase(db, webProj.id, 'Own');
    advancePhase(db, webProj.id);

    const c1 = createTask(db, source.id, 'c1', { phase_id: p1.id });
    const c2 = createTask(db, source.id, 'c2', { phase_id: p2.id });
    const c2b = createTask(db, source.id, 'c2b', { phase_id: p2.id });
    const c3 = createTask(db, source.id, 'c3', { phase_id: p3.id });
    const w2 = createTask(db, source.id, 'w2', { phase_id: p2.id });
    const w3 = createTask(db, source.id, 'w3', { phase_id: p3.id });
    const res = splitIntoVerticals(db, source.id, {
      targets: [
        { name: 'Mobile', root: join(dir, 'mobile') },
        { name: 'Web', root: join(dir, 'web') },
      ],
      assignments: { [c1.id]: 0, [c2.id]: 0, [c2b.id]: 0, [c3.id]: 0, [w2.id]: 1, [w3.id]: 1 },
    });
    const [m, w] = res.verticals;
    assert.equal(w.id, webProj.id);

    const mPhases = db.prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position').all(m.id) as {
      id: string; title: string; goal: string | null; plan: string | null; status: string; position: number;
    }[];
    assert.deepEqual(
      mPhases.map((p) => [p.title, p.goal, p.plan, p.status, p.position]),
      [
        ['P1', 'g1', 'plan1', 'done', 1],
        ['P2', 'g2', null, 'active', 2],
        ['P3', null, null, 'planned', 3],
      ],
    );
    assert.equal(getTask(db, c2.id).phase_id, getTask(db, c2b.id).phase_id); // one copy shared
    assert.equal(getTask(db, c2.id).phase_id, mPhases[1].id);
    assert.equal(getTask(db, c1.id).phase_id, mPhases[0].id);

    const wPhases = db.prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position').all(w.id) as {
      id: string; title: string; status: string; position: number;
    }[];
    assert.deepEqual(
      wPhases.map((p) => [p.title, p.status, p.position]),
      [['Own', 'active', 1], ['P2', 'planned', 2], ['P3', 'planned', 3]],
    );
    assert.equal(getActivePhase(db, w.id)?.id, own.id);
    // source phases untouched
    assert.deepEqual(
      getPhases(db, source.id).map((p) => [p.id, p.status]),
      [[p1.id, 'done'], [p2.id, 'active'], [p3.id, 'planned']],
    );
  });

  it('cross-board depends_on survives the split: getNextCard gates until the other board\'s card is done', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const dep = createTask(db, source.id, 'Dep');
    const gated = createTask(db, source.id, 'Gated', { depends_on: [dep.id] });
    const res = splitIntoVerticals(db, source.id, {
      targets: [
        { name: 'A', root: join(dir, 'mobile') },
        { name: 'B', root: join(dir, 'web') },
      ],
      assignments: { [gated.id]: 0, [dep.id]: 1 },
    });
    const [a, b] = res.verticals;
    assert.equal(getNextCard(db, a.id), null);
    assert.equal(getNextCard(db, b.id)?.id, dep.id);
    moveTask(db, dep.id, 'done');
    assert.equal(getNextCard(db, a.id)?.id, gated.id);
  });

  it('phase copies follow SOURCE roadmap order, not card order', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const p1 = createPhase(db, source.id, 'P1');
    createPhase(db, source.id, 'P2');
    const p3 = createPhase(db, source.id, 'P3');
    const c3 = createTask(db, source.id, 'c3', { phase_id: p3.id }); // created first
    const c1 = createTask(db, source.id, 'c1', { phase_id: p1.id });
    const res = splitIntoVerticals(db, source.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [c3.id]: 0, [c1.id]: 0 },
    });
    const w = res.verticals[0];
    assert.deepEqual(getPhases(db, w.id).map((p) => [p.title, p.position]), [['P1', 1], ['P3', 2]]);
    assert.equal(advancePhase(db, w.id)?.title, 'P1');
    assert.equal(getNextCard(db, w.id)?.id, c1.id);
  });

  it('moved cards are positioned after an adopted target\'s existing cards, in source order', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const webProj = getOrCreateProject(db, join(dir, 'web'), 'old-web');
    const e1 = createTask(db, webProj.id, 'existing 1');
    const e2 = createTask(db, webProj.id, 'existing 2');
    const a = createTask(db, source.id, 'a');
    const b = createTask(db, source.id, 'b');
    const c = createTask(db, source.id, 'c');
    const res = splitIntoVerticals(db, source.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [a.id]: 0, [b.id]: 'stay', [c.id]: 0 },
    });
    const rows = db
      .prepare('SELECT id, position FROM tasks WHERE project_id = ? ORDER BY position')
      .all(res.verticals[0].id) as { id: string; position: number }[];
    assert.deepEqual(rows.map((r) => r.id), [e1.id, e2.id, a.id, c.id]);
    assert.equal(new Set(rows.map((r) => r.position)).size, rows.length); // no collisions
    assert.deepEqual(rows.map((r) => r.position), [1, 2, 3, 4]);
  });

  it('pending outbox rows follow a moved card; processed rows stay', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const a = createTask(db, source.id, 'a'); // 'create' outbox row
    db.prepare(`UPDATE outbox SET status = 'processed' WHERE task_id = ?`).run(a.id);
    moveTask(db, a.id, 'queued'); // 'move' outbox row, pending
    const res = splitIntoVerticals(db, source.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [a.id]: 0 },
    });
    const rows = db
      .prepare('SELECT type, status, project_id FROM outbox WHERE task_id = ? ORDER BY id')
      .all(a.id);
    assert.deepEqual(rows, [
      { type: 'create', status: 'processed', project_id: source.id },
      { type: 'move', status: 'pending', project_id: res.verticals[0].id },
    ]);
  });

  it('a failure after the card/history writes rolls everything back', (t) => {
    const { db, dir, source, cleanup } = splitSetup();
    t.after(cleanup);
    const p1 = createPhase(db, source.id, 'P1');
    advancePhase(db, source.id);
    const a = createTask(db, source.id, 'a', { phase_id: p1.id });
    const b = createTask(db, source.id, 'b');
    recordActivity(db, { project_id: source.id, task_id: a.id, tokens: 1, tokens_out: 1, lines_added: 1, lines_removed: 0, ms: 1 });
    createSyncLink(db, { project_id: source.id, local_id: a.id, provider: 'github' });
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON task_events WHEN NEW.type = 'vertical_split'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const snapshot = () =>
      Object.fromEntries(
        ['projects', 'tasks', 'card_activity', 'task_events', 'phases', 'sync_links', 'outbox'].map((tb) => [
          tb,
          db.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all(),
        ]),
      );
    const before = snapshot();
    assert.throws(
      () =>
        splitIntoVerticals(db, source.id, {
          targets: [
            { name: 'Mobile', root: join(dir, 'mobile') },
            { name: 'Web', root: join(dir, 'web') },
          ],
          assignments: { [a.id]: 0, [b.id]: 1 },
        }),
      /boom/,
    );
    assert.deepEqual(snapshot(), before);
  });
});

describe('placePhaselessCards', () => {
  it('no phases → 0; active phase wins, else first planned; all done → 0; open cards only; idempotent', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const project = getOrCreateProject(db, '/tmp/place-phaseless', 'P');
    const open = createTask(db, project.id, 'open');
    const done = createTask(db, project.id, 'done');
    moveTask(db, done.id, 'done');
    assert.equal(placePhaselessCards(db, project.id), 0); // no phases
    assert.equal(getTask(db, open.id).phase_id, null);

    const p1 = createPhase(db, project.id, 'One');
    const p2 = createPhase(db, project.id, 'Two');
    assert.equal(placePhaselessCards(db, project.id), 1); // only planned → first planned
    assert.equal(getTask(db, open.id).phase_id, p1.id);
    assert.equal(getTask(db, done.id).phase_id, null); // done untouched
    assert.equal(placePhaselessCards(db, project.id), 0); // idempotent

    advancePhase(db, project.id); // p1 active
    advancePhase(db, project.id); // p1 done, p2 active
    const later = createTask(db, project.id, 'later');
    assert.equal(placePhaselessCards(db, project.id), 1); // active wins over planned
    assert.equal(getTask(db, later.id).phase_id, p2.id);
    assert.equal(getTask(db, done.id).phase_id, null);

    advancePhase(db, project.id); // all done
    const orphan = createTask(db, project.id, 'orphan');
    assert.equal(placePhaselessCards(db, project.id), 0);
    assert.equal(getTask(db, orphan.id).phase_id, null);
  });
});

describe('splitIntoVerticals: no stranded phaseless cards', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-split-place-'));
    for (const sub of ['mobile', 'web']) mkdirSync(join(dir, sub));
    const db = openDb();
    const source = getOrCreateProject(db, dir, 'Shop');
    const cleanup = () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { db, dir, source, cleanup };
  }

  it('a phaseless card split onto an adopted target with an active phase joins it and is pickable', (t) => {
    const { db, dir, source, cleanup } = setup();
    t.after(cleanup);
    const webProj = getOrCreateProject(db, join(dir, 'web'), 'old-web');
    const own = createPhase(db, webProj.id, 'Own');
    advancePhase(db, webProj.id);
    const a = createTask(db, source.id, 'a');
    const res = splitIntoVerticals(db, source.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [a.id]: 0 },
    });
    assert.equal(res.verticals[0].id, webProj.id);
    assert.equal(getTask(db, a.id).phase_id, own.id);
    assert.equal(getNextCard(db, webProj.id)?.id, a.id);
  });

  it('a target receiving an ACTIVE phase copy: the phaseless card joins the copy; both pickable', (t) => {
    const { db, dir, source, cleanup } = setup();
    t.after(cleanup);
    const p1 = createPhase(db, source.id, 'P1');
    advancePhase(db, source.id); // P1 active
    const phased = createTask(db, source.id, 'phased', { phase_id: p1.id });
    const bare = createTask(db, source.id, 'bare');
    const res = splitIntoVerticals(db, source.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [phased.id]: 0, [bare.id]: 0 },
    });
    const w = res.verticals[0];
    const copy = getActivePhase(db, w.id)!;
    assert.equal(copy.title, 'P1');
    assert.equal(getTask(db, phased.id).phase_id, copy.id);
    assert.equal(getTask(db, bare.id).phase_id, copy.id);
    assert.equal(getNextCard(db, w.id)?.id, phased.id);
    moveTask(db, phased.id, 'done');
    assert.equal(getNextCard(db, w.id)?.id, bare.id);
  });

  it('a target receiving only PLANNED copies: phaseless cards (moved + pre-existing) join the first planned', (t) => {
    const { db, dir, source, cleanup } = setup();
    t.after(cleanup);
    const webProj = getOrCreateProject(db, join(dir, 'web'), 'old-web');
    const existing = createTask(db, webProj.id, 'existing'); // phaseless, already on the target
    const p1 = createPhase(db, source.id, 'P1');
    const p2 = createPhase(db, source.id, 'P2');
    const phased = createTask(db, source.id, 'phased', { phase_id: p2.id });
    const bare = createTask(db, source.id, 'bare');
    const other = createTask(db, source.id, 'other', { phase_id: p1.id });
    const res = splitIntoVerticals(db, source.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [phased.id]: 0, [bare.id]: 0, [other.id]: 'stay' },
    });
    const w = res.verticals[0];
    const [copy] = getPhases(db, w.id);
    assert.deepEqual([copy.title, copy.status], ['P2', 'planned']);
    for (const c of [phased, bare, existing]) assert.equal(getTask(db, c.id).phase_id, copy.id);
    advancePhase(db, w.id);
    const picked = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const next = getNextCard(db, w.id)!;
      picked.add(next.id);
      moveTask(db, next.id, 'done');
    }
    assert.deepEqual(picked, new Set([phased.id, bare.id, existing.id]));
  });
});

describe('mergeVerticals', () => {
  function mergeSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-merge-'));
    for (const sub of ['web', 'api', 'shared', 'other']) mkdirSync(join(dir, sub));
    const db = openDb();
    const ws = getOrCreateProject(db, dir, 'Shop');
    const web = createVertical(db, ws.id, 'Web', join(dir, 'web'));
    const api = createVertical(db, ws.id, 'API', join(dir, 'api'));
    const cleanup = () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { db, dir, ws, web, api, cleanup };
  }
  const count = (db: Database.Database, table: string, col: string, id: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id) as { n: number }).n;
  const snapshot = (db: Database.Database) =>
    Object.fromEntries(
      ['projects', 'tasks', 'card_activity', 'task_events', 'phases', 'sync_links', 'outbox', 'subscriptions'].map(
        (tb) => [tb, db.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all()],
      ),
    );

  it('moves cards (renumbered, no collisions), history, subscriptions and pending outbox; deletes from', (t) => {
    const { db, ws, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const i1 = createTask(db, web.id, 'i1');
    const i2 = createTask(db, web.id, 'i2');
    const f1 = createTask(db, api.id, 'f1');
    const f2 = createTask(db, api.id, 'f2');
    const f3 = createTask(db, api.id, 'f3');
    moveTask(db, f3.id, 'done');
    recordActivity(db, { project_id: api.id, task_id: f1.id, tokens: 5, tokens_out: 1, lines_added: 2, lines_removed: 0, ms: 10 });
    createSyncLink(db, { project_id: api.id, local_id: f1.id, provider: 'github' });
    const sub = createSubscription(db, {
      project_id: api.id,
      kind: 'webhook',
      event_filter: 'create',
      target: 'https://example.com/hook',
    });
    appendEvent(db, { project_id: api.id, type: 'note', payload: { n: 1 } }); // board-level event, no task
    db.prepare(`UPDATE outbox SET status = 'processed' WHERE task_id = ?`).run(f1.id);
    db.prepare(`UPDATE outbox SET status = NULL WHERE task_id = ? AND type = 'create'`).run(f2.id);

    const res = mergeVerticals(db, api.id, web.id, { phases: 'append' });
    assert.equal(res.id, web.id);
    assert.equal(res.name, 'Web');
    assert.equal(db.prepare('SELECT 1 FROM projects WHERE id = ?').get(api.id), undefined);
    assert.deepEqual(listVerticals(db, ws.id).map((v) => v.id), [web.id]);

    const rows = db
      .prepare('SELECT id, position FROM tasks WHERE project_id = ? ORDER BY position')
      .all(web.id) as { id: string; position: number }[];
    assert.deepEqual(rows.map((r) => r.id), [i1.id, i2.id, f1.id, f2.id, f3.id]);
    assert.deepEqual(rows.map((r) => r.position), [1, 2, 3, 4, 5]);

    assert.equal(count(db, 'card_activity', 'project_id', web.id), 1);
    assert.equal(count(db, 'task_events', 'project_id', api.id), 0);
    assert.ok(count(db, 'task_events', 'project_id', web.id) > 0);
    assert.equal(getSyncLinkByLocal(db, 'github', f1.id)?.project_id, web.id);
    assert.equal(getSubscription(db, sub.id)?.project_id, web.id);

    const f1Outbox = db.prepare('SELECT DISTINCT project_id FROM outbox WHERE task_id = ?').all(f1.id);
    assert.deepEqual(f1Outbox, [{ project_id: api.id }]); // processed stays
    const f2Outbox = db.prepare('SELECT type, status, project_id FROM outbox WHERE task_id = ? ORDER BY id').all(f2.id);
    assert.deepEqual(f2Outbox, [{ type: 'create', status: null, project_id: web.id }]);
    assert.equal(
      count(db, 'outbox', 'project_id', api.id),
      (db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'processed' AND project_id = ?`).get(api.id) as { n: number }).n,
    );

    for (const p of [web.id, ws.id]) {
      const ev = getRecentEvents(db, p, 50).find((e) => e.type === 'vertical_merge');
      assert.deepEqual(JSON.parse(ev!.payload!), { from: { id: api.id, name: 'API' }, into: web.id, moved: 3 });
    }
  });

  it('append: from phases follow into\'s in from\'s order; active → planned when into has one', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const own = createPhase(db, web.id, 'Own');
    advancePhase(db, web.id);
    const a1 = createPhase(db, api.id, 'A1');
    const a2 = createPhase(db, api.id, 'A2');
    const a3 = createPhase(db, api.id, 'A3');
    advancePhase(db, api.id);
    advancePhase(db, api.id); // A1 done, A2 active, A3 planned
    const c = createTask(db, api.id, 'c', { phase_id: a2.id });
    mergeVerticals(db, api.id, web.id, { phases: 'append' });
    assert.deepEqual(
      getPhases(db, web.id).map((p) => [p.id, p.status, p.position]),
      [[own.id, 'active', 1], [a1.id, 'done', 2], [a2.id, 'planned', 3], [a3.id, 'planned', 4]],
    );
    assert.equal(getActivePhase(db, web.id)?.id, own.id);
    assert.equal(getTask(db, c.id).phase_id, a2.id);
  });

  it('append: from\'s active phase stays active when into has none', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const a1 = createPhase(db, api.id, 'A1');
    advancePhase(db, api.id);
    mergeVerticals(db, api.id, web.id, { phases: 'append' });
    assert.equal(getActivePhase(db, web.id)?.id, a1.id);
  });

  it('fold: from cards get into\'s active phase and from phases are deleted', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const own = createPhase(db, web.id, 'Own');
    advancePhase(db, web.id);
    const a1 = createPhase(db, api.id, 'A1');
    const c = createTask(db, api.id, 'c', { phase_id: a1.id });
    const d = createTask(db, api.id, 'd');
    mergeVerticals(db, api.id, web.id, { phases: 'fold' });
    assert.equal(getTask(db, c.id).phase_id, own.id);
    assert.equal(getTask(db, d.id).phase_id, own.id);
    assert.equal(count(db, 'phases', 'id', a1.id), 0);
    assert.deepEqual(getPhases(db, web.id).map((p) => p.id), [own.id]);
  });

  it('fold into a board with only planned phases → open cards get the first planned phase; done cards null', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const p1 = createPhase(db, web.id, 'P1');
    createPhase(db, web.id, 'P2');
    const a1 = createPhase(db, api.id, 'A1');
    advancePhase(db, api.id);
    const c = createTask(db, api.id, 'c', { phase_id: a1.id });
    const done = createTask(db, api.id, 'done', { phase_id: a1.id });
    moveTask(db, done.id, 'done');
    mergeVerticals(db, api.id, web.id, { phases: 'fold' });
    assert.equal(getTask(db, c.id).phase_id, p1.id);
    assert.equal(getTask(db, done.id).phase_id, null);
    assert.equal(count(db, 'phases', 'project_id', api.id), 0);
    assert.equal(count(db, 'phases', 'project_id', web.id), 2);
    assert.equal(getNextCard(db, web.id)?.id, c.id);
    assert.equal(advancePhase(db, web.id)?.id, p1.id);
    assert.equal(getNextCard(db, web.id)?.id, c.id);
  });

  it('fold: done cards of from lose their phase, open cards join into\'s active phase', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const own = createPhase(db, web.id, 'Own');
    advancePhase(db, web.id);
    const a1 = createPhase(db, api.id, 'A1');
    const open = createTask(db, api.id, 'open', { phase_id: a1.id });
    const done = createTask(db, api.id, 'done', { phase_id: a1.id });
    moveTask(db, done.id, 'done');
    mergeVerticals(db, api.id, web.id, { phases: 'fold' });
    assert.equal(getTask(db, open.id).phase_id, own.id);
    assert.equal(getTask(db, done.id).phase_id, null);
  });

  it('fold into a board whose phases are all done → open cards stay phaseless', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    createPhase(db, web.id, 'P1');
    advancePhase(db, web.id);
    advancePhase(db, web.id); // P1 done, nothing left
    const c = createTask(db, api.id, 'c');
    mergeVerticals(db, api.id, web.id, { phases: 'fold' });
    assert.equal(getTask(db, c.id).phase_id, null);
    assert.equal(getNextCard(db, web.id)?.id, c.id);
  });

  it('append a flat from into a phased into → from\'s cards join into\'s active phase', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const own = createPhase(db, web.id, 'Own');
    advancePhase(db, web.id);
    const f = createTask(db, api.id, 'f');
    mergeVerticals(db, api.id, web.id, { phases: 'append' });
    assert.equal(getTask(db, f.id).phase_id, own.id);
    assert.equal(getNextCard(db, web.id)?.id, f.id);
  });

  it('append a phased from into a flat into → into\'s own phaseless backlog stays pickable', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const mine = createTask(db, web.id, 'mine');
    const oldDone = createTask(db, web.id, 'old done');
    moveTask(db, oldDone.id, 'done');
    const a1 = createPhase(db, api.id, 'A1');
    advancePhase(db, api.id);
    const f = createTask(db, api.id, 'f', { phase_id: a1.id });
    mergeVerticals(db, api.id, web.id, { phases: 'append' });
    assert.equal(getActivePhase(db, web.id)?.id, a1.id);
    assert.equal(getTask(db, mine.id).phase_id, a1.id);
    assert.equal(getTask(db, oldDone.id).phase_id, null); // done cards untouched
    assert.equal(getNextCard(db, web.id)?.id, mine.id);
    moveTask(db, mine.id, 'done');
    assert.equal(getNextCard(db, web.id)?.id, f.id);
  });

  it('a root nesting with another vertical\'s root → MergeError (segment-aware)', (t) => {
    const { db, dir, ws, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    for (const sub of ['apps', 'apps/admin', 'apps/admin/x', 'apps/web', 'apps/webhooks']) mkdirSync(join(dir, sub));
    createVertical(db, ws.id, 'Admin', join(dir, 'apps/admin'));
    createVertical(db, ws.id, 'Hooks', join(dir, 'apps/webhooks'));
    const before = snapshot(db);
    assert.throws(() => mergeVerticals(db, api.id, web.id, { phases: 'append', root: join(dir, 'apps') }), MergeError);
    assert.throws(
      () => mergeVerticals(db, api.id, web.id, { phases: 'append', root: join(dir, 'apps/admin/x') }),
      MergeError,
    );
    assert.deepEqual(snapshot(db), before);
    const r = mergeVerticals(db, api.id, web.id, { phases: 'append', root: join(dir, 'apps/web') });
    assert.equal(r.root_path, join(dir, 'apps/web'));
  });

  it('applies name and root, including taking from\'s own root', (t) => {
    const { db, dir, ws, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const r1 = mergeVerticals(db, api.id, web.id, { phases: 'append', name: 'Platform', root: join(dir, 'api') });
    assert.equal(r1.name, 'Platform');
    assert.equal(r1.root_path, join(dir, 'api'));
    assert.equal(findProject(db, join(dir, 'api'))?.id, web.id);
    // a shared parent folder, with a trailing slash normalized
    const other = createVertical(db, ws.id, 'Other', join(dir, 'other'));
    const r2 = mergeVerticals(db, other.id, web.id, { phases: 'append', root: join(dir, 'shared') + '/' });
    assert.equal(r2.root_path, join(dir, 'shared'));
    assert.equal(r2.name, 'Platform');
  });

  it('root equal to the workspace root or another project\'s root → MergeError, nothing changed', (t) => {
    const { db, dir, ws, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    createTask(db, api.id, 'c');
    const other = createVertical(db, ws.id, 'Other', join(dir, 'other'));
    const before = snapshot(db);
    assert.throws(() => mergeVerticals(db, api.id, web.id, { phases: 'append', root: dir }), MergeError);
    assert.throws(
      () => mergeVerticals(db, api.id, web.id, { phases: 'append', root: other.root_path }),
      MergeError,
    );
    assert.deepEqual(snapshot(db), before);
  });

  it('an in-flight card in either vertical → MergeError listing them, nothing changed', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    createTask(db, api.id, 'ok');
    const busy = createTask(db, api.id, 'busy');
    moveTask(db, busy.id, 'in_progress');
    const review = createTask(db, web.id, 'review');
    moveTask(db, review.id, 'in_review');
    const before = snapshot(db);
    assert.throws(
      () => mergeVerticals(db, api.id, web.id, { phases: 'append' }),
      (err: unknown) =>
        err instanceof MergeError && err.cardIds.sort().join() === [busy.id, review.id].sort().join(),
    );
    assert.deepEqual(snapshot(db), before);
  });

  it('same id, non-vertical, or different workspaces → MergeError', (t) => {
    const { db, dir, ws, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const dir2 = mkdtempSync(join(tmpdir(), 'kankan-merge2-'));
    mkdirSync(join(dir2, 'x'));
    t.after(() => rmSync(dir2, { recursive: true, force: true }));
    const ws2 = getOrCreateProject(db, dir2, 'Other WS');
    const x = createVertical(db, ws2.id, 'X', join(dir2, 'x'));
    const before = snapshot(db);
    assert.throws(() => mergeVerticals(db, web.id, web.id, { phases: 'append' }), MergeError);
    assert.throws(() => mergeVerticals(db, ws.id, web.id, { phases: 'append' }), MergeError);
    assert.throws(() => mergeVerticals(db, api.id, ws.id, { phases: 'append' }), MergeError);
    assert.throws(() => mergeVerticals(db, x.id, web.id, { phases: 'append' }), MergeError);
    assert.throws(() => mergeVerticals(db, api.id, 'nope', { phases: 'append' }), MergeError);
    assert.deepEqual(snapshot(db), before);
  });

  it('a failure after the data writes rolls everything back', (t) => {
    const { db, dir, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const a1 = createPhase(db, api.id, 'A1');
    advancePhase(db, api.id);
    const a = createTask(db, api.id, 'a', { phase_id: a1.id });
    recordActivity(db, { project_id: api.id, task_id: a.id, tokens: 1, tokens_out: 1, lines_added: 1, lines_removed: 0, ms: 1 });
    createSyncLink(db, { project_id: api.id, local_id: a.id, provider: 'github' });
    createSubscription(db, { project_id: api.id, kind: 'webhook', event_filter: 'create', target: 'https://example.com/h' });
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON task_events WHEN NEW.type = 'vertical_merge'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const before = snapshot(db);
    assert.throws(
      () => mergeVerticals(db, api.id, web.id, { phases: 'append', name: 'P', root: join(dir, 'api') }),
      /boom/,
    );
    assert.deepEqual(snapshot(db), before);
  });

  it('getNextCard on into sees the merged backlog', (t) => {
    const { db, web, api, cleanup } = mergeSetup();
    t.after(cleanup);
    const i1 = createTask(db, web.id, 'i1');
    moveTask(db, i1.id, 'done');
    const f1 = createTask(db, api.id, 'f1');
    const f2 = createTask(db, api.id, 'f2', { depends_on: [f1.id] });
    mergeVerticals(db, api.id, web.id, { phases: 'append' });
    assert.equal(getNextCard(db, web.id)?.id, f1.id);
    moveTask(db, f1.id, 'done');
    assert.equal(getNextCard(db, web.id)?.id, f2.id);
  });
});

describe('work_type', () => {
  it('round-trips on create and update; null clears it', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'A', { work_type: 'defect' });
    assert.equal(a.work_type, 'defect');
    assert.equal(getTask(db, a.id).work_type, 'defect');
    assert.equal(createTask(db, project.id, 'B').work_type, null);
    assert.equal(updateTask(db, a.id, { work_type: 'debt' }).work_type, 'debt');
    assert.equal(updateTask(db, a.id, { work_type: null }).work_type, null);
  });

  it('rejects invalid values with a clear error and writes nothing', () => {
    const { db, project } = setup();
    assert.throws(
      () => createTask(db, project.id, 'A', { work_type: 'chore' as never }),
      /invalid work_type: chore \(expected feature, defect, debt, risk or null\)/,
    );
    assert.equal(getBoard(db, project.id).length, 0);
    const b = createTask(db, project.id, 'B', { work_type: 'risk' });
    assert.throws(() => updateTask(db, b.id, { work_type: 'bug' }), /invalid work_type: bug/);
    assert.equal(getTask(db, b.id).work_type, 'risk');
  });

  it('is returned by board, attention, home and workspace card reads', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'A', { work_type: 'feature' });
    assert.equal(getBoard(db, project.id)[0].work_type, 'feature');
    assert.equal(getAttention(db, project.id)[0].work_type, 'feature'); // needs_spec
    assert.equal(getUpNext(db, project.id).items[0].work_type, 'feature');
    assert.equal(getWorkspaceCards(db, project.id).cards[0].work_type, 'feature');
    moveTask(db, a.id, 'in_progress');
    assert.equal(getActiveCards(db, project.id)[0].work_type, 'feature');
    assert.equal(getNowBuilding(db, project.id)[0].work_type, 'feature');
    assert.equal(getWorkspaceSummary(db, project.id).boards[0].active[0].work_type, 'feature');
  });
});

describe('workType filter', () => {
  it('filters cards by work type, and none = unclassified, across the shared card reads', () => {
    const { db, project } = setup();
    const feat = createTask(db, project.id, 'Feat', { work_type: 'feature' });
    const bug = createTask(db, project.id, 'Bug', { work_type: 'defect' });
    const plain = createTask(db, project.id, 'Plain');
    const ids = (f: CardFilter) => getWorkspaceCards(db, project.id, f).cards.map((c) => c.id).sort();
    assert.deepEqual(ids({}), [feat.id, bug.id, plain.id].sort());
    assert.deepEqual(ids({ workType: 'defect' }), [bug.id]);
    assert.deepEqual(ids({ workType: 'none' }), [plain.id]);
    assert.deepEqual(ids({ workType: 'debt' }), []);
    assert.deepEqual(getUpNext(db, project.id, 10, { workType: 'feature' }).items.map((i) => i.id), [feat.id]);
    assert.deepEqual(laneCounts(db, [project.id], { workType: 'none' }).get(project.id)!.backlog, 1);
    // attention (needs_spec on every card) follows the filter too
    assert.deepEqual(getWorkspaceSummary(db, project.id, { workType: 'defect' }).attention.map((i) => i.card_id), [bug.id]);
    assert.deepEqual(getWorkspaceSummary(db, project.id, { workType: 'none' }).attention.map((i) => i.card_id), [plain.id]);
    moveTask(db, bug.id, 'in_progress');
    moveTask(db, plain.id, 'in_progress');
    assert.deepEqual(getNowBuilding(db, project.id, { workType: 'none' }).map((i) => i.id), [plain.id]);
    assert.deepEqual(getWorkspaceSummary(db, project.id, { workType: 'defect' }).boards[0].active.map((c) => c.id), [bug.id]);
  });

  it('rejects an unknown work type filter', () => {
    const { db, project } = setup();
    assert.throws(() => getWorkspaceCards(db, project.id, { workType: 'chore' as never }), /invalid work_type: chore/);
  });
});

describe('phase_change and reassign events', () => {
  const eventsOf = (db: Database.Database, taskId: string, type: string) =>
    (
      db.prepare('SELECT payload FROM task_events WHERE task_id = ? AND type = ? ORDER BY id').all(taskId, type) as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload));

  it('updateTask: phase change logs {from, to}; same phase logs nothing', () => {
    const { db, project } = setup();
    const p1 = createPhase(db, project.id, 'P1');
    const p2 = createPhase(db, project.id, 'P2');
    const a = createTask(db, project.id, 'A', { phase_id: p1.id });
    updateTask(db, a.id, { phase_id: p2.id });
    updateTask(db, a.id, { phase_id: p2.id }); // no-op
    updateTask(db, a.id, { tag: 'x' }); // phase untouched
    updateTask(db, a.id, { phase_id: null });
    assert.deepEqual(eventsOf(db, a.id, 'phase_change'), [
      { from: p1.id, to: p2.id },
      { from: p2.id, to: null },
    ]);
    // the event is in the outbox too (appendEvent tees)
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE task_id = ? AND type = 'phase_change'`).get(a.id) as { n: number }).n;
    assert.equal(n, 2);
  });

  it('updateTask phase_id: only a phase on the card\'s own board, or null', () => {
    const { db, project } = setup();
    const other = getOrCreateProject(db, '/tmp/other-board', 'Other');
    const mine = createPhase(db, project.id, 'Mine');
    const theirs = createPhase(db, other.id, 'Theirs');
    const a = createTask(db, project.id, 'A', { phase_id: mine.id });
    assert.throws(() => updateTask(db, a.id, { phase_id: theirs.id }), /invalid phase_id: phase .* belongs to another board/);
    assert.throws(() => updateTask(db, a.id, { phase_id: 'nope' }), /invalid phase_id: no such phase: nope/);
    assert.throws(() => updateTask(db, a.id, { phase_id: 42 as never }), /invalid phase_id: expected a phase id string or null/);
    assert.throws(() => updateTask(db, a.id, { phase_id: [mine.id] }), /invalid phase_id: expected/);
    assert.equal(getTask(db, a.id).phase_id, mine.id);
    assert.deepEqual(eventsOf(db, a.id, 'phase_change'), []);
    assert.equal(updateTask(db, a.id, { phase_id: null }).phase_id, null);
    assert.deepEqual(eventsOf(db, a.id, 'phase_change'), [{ from: mine.id, to: null }]);
  });

  it('placePhaselessCards: one event per placed card, none on a rerun', () => {
    const { db, project } = setup();
    const ph = createPhase(db, project.id, 'P');
    advancePhase(db, project.id);
    const a = createTask(db, project.id, 'A');
    const b = createTask(db, project.id, 'B');
    const done = createTask(db, project.id, 'Done');
    moveTask(db, done.id, 'done');
    const inPhase = createTask(db, project.id, 'In', { phase_id: ph.id });
    assert.equal(placePhaselessCards(db, project.id), 2);
    assert.equal(placePhaselessCards(db, project.id), 0);
    for (const c of [a, b]) assert.deepEqual(eventsOf(db, c.id, 'phase_change'), [{ from: null, to: ph.id }]);
    assert.deepEqual(eventsOf(db, done.id, 'phase_change'), []);
    assert.deepEqual(eventsOf(db, inPhase.id, 'phase_change'), []);
  });

  it('splitIntoVerticals: a moved card logs its phase → the copy, once', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-pc-split-'));
    mkdirSync(join(dir, 'web'));
    const db = openDb();
    t.after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const source = getOrCreateProject(db, dir, 'Shop');
    const ph = createPhase(db, source.id, 'P');
    advancePhase(db, source.id);
    const a = createTask(db, source.id, 'A', { phase_id: ph.id });
    const stay = createTask(db, source.id, 'Stay', { phase_id: ph.id });
    const res = splitIntoVerticals(db, source.id, {
      targets: [{ name: 'Web', root: join(dir, 'web') }],
      assignments: { [a.id]: 0, [stay.id]: 'stay' },
    });
    const copy = getTask(db, a.id).phase_id;
    assert.notEqual(copy, ph.id);
    assert.deepEqual(eventsOf(db, a.id, 'phase_change'), [{ from: ph.id, to: copy }]);
    const ev = db.prepare(`SELECT project_id FROM task_events WHERE task_id = ? AND type = 'phase_change'`).get(a.id) as {
      project_id: string;
    };
    assert.equal(ev.project_id, res.verticals[0].id);
    assert.deepEqual(eventsOf(db, stay.id, 'phase_change'), []);
  });

  it('mergeVerticals fold: open cards → into\'s phase, done cards → null (deleted phase), one event each', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-pc-merge-'));
    for (const sub of ['web', 'api']) mkdirSync(join(dir, sub));
    const db = openDb();
    t.after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const ws = getOrCreateProject(db, dir, 'Shop');
    const web = createVertical(db, ws.id, 'Web', join(dir, 'web'));
    const api = createVertical(db, ws.id, 'API', join(dir, 'api'));
    const p1 = createPhase(db, web.id, 'P1'); // planned only: placement's home
    const a1 = createPhase(db, api.id, 'A1');
    const open = createTask(db, api.id, 'open', { phase_id: a1.id });
    const loose = createTask(db, api.id, 'loose');
    const done = createTask(db, api.id, 'done', { phase_id: a1.id });
    moveTask(db, done.id, 'done');
    const doneLoose = createTask(db, api.id, 'done loose');
    moveTask(db, doneLoose.id, 'done');
    mergeVerticals(db, api.id, web.id, { phases: 'fold' });
    assert.deepEqual(eventsOf(db, open.id, 'phase_change'), [{ from: a1.id, to: p1.id }]);
    assert.deepEqual(eventsOf(db, loose.id, 'phase_change'), [{ from: null, to: p1.id }]);
    assert.deepEqual(eventsOf(db, done.id, 'phase_change'), [{ from: a1.id, to: null }]);
    assert.deepEqual(eventsOf(db, doneLoose.id, 'phase_change'), []);
    const onInto = (db.prepare(`SELECT COUNT(*) AS n FROM task_events WHERE type = 'phase_change' AND project_id = ?`).get(web.id) as { n: number }).n;
    assert.equal(onInto, 3);
  });

  it('mergeVerticals append: phases move with their cards, no phase_change', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-pc-append-'));
    for (const sub of ['web', 'api']) mkdirSync(join(dir, sub));
    const db = openDb();
    t.after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const ws = getOrCreateProject(db, dir, 'Shop');
    const web = createVertical(db, ws.id, 'Web', join(dir, 'web'));
    const api = createVertical(db, ws.id, 'API', join(dir, 'api'));
    const a1 = createPhase(db, api.id, 'A1');
    const c = createTask(db, api.id, 'c', { phase_id: a1.id });
    mergeVerticals(db, api.id, web.id, { phases: 'append' });
    assert.deepEqual(eventsOf(db, c.id, 'phase_change'), []);
  });

  it('reassign: only when an assignee changes to another one', () => {
    const { db, project } = setup();
    const a = createTask(db, project.id, 'A');
    assignCard(db, a.id, 'Ada', '.trees/a', 'card/a'); // first assignment: assign only
    assert.deepEqual(eventsOf(db, a.id, 'reassign'), []);
    assignCard(db, a.id, 'Ada', '.trees/a', 'card/a'); // same agent: no-op
    assert.deepEqual(eventsOf(db, a.id, 'reassign'), []);
    assignCard(db, a.id, 'Bob', '.trees/a', 'card/a');
    updateTask(db, a.id, { assigned_agent: 'Cy' });
    assert.deepEqual(eventsOf(db, a.id, 'reassign'), [
      { from: 'Ada', to: 'Bob' },
      { from: 'Bob', to: 'Cy' },
    ]);
    assert.equal(eventsOf(db, a.id, 'assign').length, 3);
    // a redirect clears the assignee; the next assignment is a first one again
    redirectTask(db, a.id);
    assignCard(db, a.id, 'Dee', '.trees/a', 'card/a');
    assert.equal(eventsOf(db, a.id, 'reassign').length, 2);
  });
});
