import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  agenticCostMetrics,
  costAnomaly,
  costPerAgentHour,
  reworkCost,
  roundOfRun,
  unionWaitMs,
  slipDays,
  usageRunway,
  type CostRun,
  type ReviewRecord,
} from './agentic.js';
import { advancePhase, createPhase, createTask, getOrCreateProject, moveTask, raiseBlocker, recordActivity, recordReview, updateTask } from './board.js';
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
  it('no data', () => {
    const r = costAnomaly([], { from: T0, to: T0 + DAY - 1, tz: 'UTC' });
    assert.deepEqual([r.series, r.flagged], [[], []]);
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

    const from = now - DAY;
    const r = agenticCostMetrics(db, { projectIds: [p.id], from, to: now }, { tz: 'UTC', now, project: p.id });
    assert.deepEqual([r.reworkCost.cost, r.reworkCost.totalCost, r.reworkCost.pct, r.reworkCost.runs], [3, 6, 0.5, 1]);
    assert.deepEqual(r.reworkCost.top, [{ id: a.id, title: 'A', cost: 3, tokens: 1_000_000, failedRounds: 1 }]);
    const d = r.decisionLatencyCost;
    assert.equal(d.costPerAgentHour, 3); // $6 over 2 active hours
    // needs_you [-3h, -2h] + [-30m, now] = 1.5h; blocked [-2.5h, now] = 2.5h; overlapping: their union is 3h
    assert.equal(d.needsYouHours, 1.5);
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
    assert.deepEqual(r.usageRunway, { status: 'unavailable', reason: r.usageRunway!.status === 'unavailable' ? r.usageRunway!.reason : '', forecast: r.usageRunway!.forecast });
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
