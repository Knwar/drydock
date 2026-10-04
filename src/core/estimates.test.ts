import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTask, getOrCreateProject, moveTask, recordActivity } from './board.js';
import { openDb } from './db.js';
import { estimateMetrics, estimatesFrom } from './estimates.js';
import { deriveCards, MetricsParamError, type MetricsCard, type MetricsEvent } from './metrics.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 1);
const END = T0 + 7 * 24 * HOUR;

let seq = 0;
const ev = (type: string, at: number, payload: Record<string, unknown>): MetricsEvent => ({ id: ++seq, type, payload: JSON.stringify(payload), created_at: at });
/** Queued at `start`, done `hours` later. */
const card = (id: string, start: number, hours: number) => ({
  card: {
    id,
    project_id: 'p',
    phase_id: null,
    title: id.toUpperCase(),
    lane: 'done',
    tag: null,
    assigned_agent: null,
    blocked_at: null,
    blocked_reason: null,
    review_rounds: 0,
    created_at: start,
    updated_at: start + hours * HOUR,
  } as MetricsCard,
  events: [
    ev('create', start, { title: id }),
    ev('move', start, { from: 'backlog', to: 'queued' }),
    ev('move', start + hours * HOUR, { from: 'queued', to: 'done' }),
  ],
});
const opts = { tz: 'UTC', now: END, from: T0, to: END };

describe('estimatesFrom', () => {
  it('hourly rate, coverage, perception (ratios, median, top misses)', () => {
    const ds = deriveCards(
      [
        card('a', T0, 4), // est 2h: 2x over
        card('b', T0, 2), // est 8h: 4x under
        card('c', T0, 6), // est 6h: spot on
        card('d', T0, 10), // est 5h, no spend: out of the rate, still in perception
        card('e', T0, 1), // no estimate
        card('old', T0 - 48 * HOUR, 1), // done before the window
      ],
      END,
    );
    const r = estimatesFrom(
      ds,
      new Map([
        ['a', 2],
        ['b', 8],
        ['c', 6],
        ['d', 5],
        ['old', 1],
      ]),
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 1],
        ['e', 9],
      ]),
      opts,
    );
    assert.equal(r.done, 5);
    assert.deepEqual(r.coverage, { estimated: 4, pct: 0.8 });
    assert.deepEqual(r.hourlyRate, { cards: 3, noSpend: 1, estimateHours: 16, cost: 4, hoursPerDollar: 4, dollarsPerHour: 0.25 });
    assert.deepEqual(
      r.perception.cards.map((p) => [p.id, p.estimateHours, p.cycleHours, p.cost, p.ratio]),
      [
        ['b', 8, 2, 2, 0.25], // by done time
        ['a', 2, 4, 1, 2],
        ['c', 6, 6, 1, 1],
        ['d', 5, 10, 0, 2],
      ],
    );
    assert.equal(r.perception.medianRatio, 1.5); // [0.25, 1, 2, 2]: the mean of the middle two
    // |ln ratio|: b (4x) first, then a and d (2x, by id), then c (exact)
    assert.deepEqual(r.perception.topMisses.map((p) => p.id), ['b', 'a', 'd', 'c']);
  });

  it('no data: zeros and nulls', () => {
    const r = estimatesFrom([], new Map(), new Map(), opts);
    assert.deepEqual(r, {
      range: { from: T0, to: END, tz: 'UTC' },
      done: 0,
      coverage: { estimated: 0, pct: null },
      hourlyRate: { cards: 0, noSpend: 0, estimateHours: 0, cost: 0, hoursPerDollar: null, dollarsPerHour: null },
      perception: { cards: [], medianRatio: null, topMisses: [] },
    });
    // done cards but none estimated
    const none = estimatesFrom(deriveCards([card('a', T0, 1)], END), new Map(), new Map([['a', 3]]), opts);
    assert.deepEqual([none.done, none.coverage.pct, none.hourlyRate.hoursPerDollar, none.perception.medianRatio], [1, 0, null, null]);
  });

  it('a zero cycle time has no ratio and is not a miss', () => {
    const r = estimatesFrom(deriveCards([card('z', T0, 0)], END), new Map([['z', 3]]), new Map(), opts);
    assert.deepEqual([r.perception.cards[0].ratio, r.perception.medianRatio, r.perception.topMisses], [null, null, []]);
  });

  it('rejects a bad range', () => {
    assert.throws(() => estimatesFrom([], new Map(), new Map(), { tz: 'UTC', now: END, from: END, to: T0 }), MetricsParamError);
  });
});

describe('estimateMetrics (DB)', () => {
  it('reads estimates and prices every run of the estimated cards', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'estimates-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDb();
    const p = getOrCreateProject(db, dir);
    const a = createTask(db, p.id, 'A', { estimate_hours: 6 });
    const b = createTask(db, p.id, 'B');
    for (const id of [a.id, b.id]) {
      moveTask(db, id, 'in_progress');
      moveTask(db, id, 'done');
    }
    const usage = { 'claude-sonnet-5': { input: 1_000_000, output: 0, cache_read: 0, cache_creation: 0 } }; // $3
    for (const agent of ['builder', 'reviewer'])
      recordActivity(db, { project_id: p.id, task_id: a.id, agent, tokens: 1, tokens_out: 0, lines_added: 0, lines_removed: 0, ms: 0, usage });
    const r = estimateMetrics(db, { projectIds: [p.id] }, { tz: 'UTC', now: Date.now() });
    assert.deepEqual(r.coverage, { estimated: 1, pct: 0.5 });
    assert.deepEqual([r.hourlyRate.cost, r.hourlyRate.estimateHours, r.hourlyRate.hoursPerDollar, r.hourlyRate.dollarsPerHour], [6, 6, 1, 1]);
    assert.equal(r.perception.cards[0].id, a.id);
    db.close();
  });
});
