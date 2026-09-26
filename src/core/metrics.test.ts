import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
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
  computeBurn,
  computeFlow,
  computeSummary,
  dayKey,
  deriveLaneHistory,
  inDateRange,
  isoWeek,
  isValidTimeZone,
  laneAt,
  loadCardHistories,
  parseTime,
  percentiles,
  sortEvents,
  startOfDay,
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

  it('review rounds fall back to completed in_review entries, then the task column', () => {
    const c = card({ lane: 'in_review' });
    const events = [ev('create', 0), move('backlog', 'in_review', 5)];
    // sitting in its first review: nothing completed yet
    assert.equal(cardMetrics({ card: c, events }, 10).reviewRoundsSource, 'in_review_entries');
    assert.equal(cardMetrics({ card: c, events }, 10).reviewRounds, 0);
    const back = [...events, move('in_review', 'in_progress', 8), move('in_progress', 'in_review', 9)];
    assert.equal(cardMetrics({ card: c, events: back }, 10).reviewRounds, 1);
    const done = [...back, move('in_review', 'done', 12)];
    assert.equal(cardMetrics({ card: card({ lane: 'done' }), events: done }, 20).reviewRounds, 2);
    // a delete while in review is not a completed review
    const deleted = [...events, ev('delete', 9, { id: 'c1', title: 'Card' })];
    assert.equal(cardMetrics({ card: c, events: deleted }, 10).reviewRounds, 0);
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

  it('a redirect is a fresh start for cycle start and review rounds', () => {
    const c = card({ lane: 'done', review_rounds: 1 });
    const events = [
      ev('create', 0),
      move('backlog', 'queued', 5),
      move('queued', 'in_progress', 10),
      move('in_progress', 'in_review', 20),
      ev('review', 25, { verdict: 'fail', round: 1 }),
      ev('redirect', 30, { from: 'in_review' }),
      move('backlog', 'in_progress', 50),
      move('in_progress', 'in_review', 60),
      ev('review', 65, { verdict: 'pass', round: 1 }),
      move('in_review', 'done', 70),
    ];
    const h = deriveLaneHistory(c, events);
    assert.equal(h.partial, false);
    assert.deepEqual(h.lastRedirect, { at: 30, interval: 4, review: 1 });
    const m = cardMetrics({ card: c, events }, 100);
    assert.equal(m.cycleStartAt, 50, 'the pre-redirect queued entry does not count');
    assert.equal(m.cycleTimeMs, 20);
    assert.equal(m.leadTimeMs, 70, 'lead time still runs from creation');
    assert.equal(m.reviewRounds, 1);
    assert.equal(m.reviewRoundsSource, 'reviews');
  });

  it('a redirect with no later reviews falls back past the old review events', () => {
    const c = card({ lane: 'in_review' });
    const events = [
      ev('create', 0),
      move('backlog', 'in_review', 5),
      ev('review', 6, { verdict: 'fail', round: 1 }),
      move('in_review', 'in_progress', 7),
      ev('redirect', 8, { from: 'in_progress' }),
      move('backlog', 'in_review', 9),
    ];
    const m = cardMetrics({ card: c, events }, 10);
    assert.equal(m.reviewRoundsSource, 'in_review_entries');
    assert.equal(m.reviewRounds, 0);
    assert.equal(m.cycleStartAt, 9);
  });

  it('a done card that skipped queued and in_progress never has a null cycle time', () => {
    const viaReview = [ev('create', 0), move('backlog', 'in_review', 10), move('in_review', 'done', 40)];
    const m = cardMetrics({ card: card({ lane: 'done' }), events: viaReview }, 50);
    assert.equal(m.cycleStartAt, 10);
    assert.equal(m.cycleTimeMs, 30);
    const straight = [ev('create', 0), move('backlog', 'done', 40)];
    const m2 = cardMetrics({ card: card({ lane: 'done' }), events: straight }, 50);
    assert.equal(m2.cycleStartAt, 40);
    assert.equal(m2.cycleTimeMs, 0);
    // after a redirect the old in_progress entry does not count either
    const redirected = [
      ev('create', 0),
      move('backlog', 'in_progress', 5),
      ev('redirect', 10, { from: 'in_progress' }),
      move('backlog', 'done', 30),
    ];
    const m3 = cardMetrics({ card: card({ lane: 'done' }), events: redirected }, 50);
    assert.equal(m3.cycleTimeMs, 0);
    // no events at all but done: still a cycle time
    const m4 = cardMetrics({ card: card({ lane: 'done', created_at: 7 }), events: [] }, 50);
    assert.equal(m4.cycleTimeMs, 0);
  });

  it('rowid wins when created_at goes backwards; the stamp is clamped (no negative spans)', () => {
    const c = card({ lane: 'done' });
    const a = ev('create', 0);
    const b = move('backlog', 'in_progress', 50);
    const d = move('in_progress', 'in_review', 40); // clock stepped back 10ms
    const e = move('in_review', 'done', 60);
    const shuffled = [e, d, b, a];
    assert.deepEqual(sortEvents(shuffled).map((x) => x.id), [a.id, b.id, d.id, e.id]);
    const h = deriveLaneHistory(c, shuffled);
    assert.equal(h.partial, false);
    assert.deepEqual(
      h.intervals.map((i) => [i.lane, i.from, i.to]),
      [
        ['backlog', 0, 50],
        ['in_progress', 50, 50],
        ['in_review', 50, 60],
        ['done', 60, null],
      ],
    );
    const m = cardMetrics({ card: c, events: shuffled }, 60);
    assert.ok(Object.values(m.timeInLaneMs).every((v) => v >= 0));
    assert.equal(m.cycleTimeMs, 10);
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
  const setup = (t: TestContext) => {
    const db = openDb();
    const root = mkdtempSync(join(tmpdir(), 'metrics-'));
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
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

  it('returns cards with their events; workspace expands to its verticals', (t) => {
    const { db, ws, a, b } = setup(t);
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

  it('filters by vertical id alone, phase, tag, agent, and empty projectIds', (t) => {
    const { db, v, phase, a, b, c } = setup(t);
    assert.deepEqual(loadCardHistories(db, { projectIds: [v.id] }).map((h) => h.card.id), [b.id]);
    assert.deepEqual(loadCardHistories(db, { phaseId: phase.id }).map((h) => h.card.id), [a.id]);
    assert.deepEqual(loadCardHistories(db, { tag: 'ui' }).map((h) => h.card.id).sort(), [a.id, c.id].sort());
    assert.deepEqual(loadCardHistories(db, { agent: 'alice' }).map((h) => h.card.id), [a.id]); // assigned_agent
    assert.deepEqual(loadCardHistories(db, { agent: 'bob' }).map((h) => h.card.id), [b.id]); // event agent
    assert.deepEqual(loadCardHistories(db, { agent: 'carol' }).map((h) => h.card.id), [c.id]); // card_activity
    assert.deepEqual(loadCardHistories(db, { projectIds: [] }), []);
    assert.equal(loadCardHistories(db).length, 3);
  });

  it('date range drops cards done before the window and cards created after it', (t) => {
    const { db, a, b, c } = setup(t);
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

describe('aggregations', () => {
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 8, 7); // Mon 2026-09-07 00:00Z
  const hist = (over: Partial<MetricsCard>, events: MetricsEvent[]) => ({
    card: card({ created_at: events[0]?.created_at ?? 0, updated_at: events[events.length - 1]?.created_at ?? 0, ...over }),
    events,
  });

  it('percentiles: nearest rank on known data; empty is null', () => {
    const vals = Array.from({ length: 20 }, (_, i) => 20 - i); // 20..1, unsorted input
    assert.deepEqual(percentiles(vals), { p50: 10, p85: 17, p95: 19, count: 20 });
    assert.deepEqual(percentiles([7]), { p50: 7, p85: 7, p95: 7, count: 1 });
    assert.deepEqual(percentiles([]), { p50: null, p85: null, p95: null, count: 0 });
  });

  it('ISO weeks, including year boundaries', () => {
    assert.deepEqual(isoWeek('2026-09-07'), { week: '2026-W37', start: '2026-09-07' });
    assert.deepEqual(isoWeek('2026-09-13'), { week: '2026-W37', start: '2026-09-07' }); // Sunday
    assert.deepEqual(isoWeek('2026-01-01'), { week: '2026-W01', start: '2025-12-29' });
    assert.deepEqual(isoWeek('2027-01-01'), { week: '2026-W53', start: '2026-12-28' });
  });

  it('day starts are DST-aware (America/New_York fall back / spring forward)', () => {
    const ny = 'America/New_York';
    assert.equal(startOfDay('2026-11-01', ny), Date.UTC(2026, 10, 1, 4)); // still EDT at midnight
    assert.equal(startOfDay('2026-11-02', ny), Date.UTC(2026, 10, 2, 5)); // EST: a 25h day before
    assert.equal(startOfDay('2026-03-08', ny), Date.UTC(2026, 2, 8, 5));
    assert.equal(startOfDay('2026-03-09', ny), Date.UTC(2026, 2, 9, 4)); // a 23h day before
    assert.equal(dayKey(Date.UTC(2026, 10, 2, 4, 30), ny), '2026-11-01'); // 23:30 EST
    assert.equal(parseTime('2026-11-01', ny, 'from'), Date.UTC(2026, 10, 1, 4));
    assert.equal(parseTime('2026-11-01', ny, 'to'), Date.UTC(2026, 10, 2, 5) - 1);
    assert.equal(parseTime('12345', ny, 'from'), 12345);
    assert.equal(parseTime('2026-11-01T00:00:00Z', ny, 'from'), Date.UTC(2026, 10, 1));
    assert.throws(() => parseTime('yesterday', ny, 'to'), /invalid to/);
    assert.throws(() => parseTime('2026-02-31', ny, 'to'), /invalid to/);
    assert.equal(isValidTimeZone(ny), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
  });

  it('week bucketing follows the requested tz across a DST edge', () => {
    // Done Sun 2026-11-01 23:30 EST (the fall-back day) = Mon 2026-11-02 04:30Z.
    const doneAt = Date.UTC(2026, 10, 2, 4, 30);
    const h = hist({ lane: 'done' }, [ev('create', doneAt - 3 * DAY), move('backlog', 'in_progress', doneAt - DAY), move('in_progress', 'done', doneAt)]);
    const range = { from: Date.UTC(2026, 9, 26, 12), to: Date.UTC(2026, 10, 3, 12), now: Date.UTC(2026, 10, 4) };
    const ny = computeFlow([h], { ...range, tz: 'America/New_York' });
    assert.deepEqual(ny.throughput.weekly, [
      { week: '2026-W44', start: '2026-10-26', count: 1 },
      { week: '2026-W45', start: '2026-11-02', count: 0 },
    ]);
    assert.equal(ny.throughput.daily!.find((d) => d.count)!.date, '2026-11-01');
    const utc = computeFlow([h], { ...range, tz: 'UTC' });
    assert.deepEqual(utc.throughput.weekly.map((w) => w.count), [0, 1]);
    assert.equal(utc.throughput.daily!.find((d) => d.count)!.date, '2026-11-02');
  });

  it('flow: throughput zero-filled, percentiles + points for cards done in range, daily only for <= 31 days', () => {
    const hs = [1, 2, 3].map((n) =>
      hist({ id: `c${n}`, title: `C${n}`, lane: 'done' }, [
        ev('create', T0),
        move('backlog', 'queued', T0 + n * 3_600_000),
        move('queued', 'done', T0 + 2 * n * DAY),
      ]),
    );
    const f = computeFlow(hs, { tz: 'UTC', now: T0 + 20 * DAY, from: T0, to: T0 + 13 * DAY });
    assert.equal(f.range.days, 14);
    assert.equal(f.throughput.total, 3);
    assert.deepEqual(f.throughput.weekly.map((w) => [w.week, w.count]), [
      ['2026-W37', 3],
      ['2026-W38', 0],
    ]);
    assert.equal(f.throughput.daily!.length, 14);
    assert.deepEqual(f.throughput.daily!.filter((d) => d.count).map((d) => d.date), ['2026-09-09', '2026-09-11', '2026-09-13']);
    assert.deepEqual(f.points.map((p) => [p.id, p.leadTimeMs]), [
      ['c1', 2 * DAY],
      ['c2', 4 * DAY],
      ['c3', 6 * DAY],
    ]);
    assert.equal(f.points[0].cycleTimeMs, 2 * DAY - 3_600_000);
    assert.deepEqual(f.leadTime, { p50: 4 * DAY, p85: 6 * DAY, p95: 6 * DAY, count: 3 });
    // a range that excludes c3's done day
    assert.equal(computeFlow(hs, { tz: 'UTC', now: T0 + 20 * DAY, from: T0, to: T0 + 5 * DAY }).throughput.total, 2);
    // longer than 31 days: weekly only
    const long = computeFlow(hs, { tz: 'UTC', now: T0 + 40 * DAY, from: T0, to: T0 + 40 * DAY });
    assert.equal(long.throughput.daily, null);
    assert.equal(long.throughput.weekly.reduce((s, w) => s + w.count, 0), 3);
    assert.throws(() => computeFlow(hs, { tz: 'UTC', now: T0, from: T0 + DAY, to: T0 }), /from must be <= to/);
    assert.throws(() => computeFlow(hs, { tz: 'UTC', now: T0, from: 0, to: T0 }), /range too long/);
  });

  it('flow: empty data is zero-filled with null percentiles', () => {
    const f = computeFlow([], { tz: 'UTC', now: T0 + 12 * 3_600_000 });
    assert.equal(f.range.days, 1);
    assert.deepEqual(f.throughput.weekly, [{ week: '2026-W37', start: '2026-09-07', count: 0 }]);
    assert.deepEqual(f.cycleTime, { p50: null, p85: null, p95: null, count: 0 });
    assert.deepEqual(f.cfd, [{ date: '2026-09-07', backlog: 0, queued: 0, in_progress: 0, in_review: 0, done: 0 }]);
    assert.equal(f.cards, 0);
    assert.equal(f.partial, 0);
  });

  it('CFD: lane counts at each day end from synthetic histories; partial counted', () => {
    const a = hist({ id: 'a', lane: 'done' }, [
      ev('create', T0 + 10 * 3_600_000),
      move('backlog', 'queued', T0 + DAY + 1),
      move('queued', 'done', T0 + 2 * DAY + 1),
    ]);
    const b = hist({ id: 'b', lane: 'in_progress' }, [ev('create', T0 + DAY + 5), move('backlog', 'in_progress', T0 + 2 * DAY + 5)]);
    const c = hist({ id: 'c', lane: 'in_review', created_at: T0 + 2 * DAY + 7, updated_at: T0 + 2 * DAY + 7 }, []); // partial
    const f = computeFlow([a, b, c], { tz: 'UTC', now: T0 + 2 * DAY + 3_600_000, from: T0 });
    assert.deepEqual(
      f.cfd.map(({ date, ...l }) => [date, l]),
      [
        ['2026-09-07', { backlog: 1, queued: 0, in_progress: 0, in_review: 0, done: 0 }],
        ['2026-09-08', { backlog: 1, queued: 1, in_progress: 0, in_review: 0, done: 0 }],
        ['2026-09-09', { backlog: 0, queued: 0, in_progress: 1, in_review: 1, done: 1 }],
      ],
    );
    assert.equal(f.partial, 1);
    assert.equal(f.cards, 3);
  });

  it('burn-up / burn-down: scope grows as cards join; approximated joins; reopened cards un-done', () => {
    const phase = { id: 'ph', title: 'P', status: 'active', created_at: T0 + DAY, updated_at: T0 + DAY };
    const inPhase = { phase_id: 'ph' };
    const a = hist({ id: 'a', lane: 'done', ...inPhase }, [
      ev('create', T0 + DAY + 1, { phase_id: 'ph' }),
      move('backlog', 'in_progress', T0 + DAY + 2),
      move('in_progress', 'done', T0 + 3 * DAY + 1),
    ]);
    const b = hist({ id: 'b', lane: 'backlog', ...inPhase }, [ev('create', T0 + 2 * DAY + 1, { phase_id: 'ph' })]);
    // created before the phase existed, placed into it later: joins at the phase's creation
    const c = hist({ id: 'c', lane: 'in_progress', ...inPhase }, [
      ev('create', T0, { phase_id: null }),
      move('backlog', 'done', T0 + 3 * DAY + 2),
      move('done', 'in_progress', T0 + 4 * DAY + 2),
    ]);
    const burn = computeBurn(phase, [a, b, c], { tz: 'UTC', now: T0 + 4 * DAY + 3_600_000 });
    assert.equal(burn.approximated, 1);
    assert.equal(burn.range.from, T0 + DAY);
    assert.deepEqual(
      burn.series.map((s) => [s.date, s.scope, s.done, s.remaining]),
      [
        ['2026-09-08', 2, 0, 2],
        ['2026-09-09', 3, 0, 3],
        ['2026-09-10', 3, 2, 1],
        ['2026-09-11', 3, 1, 2],
      ],
    );
    assert.equal(burn.scope, 3);
    assert.equal(burn.done, 1);
    // a done phase ends at its last done card / update, not now
    const closed = computeBurn({ ...phase, status: 'done', updated_at: T0 + 3 * DAY + 5 }, [a], {
      tz: 'UTC',
      now: T0 + 30 * DAY,
    });
    assert.equal(closed.series.length, 3);
    assert.equal(closed.series[2].remaining, 0);
    // no cards: a flat zero series from the phase's creation
    const empty = computeBurn(phase, [], { tz: 'UTC', now: T0 + 2 * DAY });
    assert.deepEqual(empty.series.map((s) => s.scope), [0, 0]);
  });

  it('summary: last 4 weeks, cycle p50/p85, WIP at the end, oldest in-flight', () => {
    const now = T0 + 40 * DAY;
    const doneCards = [5, 20, 38].map((d) =>
      hist({ id: `d${d}`, lane: 'done' }, [ev('create', T0 + d * DAY - 2 * DAY), move('backlog', 'queued', T0 + d * DAY - DAY), move('queued', 'done', T0 + d * DAY)]),
    );
    const old = hist({ id: 'old', title: 'Old', lane: 'in_progress' }, [ev('create', T0), move('backlog', 'queued', T0 + DAY), move('queued', 'in_progress', T0 + 30 * DAY)]);
    const young = hist({ id: 'young', lane: 'in_review' }, [ev('create', T0), move('backlog', 'in_review', T0 + 35 * DAY)]);
    const idle = hist({ id: 'idle', lane: 'backlog' }, [ev('create', T0)]);
    const s = computeSummary([...doneCards, old, young, idle], { tz: 'UTC', now });
    assert.equal(s.range.from, now - 28 * DAY);
    assert.equal(s.throughput.length, 4);
    assert.equal(s.throughput.reduce((n, w) => n + w.count, 0), 2, 'd5 is outside the last 28 days');
    assert.deepEqual(s.cycleTime, { p50: DAY, p85: DAY, count: 2 });
    assert.deepEqual(s.wip, { backlog: 1, queued: 0, in_progress: 1, in_review: 1 });
    assert.deepEqual(s.oldestInFlight, { id: 'old', title: 'Old', lane: 'in_progress', inFlightMs: 39 * DAY, ageInLaneMs: 10 * DAY });
    assert.equal(computeSummary([], { tz: 'UTC', now }).oldestInFlight, null);
  });

  it('laneAt: before creation is null', () => {
    const d = deriveLaneHistory(card({ lane: 'queued', created_at: 10 }), [ev('create', 10), move('backlog', 'queued', 20)]);
    assert.equal(laneAt(d.intervals, 5), null);
    assert.equal(laneAt(d.intervals, 10), 'backlog');
    assert.equal(laneAt(d.intervals, 20), 'queued');
  });
});
