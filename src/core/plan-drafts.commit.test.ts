import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createPhase,
  createTask,
  createVertical,
  deleteTask,
  getOrCreateProject,
  getTask,
  moveTask,
  raiseBlocker,
  updateTask,
} from './board.js';
import { openDb } from './db.js';
import {
  DraftConflict,
  DraftError,
  applyDraftOps,
  commitDraft,
  createDraft,
  diffDraft,
  getDraft,
  runDraft,
} from './plan-drafts.js';
import type { DraftOp, Phase, PlanNode, Project, Subtask, Task } from './types.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kankan-commit-'));
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  const db = openDb();
  const ws = getOrCreateProject(db, dir, 'Shop');
  const web = createVertical(db, ws.id, 'web', join(dir, 'apps', 'web'));
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, ws, web, cleanup };
}

type DB = ReturnType<typeof openDb>;

const phasesOf = (db: DB, boardId: string) =>
  db.prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position').all(boardId) as Phase[];
const tasksOf = (db: DB, boardId: string) =>
  db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position').all(boardId) as Task[];
const deps = (t: Task) => (t.depends_on ? (JSON.parse(t.depends_on) as string[]) : []);
const subs = (t: Task) => (t.subtasks ? (JSON.parse(t.subtasks) as Subtask[]) : []);
const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A draft on ws: a (ws, Foundation) → b (web, Foundation) → c (web, Build). */
function seed(db: DB, ws: Project, web: Project, extra: Partial<Record<'a' | 'b' | 'c', Partial<PlanNode>>> = {}) {
  const nodes: PlanNode[] = [
    { id: 'a', title: 'API contract', board_id: ws.id, phase: 'Foundation', requirements: 'spec a', subtasks: ['a1'], ...extra.a },
    { id: 'b', title: 'Web client', board_id: web.id, phase: 'Foundation', requirements: 'spec b', subtasks: ['b1', 'b2'], ...extra.b },
    { id: 'c', title: 'Web page', board_id: web.id, phase: 'Build', ...extra.c },
  ];
  return createDraft(db, ws.id, 'Launch', {
    nodes,
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  });
}

const edit = (db: DB, id: string, ops: DraftOp[]) => applyDraftOps(db, id, ops);

describe('diffDraft / commitDraft', () => {
  it('first commit: phases by name (reused + appended), cards and cross-board depends_on', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const existing = createPhase(db, web.id, 'Foundation');
    const d = seed(db, ws, web);

    const diff = diffDraft(db, d.id);
    assert.deepEqual(diff.errors, []);
    assert.deepEqual(
      diff.boards.map((b) => [b.board_id, b.phases, b.create.map((c) => c.node_id)]),
      [
        [ws.id, [{ name: 'Foundation', position: 1 }], ['a']],
        [web.id, [{ name: 'Build', position: 2 }], ['b', 'c']],
      ],
    );
    assert.equal(count(db, 'tasks'), 0, 'diff is a dry run');

    const r = commitDraft(db, d.id, 1);
    assert.deepEqual(r.diff, diff);
    const { committed } = r.draft.data;
    assert.deepEqual(Object.keys(committed).sort(), ['a', 'b', 'c']);
    const [a, b, c] = ['a', 'b', 'c'].map((n) => getTask(db, committed[n]));
    assert.equal(a.project_id, ws.id);
    assert.equal(b.project_id, web.id);
    assert.equal(c.project_id, web.id);
    assert.deepEqual(deps(b), [a.id], 'cross-board dependency');
    assert.deepEqual(deps(c), [b.id]);
    assert.deepEqual(deps(a), []);
    assert.equal(b.requirements, 'spec b');
    assert.deepEqual(subs(b), [
      { text: 'b1', done: false },
      { text: 'b2', done: false },
    ]);
    assert.equal(c.requirements, null);

    const webPhases = phasesOf(db, web.id);
    assert.deepEqual(webPhases.map((p) => [p.title, p.position]), [
      ['Foundation', 1],
      ['Build', 2],
    ]);
    assert.equal(b.phase_id, existing.id, 'phase reused by name');
    assert.equal(c.phase_id, webPhases[1].id);
    assert.equal(a.phase_id, phasesOf(db, ws.id)[0].id);

    const stored = getDraft(db, d.id)!;
    assert.equal(stored.committed_version, 1);
    assert.ok(stored.committed_at);
    assert.deepEqual(stored.data.committed, committed);
    assert.deepEqual(r.boards.sort(), [ws.id, web.id].sort());
    assert.equal(r.touched.length, 3);
  });

  it('re-commit updates the same cards (no duplicates); an unchanged re-commit is a no-op', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    const first = commitDraft(db, d.id, 1).draft.data.committed;
    db.prepare('UPDATE tasks SET subtasks = ? WHERE id = ?').run(
      JSON.stringify([
        { text: 'b1', done: true },
        { text: 'b2', done: true },
      ]),
      first.b,
    );

    edit(db, d.id, [
      { op: 'update_node', id: 'b', patch: { title: 'Web client v2', subtasks: ['b1', 'b3'], tag: 'ui' } },
      { op: 'add_node', node: { id: 'd', title: 'Docs', board_id: ws.id } },
      { op: 'add_edge', from: 'a', to: 'd' },
    ]);
    const diff = diffDraft(db, d.id);
    const webDiff = diff.boards.find((b) => b.board_id === web.id)!;
    assert.deepEqual(webDiff.update.map((u) => [u.node_id, Object.keys(u.changes).sort()]), [
      ['b', ['subtasks', 'tag', 'title']],
    ]);
    assert.deepEqual(diff.boards.find((b) => b.board_id === ws.id)!.create.map((c) => c.node_id), ['d']);

    const tasksBefore = count(db, 'tasks');
    const r = commitDraft(db, d.id, 2);
    const second = r.draft.data.committed;
    for (const n of ['a', 'b', 'c']) assert.equal(second[n], first[n], `node ${n} keeps its card`);
    assert.equal(count(db, 'tasks'), tasksBefore + 1);
    const b = getTask(db, first.b);
    assert.equal(b.title, 'Web client v2');
    assert.equal(b.tag, 'ui');
    assert.deepEqual(subs(b), [
      { text: 'b1', done: true },
      { text: 'b3', done: false },
    ], 'done preserved for surviving texts');
    assert.deepEqual(deps(getTask(db, second.d)), [first.a]);

    // nothing changed → empty diff, nothing written
    const events = count(db, 'task_events');
    const phases = count(db, 'phases');
    assert.deepEqual(diffDraft(db, d.id).boards, []);
    const again = commitDraft(db, d.id, 2);
    assert.deepEqual(again.touched, []);
    assert.deepEqual(again.draft.data.committed, second);
    assert.equal(count(db, 'tasks'), tasksBefore + 1);
    assert.equal(count(db, 'phases'), phases);
    assert.equal(count(db, 'task_events'), events);
  });

  it('removing a backlog node deletes its card; removing a started node keeps it and reports it', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    moveTask(db, committed.a, 'in_progress');

    edit(db, d.id, [
      { op: 'remove_node', id: 'a' },
      { op: 'remove_node', id: 'c' },
    ]);
    const diff = diffDraft(db, d.id);
    const wsDiff = diff.boards.find((b) => b.board_id === ws.id)!;
    const webDiff = diff.boards.find((b) => b.board_id === web.id)!;
    assert.deepEqual(wsDiff.kept, [
      { node_id: 'a', card_id: committed.a, title: 'API contract', lane: 'in_progress', note: 'kept, no longer in plan', reason: 'started' },
    ]);
    assert.deepEqual(webDiff.delete, [{ node_id: 'c', card_id: committed.c, title: 'Web page' }]);
    // b lost its in-plan dependency on a
    assert.deepEqual(webDiff.update.map((u) => [u.node_id, u.changes]), [
      ['b', { depends_on: { from: ['a'], to: [] } }],
    ]);

    const r = commitDraft(db, d.id, 2);
    assert.deepEqual(r.deleted.map((x) => x.id), [committed.c]);
    assert.throws(() => getTask(db, committed.c));
    assert.equal(getTask(db, committed.a).lane, 'in_progress', 'started card kept');
    assert.deepEqual(r.draft.data.committed, { b: committed.b });
    assert.deepEqual(deps(getTask(db, committed.b)), []);
  });

  it('a started card whose node was edited is locked (not updated)', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    moveTask(db, committed.b, 'done');
    edit(db, d.id, [{ op: 'update_node', id: 'b', patch: { title: 'Renamed', board_id: ws.id } }]);

    const diff = diffDraft(db, d.id);
    assert.deepEqual(diff.boards.map((b) => [b.board_id, b.locked, b.update]), [
      [web.id, [{ node_id: 'b', card_id: committed.b, title: 'Web client', lane: 'done', fields: ['title', 'board'], reason: 'started' }], []],
    ]);
    commitDraft(db, d.id, 2);
    const b = getTask(db, committed.b);
    assert.equal(b.title, 'Web client');
    assert.equal(b.project_id, web.id);
    assert.equal(getDraft(db, d.id)!.data.committed.b, committed.b);
  });

  it('a blocked backlog card is locked (not edited or moved) and kept when removed (not deleted)', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    raiseBlocker(db, committed.b, 'which API?');
    raiseBlocker(db, committed.c, 'unclear');
    edit(db, d.id, [
      { op: 'update_node', id: 'b', patch: { title: 'Renamed', board_id: ws.id, phase: 'Later' } },
      { op: 'remove_node', id: 'c' },
    ]);

    const diff = diffDraft(db, d.id);
    assert.deepEqual(diff.boards.map((b) => [b.board_id, b.phases, b.update, b.delete, b.kept, b.locked]), [
      [
        web.id,
        [],
        [],
        [],
        [{ node_id: 'c', card_id: committed.c, title: 'Web page', lane: 'backlog', note: 'kept, no longer in plan', reason: 'blocked' }],
        [
          { node_id: 'b', card_id: committed.b, title: 'Web client', lane: 'backlog', fields: ['title', 'phase', 'board'], reason: 'blocked' },
        ],
      ],
    ]);

    const phases = count(db, 'phases');
    const r = commitDraft(db, d.id, 2);
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.moved, []);
    assert.deepEqual(r.touched, []);
    assert.equal(count(db, 'phases'), phases, 'no phase created for a locked card');
    const b = getTask(db, committed.b);
    assert.equal(b.title, 'Web client');
    assert.equal(b.project_id, web.id);
    assert.equal(getTask(db, committed.c).title, 'Web page', 'blocked card not deleted');
    assert.deepEqual(r.draft.data.committed, { a: committed.a, b: committed.b });
  });

  it('matches phase names trimmed on both sides (no duplicate phase)', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const padded = createPhase(db, web.id, 'Checkout ');
    const d = seed(db, ws, web, { b: { phase: 'Checkout' }, c: { phase: '  Checkout' } });
    const diff = diffDraft(db, d.id);
    assert.deepEqual(diff.boards.find((b) => b.board_id === web.id)!.phases, []);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    assert.deepEqual(phasesOf(db, web.id).map((p) => p.id), [padded.id]);
    assert.equal(getTask(db, committed.b).phase_id, padded.id);
    assert.equal(getTask(db, committed.c).phase_id, padded.id);
    assert.deepEqual(diffDraft(db, d.id).boards, [], 'a padded existing title is not a phase change');
  });

  it('preserves depends_on entries that point outside the plan', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const outside = createTask(db, web.id, 'Outside');
    const d = seed(db, ws, web);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    updateTask(db, committed.b, { depends_on: [committed.a, outside.id] });
    assert.deepEqual(diffDraft(db, d.id).boards, [], 'an external dep is not a change');

    edit(db, d.id, [{ op: 'remove_edge', from: 'a', to: 'b' }]);
    commitDraft(db, d.id, 2);
    assert.deepEqual(deps(getTask(db, committed.b)), [outside.id]);
  });

  it('moves a backlog card to another board when its node changes board', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    edit(db, d.id, [{ op: 'update_node', id: 'c', patch: { board_id: ws.id, phase: 'Later' } }]);
    const r = commitDraft(db, d.id, 2);
    assert.deepEqual(r.moved, [{ id: committed.c, from: web.id, to: ws.id }]);
    const c = getTask(db, committed.c);
    assert.equal(c.project_id, ws.id);
    assert.equal(c.phase_id, phasesOf(db, ws.id).find((p) => p.title === 'Later')!.id);
    const evProjects = db.prepare('SELECT DISTINCT project_id FROM task_events WHERE task_id = ?').all(c.id) as {
      project_id: string;
    }[];
    assert.deepEqual(evProjects.map((e) => e.project_id), [ws.id], 'history follows the card');
  });

  it('a mapped card deleted elsewhere is created again', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    deleteTask(db, committed.a);
    const diff = diffDraft(db, d.id);
    assert.deepEqual(diff.boards.find((b) => b.board_id === ws.id)!.create.map((c) => c.node_id), ['a']);
    const again = commitDraft(db, d.id, 1).draft.data.committed;
    assert.notEqual(again.a, committed.a);
    assert.deepEqual(deps(getTask(db, committed.b)), [again.a]);
  });

  it('a cycle or a stale version → DraftConflict and nothing written', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    assert.throws(() => commitDraft(db, d.id, 7), (e) => e instanceof DraftConflict && e.code === 'stale' && e.version === 1);
    edit(db, d.id, [{ op: 'add_edge', from: 'c', to: 'a' }]);
    assert.ok(diffDraft(db, d.id).errors.some((e) => e.code === 'cycle'));
    assert.throws(
      () => commitDraft(db, d.id, 2),
      (e) => e instanceof DraftConflict && e.code === 'invalid_plan' && !!e.errors?.some((x) => x.code === 'cycle'),
    );
    assert.equal(count(db, 'tasks'), 0);
    assert.equal(count(db, 'phases'), 0);
    assert.equal(getDraft(db, d.id)!.committed_version, null);
    assert.throws(() => commitDraft(db, 'nope', 1), (e) => e instanceof DraftError && e.code === 'not_found');
  });

  it('a failure mid-commit rolls everything back', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web, { c: { title: 'boom' } });
    // phases and cards a, b are written before c's insert blows up
    db.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON tasks WHEN NEW.title = 'boom'
             BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
    const before = ['tasks', 'phases', 'task_events', 'outbox'].map((tb) => count(db, tb));
    assert.throws(() => commitDraft(db, d.id, 1), /forced failure/);
    assert.deepEqual(['tasks', 'phases', 'task_events', 'outbox'].map((tb) => count(db, tb)), before);
    const stored = getDraft(db, d.id)!;
    assert.equal(stored.committed_version, null);
    assert.deepEqual(stored.data.committed, {});
    db.exec('DROP TRIGGER boom');
    assert.equal(Object.keys(commitDraft(db, d.id, 1).draft.data.committed).length, 3);
  });
});

describe('runDraft', () => {
  it('refuses an uncommitted or dirty draft', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    assert.throws(() => runDraft(db, d.id, 'queue'), (e) => e instanceof DraftConflict && e.code === 'not_committed');
    commitDraft(db, d.id, 1);
    edit(db, d.id, [{ op: 'set_title', title: 'Changed' }]);
    assert.throws(() => runDraft(db, d.id, 'queue'), (e) => e instanceof DraftConflict && e.code === 'dirty');
    assert.throws(() => runDraft(db, d.id, 'go' as never), (e) => e instanceof DraftError && e.code === 'invalid_op');
  });

  it('queue: only spec’d backlog cards are queued; the rest are reported as needs spec', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    const r = runDraft(db, d.id, 'queue');
    assert.deepEqual(r.queued.sort(), [committed.a, committed.b].sort());
    assert.deepEqual(r.skipped, [{ card_id: committed.c, node_id: 'c', title: 'Web page', reason: 'needs spec' }]);
    assert.equal(getTask(db, committed.c).lane, 'backlog');
    assert.equal(getTask(db, committed.a).lane, 'queued');
    assert.deepEqual(r.autopilot, { enabled: [], not_enabled: [] });
    assert.equal((db.prepare('SELECT autopilot FROM projects WHERE id = ?').get(web.id) as { autopilot: number }).autopilot, 0);
  });

  const MAIN = { reason: 'main_session', message: 'Autopilot never drives the main session; its cards are queued for you' };
  const flag = (db: DB, id: string) =>
    (db.prepare('SELECT autopilot FROM projects WHERE id = ?').get(id) as { autopilot: number }).autopilot;

  it('autopilot: turns autopilot on for vertical boards only; the workspace (main session) is queued, not driven', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const d = seed(db, ws, web);
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    const r = runDraft(db, d.id, 'autopilot');
    assert.deepEqual(r.autopilot, {
      enabled: [{ board_id: web.id, already_on: false }],
      not_enabled: [{ board_id: ws.id, ...MAIN }],
    });
    assert.equal(getTask(db, committed.a).lane, 'queued', "the workspace's card is still queued");
    assert.equal(flag(db, web.id), 1);
    assert.equal(flag(db, ws.id), 0);
    assert.deepEqual(runDraft(db, d.id, 'autopilot').autopilot.enabled, [{ board_id: web.id, already_on: true }]);
  });

  it('autopilot: a vertical with no queued cards is reported, not enabled', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    // the web nodes have no spec → nothing to queue there
    const d = seed(db, ws, web, { b: { requirements: undefined } });
    commitDraft(db, d.id, 1);
    const r = runDraft(db, d.id, 'autopilot');
    assert.deepEqual(r.autopilot, {
      enabled: [],
      not_enabled: [
        { board_id: ws.id, ...MAIN },
        { board_id: web.id, reason: 'no queued cards to work' },
      ],
    });
    assert.equal(flag(db, web.id), 0);
  });

  it('autopilot: a standalone project is the main session: queued, never enabled', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-solo-'));
    const db = openDb();
    t.after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const solo = getOrCreateProject(db, dir, 'Solo');
    const d = createDraft(db, solo.id, 'Plan', {
      nodes: [{ id: 'x', title: 'X', board_id: solo.id, requirements: 'r', subtasks: ['s'] }],
    });
    const committed = commitDraft(db, d.id, 1).draft.data.committed;
    const r = runDraft(db, d.id, 'autopilot');
    assert.deepEqual(r.queued, [committed.x]);
    assert.deepEqual(r.autopilot, { enabled: [], not_enabled: [{ board_id: solo.id, ...MAIN }] });
    assert.equal(flag(db, solo.id), 0);
  });
});
