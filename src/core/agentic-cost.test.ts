import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  agenticCostMetrics,
  costAnomaly,
  costPerAgentHour,
  reworkCost,
  roundOfRun,
  combineSlips,
  forecastReasonText,
  unionWaitMs,
  slipDays,
  usageRunway,
  type CostRun,
  type ReviewRecord,
} from './agentic.js';
import { advancePhase, createPhase, createTask, createVertical, getOrCreateProject, moveTask, raiseBlocker, recordActivity, recordReview, updateTask } from './board.js';
import { withPrevious } from './compare.js';
import { openDb } from './db.js';
import { usageBurn, type ForecastInfo, type UsageSample } from './usage-burn.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 1); // Mon 2026-06-01

let rid = 0;
const run = (task_id: string, created_at: number, cost: number, over: Partial<CostRun> = {}): CostRun => ({
  id: ++rid,
  task_id,
  title: task_id.toUpperCase(),
  phase_id: null,
  agent: 'builder',
  cost,
  tokens: cost * 1000,
  ms: HOUR,
  created_at,
  ...over,
});
const rev = (task_id: string, round: number, verdict: string, created_at: number): ReviewRecord => ({ task_id, round, verdict, created_at });

describe('reworkCost', () => {
  it('attributes each run to the first review at or after it; only failed rounds are rework', () => {
    const reviews = new Map([
      ['a', [rev('a', 1, 'fail', T0 + 10), rev('a', 2, 'pass', T0 + 20)]],
      ['b', [rev('b', 1, 'fail', T0 + 10), rev('b', 2, 'fail', T0 + 20)]],
    ]);
    assert.equal(roundOfRun({ created_at: T0 + 10 }, reviews.get('a')!)?.round, 1, 'a run at the review instant is in that round');
    assert.equal(roundOfRun({ created_at: T0 + 30 }, reviews.get('a')!), null, 'after the last review: no round');
    const r = reworkCost(
      [
        run('a', T0 + 1, 2), // round 1 (fail): rework
        run('a', T0 + 9, 1), // round 1 (fail; e.g. the reviewer's run): rework
        run('a', T0 + 15, 4), // round 2 (pass)
        run('a', T0 + 25, 8), // after the last review: no round
        run('b', T0 + 5, 3), // round 1 (fail)
        run('b', T0 + 15, 3), // round 2 (fail)
        run('c', T0 + 5, 1), // never reviewed
      ],
      reviews,
    );
    assert.deepEqual(
      { ...r, pct: Math.round(r.pct! * 1000) / 1000 },
      {
        cost: 9,
        tokens: 9000,
        runs: 4,
        pct: Math.round((9 / 22) * 1000) / 1000,
        totalCost: 22,
        top: [
          { id: 'b', title: 'B', cost: 6, tokens: 6000, failedRounds: 2 },
          { id: 'a', title: 'A', cost: 3, tokens: 3000, failedRounds: 1 },
        ],
      },
    );
  });

  it('top 5 only; no data gives zeros and a null pct', () => {
    const reviews = new Map(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, [rev(id, 1, 'fail', T0 + 10)]]));
    const r = reworkCost(['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => run(id, T0, i + 1)), reviews);
    assert.deepEqual(r.top.map((c) => c.id), ['f', 'e', 'd', 'c', 'b']);
    assert.deepEqual(reworkCost([], new Map()), { cost: 0, tokens: 0, runs: 0, pct: null, totalCost: 0, top: [] });
  });
});

describe('costPerAgentHour', () => {
  it('median over agents of spend / active hours; agents without run time are skipped', () => {
    assert.equal(
      costPerAgentHour([
        run('a', T0, 10, { agent: 'x', ms: HOUR }), // 10/h
        run('a', T0, 10, { agent: 'x', ms: HOUR }), // x: 20 over 2h = 10/h
        run('a', T0, 30, { agent: 'y', ms: HOUR }), // 30/h
        run('a', T0, 5, { agent: 'z', ms: 2 * HOUR }), // 2.5/h
        run('a', T0, 99, { agent: 'w', ms: 0 }), // no run time
      ]),
      10,
    );
    assert.equal(costPerAgentHour([run('a', T0, 4, { agent: 'x' }), run('a', T0, 8, { agent: 'y' })]), 6, 'even count: the mean of the middle two');
    assert.equal(costPerAgentHour([]), null);
    // a run without a recorded duration counts in neither the spend nor the hours
    assert.equal(costPerAgentHour([run('a', T0, 6, { agent: 'x', ms: 2 * HOUR }), run('a', T0, 100, { agent: 'x', ms: 0 })]), 3);
    assert.equal(costPerAgentHour([run('a', T0, 100, { agent: 'x', ms: 0 })]), null);
  });
});

describe('unionWaitMs', () => {
  it('overlapping intervals on a board count once; boards add up; clipped to the window, open ones run to now', () => {
    const win = { from: T0, to: T0 + 10 * HOUR, now: T0 + 8 * HOUR };
    assert.equal(
      unionWaitMs(
        [
          { project_id: 'p', from: T0 + HOUR, to: T0 + 3 * HOUR },
          { project_id: 'p', from: T0 + 2 * HOUR, to: T0 + 4 * HOUR }, // overlaps: p = 1h..4h
          { project_id: 'p', from: T0 + 6 * HOUR, to: null }, // open: to now (8h)
          { project_id: 'q', from: T0 + 2 * HOUR, to: T0 + 3 * HOUR }, // another board: adds
          { project_id: 'q', from: T0 - 5 * HOUR, to: T0 + HOUR / 2 }, // clipped at from
          { project_id: 'q', from: T0 - 5 * HOUR, to: T0 - HOUR }, // outside
        ],
        win,
      ),
      3 * HOUR + 2 * HOUR + HOUR + HOUR / 2,
    );
    assert.equal(unionWaitMs([], win), 0);
  });
});

describe('slipDays', () => {
  const phase = { id: 'P', title: 'Phase' };
  const card = (id: string, lane: string, depends_on: string[] = []) => ({ id, title: id, lane, depends_on });
  it('critical path: the longest depends_on chain', () => {
    const s = slipDays(
      phase,
      [card('a', 'done'), card('b', 'in_progress', ['a']), card('c', 'queued', ['b']), card('x', 'in_progress')],
      [
        { task_id: 'a', from: T0, to: T0 + DAY },
        { task_id: 'c', from: T0 + 5 * DAY, to: null }, // open: runs to now
        { task_id: 'x', from: T0, to: T0 + 9 * DAY }, // not on the path
      ],
      T0 + 6 * DAY,
    );
    assert.deepEqual([s.basis, s.approximation, s.days, s.reason], ['critical_path', false, 2, null]);
    assert.deepEqual(s.cards.map((c) => [c.id, c.blockedMs]), [
      ['a', DAY],
      ['b', 0],
      ['c', DAY],
    ]);
  });
  it('no chain: in-flight cards, flagged as an approximation', () => {
    const s = slipDays(phase, [card('a', 'done'), card('b', 'in_review'), card('c', 'backlog')], [
      { task_id: 'a', from: T0, to: T0 + DAY },
      { task_id: 'b', from: T0, to: T0 + DAY / 2 },
    ], T0 + DAY);
    assert.deepEqual([s.basis, s.approximation, s.days], ['in_flight', true, 0.5]);
    assert.match(s.reason!, /no critical path/);
  });
  it('no active phase / no cards', () => {
    assert.deepEqual(slipDays(null, [], [], T0), { phase: null, basis: null, approximation: false, cards: [], blockedMs: 0, days: 0, reason: 'no active phase' });
    assert.deepEqual([slipDays(phase, [], [], T0).days, slipDays(phase, [], [], T0).approximation], [0, true]);
  });
});

describe('costAnomaly', () => {
  const at = (day: number, h = 12) => T0 + day * DAY + h * HOUR;
  it('flags a day over the trailing 14-day mean + 2 sigma', () => {
    // phase P: 1, 2 alternating for the 14 days before the window, 1.5 on its 1st day, a 10 spike on its 2nd
    const runs = [];
    for (let d = 0; d < 14; d++) runs.push({ phase_id: 'P', cost: d % 2 ? 2 : 1, created_at: at(d) });
    runs.push({ phase_id: 'P', cost: 1.5, created_at: at(14) });
    runs.push({ phase_id: 'P', cost: 10, created_at: at(15) });
    const r = costAnomaly(runs, { from: T0 + 14 * DAY, to: T0 + 16 * DAY - 1, tz: 'UTC', phaseTitles: new Map([['P', 'Phase']]) });
    assert.deepEqual(r.range, { from: '2026-06-15', to: '2026-06-16', trailingFrom: '2026-06-01' });
    assert.equal(r.series.length, 1);
    assert.equal(r.series[0].days.length, 16);
    assert.equal(r.flagged.length, 1);
    const f = r.flagged[0];
    assert.deepEqual([f.date, f.phase_id, f.title, f.spend], ['2026-06-16', 'P', 'Phase', 10]);
    // trailing = days 1..14: seven 2s, six 1s and the 1.5
    const trail = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((d): number => (d % 2 ? 2 : 1)).concat(1.5);
    const mean = trail.reduce((a, v) => a + v, 0) / 14;
    const sigma = Math.sqrt(trail.reduce((a, v) => a + (v - mean) ** 2, 0) / 14);
    assert.ok(Math.abs(f.mean - mean) < 1e-6);
    assert.ok(Math.abs(f.sigma - sigma) < 1e-6);
    // the 1.5 day itself sits inside mean + 2 sigma: not flagged
  });
  it('needs >= 5 trailing days of data (from the phase\'s first spend)', () => {
    const runs = [0, 1, 2, 3].map((d) => ({ phase_id: 'P', cost: 1, created_at: at(10 + d) }));
    runs.push({ phase_id: 'P', cost: 50, created_at: at(14) }); // only 4 trailing days of data
    assert.equal(costAnomaly(runs, { from: T0 + 14 * DAY, to: T0 + 15 * DAY - 1, tz: 'UTC' }).flagged.length, 0);
    runs.unshift({ phase_id: 'P', cost: 1, created_at: at(9) }); // now 5
    assert.equal(costAnomaly(runs, { from: T0 + 14 * DAY, to: T0 + 15 * DAY - 1, tz: 'UTC' }).flagged.length, 1);
  });
  it('a flat-zero baseline never flags; the first spend is searched over all history', () => {
    // first spend 30 days before the window, then idle: 14 zero trailing days of data
    const runs = [
      { phase_id: 'P', cost: 1, created_at: at(-16) },
      { phase_id: 'P', cost: 5, created_at: at(14) },
    ];
    const opts = { from: T0 + 14 * DAY, to: T0 + 15 * DAY - 1, tz: 'UTC' };
    assert.equal(costAnomaly(runs, opts).flagged.length, 0, 'all-zero trailing days');
    // one non-zero trailing day: an anomaly against a known baseline
    runs.push({ phase_id: 'P', cost: 0.5, created_at: at(5) });
    const r = costAnomaly(runs, opts);
    assert.equal(r.flagged.length, 1);
    assert.equal(r.flagged[0].spend, 5);
  });
  it('judges the board total: a small phase\'s occasional spend no longer floods the flags', () => {
    // phase Big spends ~10/day; phase Tiny spends 0.5 on a few scattered days
    const runs = [];
    for (let d = 0; d < 28; d++) runs.push({ phase_id: 'Big', cost: d % 2 ? 10.4 : 9.6, created_at: at(d) });
    for (const d of [3, 16, 20, 24]) runs.push({ phase_id: 'Tiny', cost: 0.5, created_at: at(d) });
    const r = costAnomaly(runs, { from: T0 + 14 * DAY, to: T0 + 28 * DAY - 1, tz: 'UTC' });
    assert.equal(r.basis, 'board_total');
    assert.deepEqual(r.flagged, [], 'Tiny on its own would flag every spend day; the total never stands out');
    assert.equal(r.total.length, 28);
    assert.equal(r.total[16].spend, 9.6 + 0.5);
    assert.deepEqual(r.series.map((x) => x.phase_id).sort(), ['Big', 'Tiny']);
  });
  it('a flagged day names its top phase and every phase\'s amount', () => {
    const runs = [];
    for (let d = 0; d < 14; d++) runs.push({ phase_id: 'A', cost: d % 2 ? 2 : 1, created_at: at(d) });
    runs.push({ phase_id: 'A', cost: 1, created_at: at(14) }, { phase_id: 'B', cost: 9, created_at: at(14) });
    const r = costAnomaly(runs, { from: T0 + 14 * DAY, to: T0 + 15 * DAY - 1, tz: 'UTC', phaseTitles: new Map([['B', 'Bee']]) });
    assert.equal(r.flagged.length, 1);
    const f = r.flagged[0];
    assert.deepEqual([f.spend, f.phase_id, f.title, f.phaseSpend], [10, 'B', 'Bee', 9]);
    assert.deepEqual(f.byPhase, [
      { phase_id: 'B', title: 'Bee', spend: 9 },
      { phase_id: 'A', title: null, spend: 1 },
    ]);
    assert.equal(f.excess, 10 - 1.5);
  });
  it('the $ floor: over mean + 2 sigma but under max($1, 25% of the mean) is not flagged', () => {
    // a near-constant 0.20/day baseline: sigma ~0, so 0.30 is "over 2 sigma" but only 10 cents over
    const runs = [];
    for (let d = 0; d < 14; d++) runs.push({ phase_id: 'P', cost: 0.2, created_at: at(d) });
    runs.push({ phase_id: 'P', cost: 0.3, created_at: at(14) });
    const opts = { from: T0 + 14 * DAY, to: T0 + 15 * DAY - 1, tz: 'UTC' };
    const r = costAnomaly(runs, opts);
    assert.deepEqual([r.flagged.length, r.minExcess, r.minExcessPct], [0, 1, 0.25]);
    // 25% of a large mean: 100/day baseline, 110 is over 2 sigma (sigma 0) but under the 25 floor
    const big = [];
    for (let d = 0; d < 14; d++) big.push({ phase_id: 'P', cost: 100, created_at: at(d) });
    big.push({ phase_id: 'P', cost: 110, created_at: at(14) });
    assert.equal(costAnomaly(big, opts).flagged.length, 0);
    big[14] = { phase_id: 'P', cost: 126, created_at: at(14) };
    assert.equal(costAnomaly(big, opts).flagged.length, 1);
  });
  it('judgedDays: days with enough trailing data; the rule is exposed', () => {
    const runs = [0, 1, 2, 3].map((d) => ({ phase_id: 'P', cost: 1, created_at: at(10 + d) }));
    const opts = { from: T0 + 14 * DAY, to: T0 + 16 * DAY - 1, tz: 'UTC' };
    // day 14 has 4 trailing days of data, day 15 has 5
    const r = costAnomaly(runs, opts);
    assert.deepEqual([r.judgedDays, r.trailingDays, r.minDays, r.sigmas], [1, 14, 5, 2]);
    assert.equal(costAnomaly(runs, { ...opts, to: T0 + 15 * DAY - 1 }).judgedDays, 0);
  });
  it('a phase with old history that restarted spending 3 days before the window end is judged', () => {
    // first spend 60 days before the window, idle since, spending again on the window's last 3 days
    const runs = [{ phase_id: 'P', cost: 1, created_at: at(-46) }];
    for (const d of [25, 26, 27]) runs.push({ phase_id: 'P', cost: 2, created_at: at(d) });
    const r = costAnomaly(runs, { from: T0 + 14 * DAY, to: T0 + 28 * DAY - 1, tz: 'UTC' });
    // every in-range day has 14 trailing days of real (zero) data: all 14 judged (not "needs history")
    assert.equal(r.judgedDays, 14);
    // the first restarted day sits on a flat-zero baseline (not flagged); the next two stand out against it
    assert.deepEqual(r.flagged.map((f) => f.date), ['2026-06-27', '2026-06-28']);
  });
  it('no data', () => {
    const r = costAnomaly([], { from: T0, to: T0 + DAY - 1, tz: 'UTC' });
    assert.deepEqual([r.series, r.flagged, r.judgedDays], [[], [], 0]);
  });
});

describe('usageRunway', () => {
  const now = T0 + 12 * HOUR;
  const samples: UsageSample[] = [
    { at: now - HOUR, five_hour: { used: 60, resetsAt: now + 3 * HOUR }, seven_day: { used: 50, resetsAt: now + 6 * DAY } },
    { at: now, five_hour: { used: 80, resetsAt: now + 3 * HOUR }, seven_day: { used: 60, resetsAt: now + 6 * DAY } },
  ];
  const ok = (p85: string): ForecastInfo => ({
    status: 'ok',
    phase: { id: 'P', title: 'P' },
    p50: { days: 3, date: '2026-06-04' },
    p85: { days: 10, date: p85 },
  });
  it('weekly runs out before p85, with the gap in days', () => {
    const info = ok('2026-06-11');
    const r = usageRunway(usageBurn(samples, info, { tz: 'UTC', now }), info, 'UTC', now);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.weekly!.state, 'projected'); // 10%/h: 100% 4 hours on (2026-06-01)
    assert.equal(r.fiveHour!.state, 'projected');
    assert.deepEqual([r.weeklyBeforeP85, r.gapDays], [true, 10]);
  });
  it('weekly resets first → null; no forecast → null; no samples → unavailable', () => {
    const slow: UsageSample[] = [
      { at: now - 2 * HOUR, five_hour: null, seven_day: { used: 10, resetsAt: now + DAY } },
      { at: now, five_hour: null, seven_day: { used: 10.1, resetsAt: now + DAY } },
    ];
    const info = ok('2026-06-11');
    const r = usageRunway(usageBurn(slow, info, { tz: 'UTC', now }), info, 'UTC', now);
    assert.deepEqual(r.status === 'ok' && [r.weekly!.state, r.weeklyBeforeP85, r.gapDays], ['resets_first', null, null]);
    const none: ForecastInfo = { status: 'no_phase', phase: null, reason: 'the project has no active phase' };
    const n = usageRunway(usageBurn(samples, none, { tz: 'UTC', now }), none, 'UTC', now);
    assert.deepEqual(n.status === 'ok' && [n.weeklyBeforeP85, n.gapDays], [null, null]);
    const u = usageRunway(usageBurn([], none, { tz: 'UTC', now }), none, 'UTC', now);
    assert.equal(u.status, 'unavailable');
    assert.ok(u.status === 'unavailable' && u.reasonText.length > 0);
    assert.equal(u.forecast?.reasonText, 'No active phase to forecast');
    assert.equal(n.status === 'ok' && n.forecast?.reasonText, 'No active phase to forecast');
  });

  it('reasonText beside a forecast reason code', () => {
    assert.equal(forecastReasonText('too_few_done'), 'Needs ≥ 5 done cards to forecast');
    assert.equal(forecastReasonText('too_few_days'), 'Needs ≥ 10 days of history to forecast');
    assert.match(forecastReasonText('no_throughput'), /No cards done yet/);
    const info: ForecastInfo = { status: 'insufficient_history', phase: { id: 'P', title: 'P' }, reason: 'too_few_done' };
    const r = usageRunway(usageBurn(samples, info, { tz: 'UTC', now }), info, 'UTC', now);
    assert.deepEqual(r.status === 'ok' && [r.forecast?.status !== 'ok' && r.forecast?.reason, r.forecast?.reasonText], ['too_few_done', 'Needs ≥ 5 done cards to forecast']);
    // an ok forecast carries no reasonText
    const okInfo = ok('2026-06-11');
    const o = usageRunway(usageBurn(samples, okInfo, { tz: 'UTC', now }), okInfo, 'UTC', now);
    assert.equal(o.status === 'ok' && o.forecast?.reasonText, undefined);
  });
});

describe('combineSlips', () => {
  const phase = (id: string) => ({ id, title: id });
  const card = (id: string, lane: string, depends_on: string[] = []) => ({ id, title: id, lane, depends_on });
  it('sums blocked time over the phases; basis mixed when they differ; the first phase leads', () => {
    const ws = { ...slipDays(phase('W'), [card('a', 'done'), card('b', 'queued', ['a'])], [{ task_id: 'b', from: 0, to: DAY }], DAY), project_id: 'ws' };
    const v = { ...slipDays(phase('V'), [card('c', 'in_progress')], [{ task_id: 'c', from: 0, to: DAY / 2 }], DAY), project_id: 'v' };
    const s = combineSlips([ws, v], 'workspace+verticals');
    assert.deepEqual([s.scope, s.phase?.id, s.basis, s.approximation, s.days], ['workspace+verticals', 'W', 'mixed', true, 1.5]);
    assert.deepEqual(s.phases.map((p) => [p.project_id, p.days]), [
      ['ws', 1],
      ['v', 0.5],
    ]);
    assert.deepEqual(s.cards.map((c) => c.id), ['a', 'b', 'c']);
    const none = combineSlips([], 'board');
    assert.deepEqual([none.phase, none.reason, none.phases, none.scope], [null, 'no active phase', [], 'board']);
  });
});

describe('agenticCostMetrics (DB)', () => {
  const sonnet = (input: number) => ({ 'claude-sonnet-5': { input, output: 0, cache_read: 0, cache_creation: 0 } });

  it('loads, prices and attributes; live parts only when live; compare via withPrevious', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-cost-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDb();
    const p = getOrCreateProject(db, dir);
    const phase = createPhase(db, p.id, 'P1');
    advancePhase(db, p.id);
    const a = createTask(db, p.id, 'A', { phase_id: phase.id });
    const b = createTask(db, p.id, 'B', { phase_id: phase.id, depends_on: [a.id] });
    updateTask(db, b.id, { depends_on: [a.id] });
    moveTask(db, a.id, 'in_progress');
    moveTask(db, b.id, 'in_progress');
    raiseBlocker(db, b.id, 'which db?');
    const act = (task: string, input: number, ms: number) =>
      recordActivity(db, { project_id: p.id, task_id: task, agent: 'builder', tokens: input, tokens_out: 0, lines_added: 0, lines_removed: 0, ms, usage: sonnet(input) });
    act(a.id, 1_000_000, HOUR); // $3, before the fail
    recordReview(db, a.id, 'fail');
    act(a.id, 1_000_000, HOUR); // $3, before the pass
    recordReview(db, a.id, 'pass');
    const now = Date.now();
    // place the runs and reviews: run1 → fail → run2 → pass, all within the last day
    const ids = (db.prepare('SELECT id FROM card_activity ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    db.prepare('UPDATE card_activity SET created_at = ? WHERE id = ?').run(now - 4 * HOUR, ids[0]);
    db.prepare('UPDATE card_activity SET created_at = ? WHERE id = ?').run(now - 2 * HOUR, ids[1]);
    db.prepare("UPDATE reviews SET created_at = ? WHERE verdict = 'fail'").run(now - 3 * HOUR);
    db.prepare("UPDATE reviews SET created_at = ? WHERE verdict = 'pass'").run(now - HOUR);
    // b was blocked 2.5 hours ago (and its earlier history before that)
    db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = ? AND type != 'block'").run(now - 3 * HOUR, b.id);
    db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = ? AND type = 'block'").run(now - 2.5 * HOUR, b.id);
    db.prepare('UPDATE tasks SET created_at = ?, blocked_at = ? WHERE id = ?').run(now - 3 * HOUR, now - 2.5 * HOUR, b.id);
    db.prepare(
      "INSERT INTO wait_intervals (project_id, agent_id, task_id, kind, started_at, ended_at, reason, closed_by) VALUES (?, 'orchestrator', ?, 'needs_you', ?, ?, 'permission', 'working')",
    ).run(p.id, a.id, now - 3 * HOUR, now - 2 * HOUR);
    db.prepare(
      "INSERT INTO wait_intervals (project_id, agent_id, task_id, kind, started_at, ended_at, reason, closed_by) VALUES (?, 'orchestrator', ?, 'needs_you', ?, NULL, 'question', NULL)",
    ).run(p.id, a.id, now - 30 * 60_000);
    // a second needs_you wait overlapping the first on the same board
    db.prepare(
      "INSERT INTO wait_intervals (project_id, agent_id, task_id, kind, started_at, ended_at, reason, closed_by) VALUES (?, 'sub', ?, 'needs_you', ?, ?, 'permission', 'working')",
    ).run(p.id, a.id, now - 2.5 * HOUR, now - 1.75 * HOUR);

    const from = now - DAY;
    const r = agenticCostMetrics(db, { projectIds: [p.id], from, to: now }, { tz: 'UTC', now, project: p.id });
    assert.deepEqual([r.reworkCost.cost, r.reworkCost.totalCost, r.reworkCost.pct, r.reworkCost.runs], [3, 6, 0.5, 1]);
    assert.deepEqual(r.reworkCost.top, [{ id: a.id, title: 'A', cost: 3, tokens: 1_000_000, failedRounds: 1 }]);
    const d = r.decisionLatencyCost;
    assert.equal(d.costPerAgentHour, 3); // $6 over 2 active hours
    // needs_you [-3h, -2h] ∪ [-2.5h, -1.75h] ∪ [-30m, now] = 1.75h (overlap counted once);
    // blocked [-2.5h, now] = 2.5h; both kinds together: [-3h, now] = 3h
    assert.equal(d.needsYouHours, 1.75);
    assert.ok(d.needsYouHours <= d.humanWaitHours && d.blockedHours <= d.humanWaitHours, 'no part exceeds the total');
    assert.equal(d.blockedHours, 2.5);
    assert.equal(d.humanWaitHours, 3);
    assert.equal(d.idleCost, 9);
    assert.equal(d.slip!.basis, 'critical_path');
    assert.deepEqual(d.slip!.cards.map((c) => c.id), [a.id, b.id]);
    // oldest first: the blocker (2.5h) before the open needs_you (30m)
    assert.deepEqual(d.queue!.map((q) => [q.kind, q.task_id]), [
      ['blocker', b.id],
      ['needs_you', a.id],
    ]);
    assert.equal(d.queue![1].title, 'A');
    assert.equal(r.costAnomaly.series.length, 1);
    assert.equal(r.usageRunway!.status, 'unavailable');
    assert.ok(r.usageRunway!.status === 'unavailable' && r.usageRunway!.reasonText.length > 0);
    assert.equal(r.usageRunway!.forecast?.phase?.id, phase.id);

    // the daemon's usage samples feed the runway
    const samples: UsageSample[] = [{ at: now, five_hour: { used: 40, resetsAt: now + HOUR }, seven_day: { used: 30, resetsAt: now + 3 * DAY } }];
    const live = agenticCostMetrics(db, { projectIds: [p.id], from, to: now }, { tz: 'UTC', now, project: p.id, samples });
    assert.equal(live.usageRunway!.status, 'ok');

    const prev = agenticCostMetrics(db, { projectIds: [p.id], from, to: now }, { tz: 'UTC', now, project: p.id, live: false });
    assert.deepEqual([prev.decisionLatencyCost.slip, prev.decisionLatencyCost.queue, prev.usageRunway], [null, null, null]);

    const filter = { projectIds: [p.id], from, to: now };
    const c = withPrevious(
      filter,
      (f) => agenticCostMetrics(db, f, { tz: 'UTC', now, project: p.id, live: f === filter }),
      (x) => ({ rework: x.reworkCost.cost, wait: x.decisionLatencyCost.humanWaitHours }),
      { now },
    );
    assert.equal(c.reworkCost.cost, 3);
    assert.deepEqual(c.previous, { rework: 0, wait: 0 });
    db.close();
  });

  it('slip on a workspace covers its verticals\' active phases', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-cost-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'web'));
    const db = openDb();
    const ws = getOrCreateProject(db, dir);
    const web = createVertical(db, ws.id, 'web', join(dir, 'web'));
    createPhase(db, ws.id, 'WS phase');
    advancePhase(db, ws.id);
    const vp = createPhase(db, web.id, 'Web phase');
    advancePhase(db, web.id);
    const c = createTask(db, web.id, 'Blocked on web', { phase_id: vp.id });
    moveTask(db, c.id, 'in_progress');
    raiseBlocker(db, c.id, 'q');
    const now = Date.now();
    db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = ? AND type = 'block'").run(now - DAY, c.id);
    db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = ? AND type != 'block'").run(now - 2 * DAY, c.id);
    db.prepare('UPDATE tasks SET created_at = ?, blocked_at = ? WHERE id = ?').run(now - 2 * DAY, now - DAY, c.id);
    const slip = agenticCostMetrics(db, { projectIds: [ws.id] }, { tz: 'UTC', now, project: ws.id }).decisionLatencyCost.slip!;
    assert.equal(slip.scope, 'workspace+verticals');
    assert.deepEqual(slip.phases.map((p) => [p.project_id, p.phase?.title]), [
      [ws.id, 'WS phase'],
      [web.id, 'Web phase'],
    ]);
    assert.equal(slip.phase?.title, 'WS phase');
    assert.ok(Math.abs(slip.days - 1) < 1e-3, `${slip.days}`);
    // the vertical on its own: its phase only
    const own = agenticCostMetrics(db, { projectIds: [web.id] }, { tz: 'UTC', now, project: web.id }).decisionLatencyCost.slip!;
    assert.deepEqual([own.scope, own.phases.length, own.phase?.title], ['board', 1, 'Web phase']);
    db.close();
  });

  it('an empty board', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-cost-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDb();
    const p = getOrCreateProject(db, dir);
    const now = Date.now();
    const r = agenticCostMetrics(db, { projectIds: [p.id] }, { tz: 'UTC', now, project: p.id });
    assert.deepEqual(r.reworkCost, { cost: 0, tokens: 0, runs: 0, pct: null, totalCost: 0, top: [] });
    assert.deepEqual(
      [r.decisionLatencyCost.humanWaitHours, r.decisionLatencyCost.costPerAgentHour, r.decisionLatencyCost.idleCost, r.decisionLatencyCost.queue],
      [0, null, null, []],
    );
    assert.equal(r.decisionLatencyCost.slip!.reason, 'no active phase');
    assert.deepEqual([r.costAnomaly.series, r.costAnomaly.flagged], [[], []]);
    assert.equal(r.usageRunway!.status, 'unavailable');
    db.close();
  });
});
