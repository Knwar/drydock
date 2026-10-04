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
/** Queued at `start`, done `hours` later; the last `ipHours` of it in in_progress. */
const card = (id: string, start: number, hours: number, agent: string | null = null, ipHours = 0) => ({
  card: {
    id,
    project_id: 'p',
    phase_id: null,
    title: id.toUpperCase(),
    lane: 'done',
    tag: null,
    assigned_agent: agent,
    blocked_at: null,
    blocked_reason: null,
    review_rounds: 0,
    created_at: start,
    updated_at: start + hours * HOUR,
  } as MetricsCard,
  events: [
    ev('create', start, { title: id }),
    ev('move', start, { from: 'backlog', to: 'queued' }),
    ...(ipHours ? [ev('move', start + (hours - ipHours) * HOUR, { from: 'queued', to: 'in_progress' })] : []),
    ev('move', start + hours * HOUR, { from: ipHours ? 'in_progress' : 'queued', to: 'done' }),
  ],
});
const hrs = (entries: [string, number][]) => new Map(entries.map(([id, h]) => [id, h * HOUR]));
const opts = { tz: 'UTC', now: END, from: T0, to: END };

describe('estimatesFrom', () => {
  it('hourly rate, coverage, perception on agent build time (ratios, median, top misses)', () => {
    // cycle times are long (waiting included); the build time is what the ratio measures
    const ds = deriveCards(
      [
        card('a', T0, 40), // build 4h, est 2h: 2x over
        card('b', T0, 20), // build 2h, est 8h: 4x under
        card('c', T0, 60), // build 6h, est 6h: spot on
        card('d', T0, 100), // build 10h, est 5h, no spend: out of the rate, still in perception
        card('e', T0, 1), // no estimate
        card('old', T0 - 48 * HOUR, 1), // done before the window
      ],
      END,
    );
    const buildMs = hrs([
      ['a', 4],
      ['b', 2],
      ['c', 6],
      ['d', 10],
    ]);
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
      { ...opts, buildMs },
    );
    assert.equal(r.done, 5);
    assert.deepEqual(r.coverage, { estimated: 4, pct: 0.8 });
    assert.deepEqual(r.hourlyRate, {
      cards: 3,
      noSpend: 1,
      estimateHours: 16,
      cost: 4,
      hoursPerDollar: 4,
      dollarsPerHour: 0.25,
      byAgent: [{ agent: null, cards: 3, estimateHours: 16, cost: 4, hoursPerDollar: 4 }],
      byAgentBasis: { hours: 'spend_share', cost: 'run_agent' },
    });
    assert.equal(r.perception.measure, 'build_time');
    assert.deepEqual(
      r.perception.cards.map((p) => [p.id, p.estimateHours, p.buildHours, p.buildSource, p.cycleHours, p.cost, p.ratio]),
      [
        ['b', 8, 2, 'runs', 20, 2, 0.25], // by done time; cycle hours ride along as context
        ['a', 2, 4, 'runs', 40, 1, 2],
        ['c', 6, 6, 'runs', 60, 1, 1],
        ['d', 5, 10, 'runs', 100, 0, 2],
      ],
    );
    assert.deepEqual([r.perception.tooShort, r.perception.fallbacks], [0, 0]);
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
      hourlyRate: {
        cards: 0,
        noSpend: 0,
        estimateHours: 0,
        cost: 0,
        hoursPerDollar: null,
        dollarsPerHour: null,
        byAgent: [],
        byAgentBasis: { hours: 'spend_share', cost: 'run_agent' },
      },
      perception: { measure: 'build_time', cards: [], medianRatio: null, topMisses: [], tooShort: 0, fallbacks: 0 },
    });
    // done cards but none estimated
    const none = estimatesFrom(deriveCards([card('a', T0, 1)], END), new Map(), new Map([['a', 3]]), opts);
    assert.deepEqual([none.done, none.coverage.pct, none.hourlyRate.hoursPerDollar, none.perception.medianRatio], [1, 0, null, null]);
  });

  it('byAgent with runs: spend per run agent, each card\'s hours split by spend share', () => {
    const ds = deriveCards([card('a', T0, 4, 'Ada'), card('b', T0, 2, 'Bram'), card('n', T0, 2, 'Ada')], END);
    const r = estimatesFrom(
      ds,
      new Map([
        ['a', 6],
        ['b', 2],
        ['n', 9], // estimated, no spend: out of byAgent, as out of the overall rate
      ]),
      new Map([
        ['a', 3],
        ['b', 1],
      ]),
      {
        ...opts,
        // a was built by Ada ($2) and Bram ($1): its 6h split 4h / 2h
        runs: [
          { task_id: 'a', agent: 'Ada', cost: 2 },
          { task_id: 'a', agent: 'Bram', cost: 1 },
          { task_id: 'b', agent: 'Bram', cost: 1 },
          { task_id: 'zzz', agent: 'Ada', cost: 50 }, // not an estimated, spent card: ignored
        ],
      },
    );
    assert.deepEqual(r.hourlyRate.byAgent, [
      { agent: 'Ada', cards: 1, estimateHours: 4, cost: 2, hoursPerDollar: 2 },
      { agent: 'Bram', cards: 2, estimateHours: 4, cost: 2, hoursPerDollar: 2 },
    ]);
    assert.deepEqual(r.hourlyRate.byAgentBasis, { hours: 'spend_share', cost: 'run_agent' });
    // every row has a finite rate; the rows add up to the overall hours and spend
    assert.ok(r.hourlyRate.byAgent.every((x) => x.hoursPerDollar !== null && Number.isFinite(x.hoursPerDollar)));
    const sum = (k: 'estimateHours' | 'cost') => r.hourlyRate.byAgent.reduce((t, x) => t + x[k], 0);
    assert.ok(Math.abs(sum('estimateHours') - r.hourlyRate.estimateHours) < 1e-6);
    assert.ok(Math.abs(sum('cost') - r.hourlyRate.cost) < 1e-6);
  });

  it('byAgent: uneven shares still add up exactly to the overall figures', () => {
    const ds = deriveCards([card('a', T0, 4), card('b', T0, 2)], END);
    const r = estimatesFrom(
      ds,
      new Map([
        ['a', 7],
        ['b', 5],
      ]),
      new Map([
        ['a', 3],
        ['b', 7],
      ]),
      {
        ...opts,
        runs: [
          { task_id: 'a', agent: 'x', cost: 1 },
          { task_id: 'a', agent: 'y', cost: 2 },
          { task_id: 'b', agent: 'y', cost: 3 },
          { task_id: 'b', agent: 'z', cost: 4 },
        ],
      },
    );
    assert.equal(r.hourlyRate.byAgent.length, 3);
    assert.ok(r.hourlyRate.byAgent.every((x) => x.estimateHours > 0 && x.cost > 0 && Number.isFinite(x.hoursPerDollar!)));
    const sum = (k: 'estimateHours' | 'cost') => r.hourlyRate.byAgent.reduce((t, x) => t + x[k], 0);
    assert.ok(Math.abs(sum('estimateHours') - 12) < 1e-5 && Math.abs(sum('estimateHours') - r.hourlyRate.estimateHours) < 1e-5);
    assert.ok(Math.abs(sum('cost') - 10) < 1e-6 && Math.abs(sum('cost') - r.hourlyRate.cost) < 1e-6);
  });

  it('build time: falls back to in_progress time (flagged); under a minute is too short', () => {
    const ds = deriveCards([card('f', T0, 30, null, 3), card('s', T0, 5), card('r', T0, 5)], END);
    const r = estimatesFrom(
      ds,
      new Map([
        ['f', 6],
        ['s', 1],
        ['r', 1],
      ]),
      new Map(),
      { ...opts, buildMs: new Map([['s', 30_000], ['r', 2 * HOUR]]) },
    );
    const by = new Map(r.perception.cards.map((p) => [p.id, p]));
    assert.deepEqual([by.get('f')!.buildSource, by.get('f')!.buildHours, by.get('f')!.ratio], ['in_progress', 3, 0.5]);
    assert.deepEqual([by.get('s')!.buildSource, by.get('s')!.ratio], ['runs', null]);
    assert.deepEqual([r.perception.tooShort, r.perception.fallbacks], [1, 1]);
    assert.equal(r.perception.medianRatio, (0.5 + 2) / 2); // s is out
    assert.deepEqual(r.perception.topMisses.map((p) => p.id).sort(), ['f', 'r']);
  });

  it('byAgent without runs: a card\'s spend counts to its assignee, most hours first', () => {
    const ds = deriveCards(
      [card('a', T0, 4, 'Ada'), card('b', T0, 2, 'Bram'), card('c', T0, 6, 'Ada'), card('d', T0, 3, 'Bram'), card('e', T0, 1)],
      END,
    );
    const r = estimatesFrom(
      ds,
      new Map([
        ['a', 2],
        ['b', 8],
        ['c', 6],
        ['d', 5], // no spend: left out, as in the overall rate
        ['e', 1],
      ]),
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 3],
        ['e', 0.5],
      ]),
      opts,
    );
    assert.deepEqual(r.hourlyRate.byAgent, [
      { agent: 'Ada', cards: 2, estimateHours: 8, cost: 4, hoursPerDollar: 2 },
      { agent: 'Bram', cards: 1, estimateHours: 8, cost: 2, hoursPerDollar: 4 },
      { agent: null, cards: 1, estimateHours: 1, cost: 0.5, hoursPerDollar: 2 },
    ]);
    // the per-agent parts add up to the overall rate's basis
    assert.equal(r.hourlyRate.byAgent.reduce((s, a) => s + a.cards, 0), r.hourlyRate.cards);
  });

  it('no build time at all (no runs, no in_progress time) has no ratio and is not a miss', () => {
    const r = estimatesFrom(deriveCards([card('z', T0, 0)], END), new Map([['z', 3]]), new Map(), opts);
    assert.deepEqual([r.perception.cards[0].ratio, r.perception.medianRatio, r.perception.topMisses, r.perception.tooShort], [null, null, [], 1]);
    // no runs and no in_progress time: 'none', counted only as tooShort, not as a fallback
    assert.deepEqual([r.perception.cards[0].buildSource, r.perception.fallbacks], ['none', 0]);
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
      recordActivity(db, { project_id: p.id, task_id: a.id, agent, tokens: 1, tokens_out: 0, lines_added: 0, lines_removed: 0, ms: 1.5 * HOUR, usage });
    const r = estimateMetrics(db, { projectIds: [p.id] }, { tz: 'UTC', now: Date.now() });
    assert.deepEqual(r.coverage, { estimated: 1, pct: 0.5 });
    assert.deepEqual([r.hourlyRate.cost, r.hourlyRate.estimateHours, r.hourlyRate.hoursPerDollar, r.hourlyRate.dollarsPerHour], [6, 6, 1, 1]);
    assert.equal(r.perception.cards[0].id, a.id);
    // build time from the runs (2 x 1.5h); spend per run agent
    assert.deepEqual([r.perception.cards[0].buildHours, r.perception.cards[0].buildSource, r.perception.cards[0].ratio], [3, 'runs', 0.5]);
    // spend per run agent ($3 each), the card's 6h split by that share
    assert.deepEqual(
      r.hourlyRate.byAgent.map((x) => [x.agent, x.estimateHours, x.cost]),
      [
        ['builder', 3, 3],
        ['reviewer', 3, 3],
      ],
    );
    db.close();
  });
});
