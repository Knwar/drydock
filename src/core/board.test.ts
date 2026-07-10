import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  advancePhase,
  appendEvent,
  assignCard,
  cardTotals,
  checkSubtask,
  createPhase,
  createTask,
  createTeamMember,
  deleteTask,
  deleteTeamMember,
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
  listTeam,
  moveTask,
  raiseBlocker,
  recordActivity,
  recordReview,
  redirectTask,
  resolveBlocker,
  setSubtasks,
  updateTask,
  updateTeamMember,
} from './board.js';
import { openDb } from './db.js';
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
