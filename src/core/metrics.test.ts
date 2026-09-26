import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assignCard,
  createPhase,
  createTask,
  createVertical,
  getOrCreateProject,
  moveTask,
  raiseBlocker,
  recordActivity,
  recordReview,
} from './board.js';
import { openDb } from './db.js';
import {
  cardMetrics,
  deriveLaneHistory,
  inDateRange,
  loadCardHistories,
  sortEvents,
  type MetricsCard,
  type MetricsEvent,
} from './metrics.js';

const card = (over: Partial<MetricsCard> = {}): MetricsCard => ({
  id: 'c1',
  project_id: 'p1',
  phase_id: null,
  title: 'Card',
  lane: 'backlog',
  tag: null,
  assigned_agent: null,
  blocked_at: null,
  blocked_reason: null,
  review_rounds: 0,
  created_at: 0,
  updated_at: 0,
  ...over,
});

let seq = 0;
const ev = (type: string, created_at: number, payload: Record<string, unknown> | null = null): MetricsEvent => ({
  id: ++seq,
  type,
  payload: payload === null ? null : JSON.stringify(payload),
  created_at,
});
const move = (from: string, to: string, at: number) => ev('move', at, { from, to });

describe('deriveLaneHistory / cardMetrics', () => {
  it('straight path: backlog -> queued -> in_progress -> in_review -> done', () => {
    const c = card({ lane: 'done', updated_at: 100 });
    const events = [
      ev('create', 0, { title: 'Card' }),
      move('backlog', 'queued', 10),
      ev('assign', 20, { worktree: '.trees/c1' }),
      move('queued', 'in_progress', 20),
      move('in_progress', 'in_review', 60),
      ev('review', 80, { verdict: 'pass', round: 1 }),
      move('in_review', 'done', 90),
    ];
    const h = deriveLaneHistory(c, events);
    assert.equal(h.partial, false);
    assert.deepEqual(
      h.intervals.map((i) => [i.lane, i.from, i.to]),
      [
        ['backlog', 0, 10],
        ['queued', 10, 20],
        ['in_progress', 20, 60],
        ['in_review', 60, 90],
        ['done', 90, null],
      ],
    );
    const m = cardMetrics({ card: c, events }, 200);
    assert.equal(m.leadTimeMs, 90);
    assert.equal(m.cycleStartAt, 10);
    assert.equal(m.cycleTimeMs, 80);
    assert.deepEqual(m.timeInLaneMs, { backlog: 10, queued: 10, in_progress: 40, in_review: 30, done: 110 });
    assert.equal(m.reviewRounds, 1);
    assert.equal(m.reviewRoundsSource, 'reviews');
    assert.equal(m.ageInLaneMs, 110);
    assert.equal(m.blockedMs, 0);
  });

  it('cycle starts at first in_progress when never queued', () => {
    const c = card({ lane: 'done' });
    const events = [ev('create', 0), move('backlog', 'in_progress', 30), move('in_progress', 'done', 50)];
    const m = cardMetrics({ card: c, events }, 100);
    assert.equal(m.cycleStartAt, 30);
    assert.equal(m.cycleTimeMs, 20);
    assert.equal(m.leadTimeMs, 50);
  });

  it('review fail loop: repeated in_progress/in_review intervals are summed', () => {
    const c = card({ lane: 'done', review_rounds: 2 });
    const events = [
      ev('create', 0),
      move('backlog', 'in_progress', 10),
      move('in_progress', 'in_review', 20),
      ev('review', 25, { verdict: 'fail', round: 1 }),
      move('in_review', 'in_progress', 30),
      move('in_progress', 'in_review', 50),
      ev('review', 55, { verdict: 'pass', round: 2 }),
      move('in_review', 'done', 60),
    ];
    const h = deriveLaneHistory(c, events);
    assert.equal(h.intervals.length, 6);
    const m = cardMetrics({ card: c, events }, 60);
    assert.equal(m.timeInLaneMs.in_progress, 30);
    assert.equal(m.timeInLaneMs.in_review, 20);
    assert.equal(m.reviewRounds, 2);
    assert.equal(m.cycleTimeMs, 50);
  });

  it('review rounds fall back to in_review entries, then the task column', () => {
    const c = card({ lane: 'in_review' });
    const events = [ev('create', 0), move('backlog', 'in_review', 5)];
    assert.equal(cardMetrics({ card: c, events }, 10).reviewRoundsSource, 'in_review_entries');
    assert.equal(cardMetrics({ card: c, events }, 10).reviewRounds, 1);
    const c2 = card({ review_rounds: 3 });
    const m2 = cardMetrics({ card: c2, events: [ev('create', 0)] }, 10);
    assert.equal(m2.reviewRoundsSource, 'task');
    assert.equal(m2.reviewRounds, 3);
  });

  it('blocked / unblocked, re-raise keeps the start, assign and done clear it', () => {
    const c = card({ lane: 'done' });
    const events = [
      ev('create', 0),
      move('backlog', 'in_progress', 10),
      ev('block', 20, { reason: 'which db?' }),
      ev('block', 25, { reason: 'which db, really?' }),
      ev('unblock', 40, { note: 'sqlite' }),
      ev('block', 50, { reason: 'secret' }),
      ev('assign', 55),
      ev('block', 60, { reason: 'again' }),
      move('in_progress', 'done', 70),
    ];
    const h = deriveLaneHistory(c, events);
    assert.deepEqual(h.blocked, [
      { from: 20, to: 40, reason: 'which db, really?' },
      { from: 50, to: 55, reason: 'secret' },
      { from: 60, to: 70, reason: 'again' },
    ]);
    const m = cardMetrics({ card: c, events }, 100);
    assert.equal(m.blockedMs, 20 + 5 + 10);
    assert.equal(m.blocked, false);
    assert.equal(h.partial, false);
  });

  it('an open blocker counts up to now', () => {
    const c = card({ lane: 'in_progress', blocked_at: 20, blocked_reason: 'q' });
    const events = [ev('create', 0), move('backlog', 'in_progress', 10), ev('block', 20, { reason: 'q' })];
    const m = cardMetrics({ card: c, events }, 50);
    assert.equal(m.blocked, true);
    assert.equal(m.blockedMs, 30);
  });

  it('card created directly in progress with no events is partial', () => {
    const c = card({ lane: 'in_progress', created_at: 100, updated_at: 150 });
    const h = deriveLaneHistory(c, []);
    assert.equal(h.partial, true);
    assert.deepEqual(h.intervals, [{ lane: 'in_progress', from: 100, to: null }]);
    const m = cardMetrics({ card: c, events: [] }, 400);
    assert.equal(m.ageInLaneMs, 300);
    assert.equal(m.cycleStartAt, 100);
    assert.equal(m.leadTimeMs, null);
    assert.equal(m.partial, true);
  });

  it('history missing its create event infers the initial lane from the first move', () => {
    const c = card({ lane: 'done', created_at: 0 });
    const h = deriveLaneHistory(c, [move('in_progress', 'done', 40)]);
    assert.equal(h.partial, true);
    assert.deepEqual(
      h.intervals.map((i) => i.lane),
      ['in_progress', 'done'],
    );
  });

  it('a final lane that disagrees with the card row is reconciled at updated_at', () => {
    const c = card({ lane: 'in_review', updated_at: 70 });
    const h = deriveLaneHistory(c, [ev('create', 0), move('backlog', 'in_progress', 10)]);
    assert.equal(h.partial, true);
    assert.deepEqual(h.intervals[h.intervals.length - 1], { lane: 'in_review', from: 70, to: null });
  });

  it('a blocker on the row with no block event is added as partial', () => {
    const c = card({ lane: 'in_progress', blocked_at: 30, blocked_reason: 'r' });
    const h = deriveLaneHistory(c, [ev('create', 0), move('backlog', 'in_progress', 10)]);
    assert.equal(h.partial, true);
    assert.deepEqual(h.blocked, [{ from: 30, to: null, reason: 'r' }]);
  });

  it('out-of-order rows are sorted by ts then rowid', () => {
    const c = card({ lane: 'done' });
    const a = ev('create', 0);
    const b = move('backlog', 'queued', 10);
    const d = move('queued', 'in_progress', 10); // same ms: rowid decides
    const e = move('in_progress', 'done', 30);
    const shuffled = [e, d, a, b];
    assert.deepEqual(
      sortEvents(shuffled).map((x) => x.id),
      [a.id, b.id, d.id, e.id],
    );
    const h = deriveLaneHistory(c, shuffled);
    assert.equal(h.partial, false);
    assert.deepEqual(
      h.intervals.map((i) => i.lane),
      ['backlog', 'queued', 'in_progress', 'done'],
    );
    assert.equal(cardMetrics({ card: c, events: shuffled }, 30).timeInLaneMs.queued, 0);
  });

  it('an event stamped before created_at moves the start back (no negative spans)', () => {
    const c = card({ lane: 'queued', created_at: 50 });
    const m = cardMetrics({ card: c, events: [ev('create', 40), move('backlog', 'queued', 45)] }, 100);
    assert.equal(m.createdAt, 40);
    assert.equal(m.timeInLaneMs.backlog, 5);
  });

  it('open card age and age in current lane are relative to injected now', () => {
    const c = card({ lane: 'in_progress', created_at: 1000 });
    const events = [ev('create', 1000), move('backlog', 'in_progress', 4000)];
    const m = cardMetrics({ card: c, events }, 10_000);
    assert.equal(m.ageMs, 9000);
    assert.equal(m.ageInLaneMs, 6000);
    assert.equal(m.timeInLaneMs.in_progress, 6000);
    assert.equal(m.doneAt, null);
    assert.equal(m.cycleTimeMs, null);
  });

  it('reopened done card has no lead time; redirect returns to backlog', () => {
    const c = card({ lane: 'backlog' });
    const events = [
      ev('create', 0),
      move('backlog', 'in_progress', 10),
      move('in_progress', 'done', 20),
      move('done', 'in_progress', 30),
      ev('redirect', 40, { from: 'in_progress' }),
    ];
    const m = cardMetrics({ card: c, events }, 50);
    assert.equal(m.lane, 'backlog');
    assert.equal(m.doneAt, null);
    assert.equal(m.leadTimeMs, null);
    assert.equal(m.timeInLaneMs.backlog, 20);
  });

  it('a delete event closes the history', () => {
    const c = card({ lane: 'in_progress', blocked_at: 15 });
    const events = [
      ev('create', 0),
      move('backlog', 'in_progress', 10),
      ev('block', 15, { reason: 'x' }),
      ev('delete', 30, { id: 'c1', title: 'Card' }),
    ];
    const h = deriveLaneHistory(c, events);
    assert.equal(h.deletedAt, 30);
    assert.deepEqual(h.intervals[h.intervals.length - 1], { lane: 'in_progress', from: 10, to: 30 });
    const m = cardMetrics({ card: c, events }, 1000);
    assert.equal(m.deleted, true);
    assert.equal(m.ageInLaneMs, null);
    assert.equal(m.ageMs, 30);
    assert.equal(m.blockedMs, 15);
    assert.equal(m.timeInLaneMs.in_progress, 20);
  });

  it('inDateRange keeps cards whose life overlaps the window', () => {
    assert.equal(inDateRange({ createdAt: 10, doneAt: 20 }, { from: 21 }), false);
    assert.equal(inDateRange({ createdAt: 10, doneAt: 20 }, { from: 20, to: 30 }), true);
    assert.equal(inDateRange({ createdAt: 10, doneAt: null }, { from: 1000 }), true);
    assert.equal(inDateRange({ createdAt: 10, doneAt: null }, { to: 5 }), false);
  });
});

describe('loadCardHistories', () => {
  const setup = () => {
    const db = openDb();
    const root = mkdtempSync(join(tmpdir(), 'metrics-'));
    mkdirSync(join(root, 'ws', 'api'), { recursive: true });
    const ws = getOrCreateProject(db, join(root, 'ws'), 'ws');
    const v = createVertical(db, ws.id, 'api', join(root, 'ws', 'api'));
    const other = getOrCreateProject(db, join(root, 'other'), 'other');
    const phase = createPhase(db, ws.id, 'P1');
    const a = createTask(db, ws.id, 'A', { tag: 'ui', phase_id: phase.id });
    const b = createTask(db, v.id, 'B', { tag: 'api' });
    const c = createTask(db, other.id, 'C', { tag: 'ui' });
    assignCard(db, a.id, 'alice', '.trees/a', 'card/a');
    moveTask(db, a.id, 'in_review');
    recordReview(db, a.id, 'pass');
    moveTask(db, a.id, 'done');
    raiseBlocker(db, b.id, 'why', 'bob');
    recordActivity(db, { project_id: other.id, task_id: c.id, agent: 'carol', tokens: 0, tokens_out: 0, lines_added: 0, lines_removed: 0, ms: 0 });
    return { db, ws, v, other, phase, a, b, c };
  };

  it('returns cards with their events; workspace expands to its verticals', () => {
    const { db, ws, a, b } = setup();
    const hs = loadCardHistories(db, { projectIds: [ws.id] });
    assert.deepEqual(hs.map((h) => h.card.id).sort(), [a.id, b.id].sort());
    const ha = hs.find((h) => h.card.id === a.id)!;
    assert.deepEqual(
      ha.events.map((e) => e.type),
      ['create', 'assign', 'move', 'move', 'review', 'move'],
    );
    const m = cardMetrics(ha, Date.now());
    assert.equal(m.lane, 'done');
    assert.equal(m.partial, false);
    assert.equal(m.reviewRounds, 1);
    assert.ok(m.leadTimeMs !== null && m.leadTimeMs >= 0);
    const mb = cardMetrics(hs.find((h) => h.card.id === b.id)!, Date.now());
    assert.equal(mb.blocked, true);
  });

  it('filters by vertical id alone, phase, tag, agent, and empty projectIds', () => {
    const { db, v, phase, a, b, c } = setup();
    assert.deepEqual(loadCardHistories(db, { projectIds: [v.id] }).map((h) => h.card.id), [b.id]);
    assert.deepEqual(loadCardHistories(db, { phaseId: phase.id }).map((h) => h.card.id), [a.id]);
    assert.deepEqual(loadCardHistories(db, { tag: 'ui' }).map((h) => h.card.id).sort(), [a.id, c.id].sort());
    assert.deepEqual(loadCardHistories(db, { agent: 'alice' }).map((h) => h.card.id), [a.id]); // assigned_agent
    assert.deepEqual(loadCardHistories(db, { agent: 'bob' }).map((h) => h.card.id), [b.id]); // event agent
    assert.deepEqual(loadCardHistories(db, { agent: 'carol' }).map((h) => h.card.id), [c.id]); // card_activity
    assert.deepEqual(loadCardHistories(db, { projectIds: [] }), []);
    assert.equal(loadCardHistories(db).length, 3);
  });

  it('date range drops cards done before the window and cards created after it', () => {
    const { db, a, b, c } = setup();
    const doneAt = cardMetrics(loadCardHistories(db, { tag: 'ui' }).find((h) => h.card.id === a.id)!, 0).doneAt!;
    // backdate A so it finished well before the window
    db.prepare('UPDATE task_events SET created_at = created_at - 100000 WHERE task_id = ?').run(a.id);
    db.prepare('UPDATE tasks SET created_at = created_at - 100000 WHERE id = ?').run(a.id);
    const ids = loadCardHistories(db, { from: doneAt - 50000 }).map((h) => h.card.id);
    assert.ok(!ids.includes(a.id));
    assert.ok(ids.includes(b.id) && ids.includes(c.id));
    assert.deepEqual(loadCardHistories(db, { to: 1 }), []);
  });
});
