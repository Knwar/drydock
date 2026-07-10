import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  advancePhase,
  appendEvent,
  assignCard,
  cardTotals,
  checkSubtask,
  createPhase,
  createSubscription,
  createSyncLink,
  createTask,
  createTeamMember,
  deleteSubscription,
  deleteTask,
  deleteTeamMember,
  detectSyncConflicts,
  getSyncLink,
  getSyncLinkByLocal,
  getTask,
  getActiveCards,
  getActivePhase,
  getAttention,
  getBoard,
  getNextCard,
  getNextPhase,
  getOrCreateProject,
  getPhase,
  getPhases,
  getRecentEvents,
  getStats,
  getSubscription,
  getSubscriptionSecret,
  listDeliveries,
  listSubscriptions,
  listSyncLinks,
  listTeam,
  moveTask,
  raiseBlocker,
  recordActivity,
  recordReview,
  redirectTask,
  resolveBlocker,
  resolveSyncConflict,
  setSubtasks,
  subscriptionMatches,
  taskContentHash,
  updateSubscription,
  updateSyncLink,
  updateTask,
  updateTeamMember,
} from './board.js';
import { migrate, openDb } from './db.js';
import type { TaskEvent } from './types.js';

function setup() {
  const db = openDb();
  const project = getOrCreateProject(db, '/tmp/demo-app', 'Demo App');
  return { db, project };
}

describe('projects', () => {
  it('get_or_create is idempotent on root_path', () => {
    const { db, project } = setup();
    const again = getOrCreateProject(db, '/tmp/demo-app');
    assert.equal(again.id, project.id);
    assert.equal(again.name, 'Demo App');
  });

  it('derives name from path when omitted', () => {
    const { db } = setup();
    const p = getOrCreateProject(db, '/tmp/other-app');
    assert.equal(p.name, 'other-app');
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
    assert.deepEqual(Object.keys(card).sort(), ['agent', 'blocked', 'blocked_reason', 'id', 'lane', 'phase_id', 'rounds', 'skill', 'subs', 'tag', 'title', 'updated_at']);
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
    assert.equal(getBoard(db, project.id)[0].phase_id, p1.id);
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
    const global = createSubscription(db, { project_id: null, kind: 'webhook', event_filter: '*', target: 'g' });
    const mine = createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: '*', target: 'm' });
    const theirs = createSubscription(db, { project_id: other.id, kind: 'webhook', event_filter: '*', target: 't' });

    const scoped = listSubscriptions(db, project.id).map((s) => s.id).sort();
    assert.deepEqual(scoped, [global.id, mine.id].sort()); // mine + global, not theirs
    assert.equal(listSubscriptions(db).length, 3); // omitted project → all
    assert.equal(getSubscription(db, 'missing'), null);
  });

  it('update toggles enabled and returns the redacted view', () => {
    const { db, project } = setup();
    const sub = createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: '*', target: 'x', secret: 'k' });
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
    const sub = createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: '*', target: 'x' });
    assert.equal(deleteSubscription(db, sub.id), true);
    assert.equal(getSubscription(db, sub.id), null);
    assert.equal(deleteSubscription(db, sub.id), false); // already gone
  });

  it('validation throws on bad kind and on a bogus event_filter token', () => {
    const { db, project } = setup();
    assert.throws(
      () => createSubscription(db, { project_id: project.id, kind: 'email' as never, event_filter: '*', target: 'x' }),
      /invalid subscription kind/,
    );
    assert.throws(
      () => createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: 'create,bogus', target: 'x' }),
      /invalid event_filter token/,
    );
    // a real EventType list is accepted
    assert.ok(createSubscription(db, { project_id: project.id, kind: 'webhook', event_filter: 'create,move,phase_done', target: 'x' }).id);
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
