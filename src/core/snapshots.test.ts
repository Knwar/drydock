import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPhase, createTask, getOrCreateProject, moveTask, setPhaseBudget, setPhaseTarget } from './board.js';
import { openDb, type DB } from './db.js';
import { costMetrics } from './cost.js';
import { createRisk } from './decisions.js';
import { createMilestone, updateMilestone } from './milestones.js';
import { deltasSince, getHistory, takeSnapshots } from './snapshots.js';
import type { PhaseSnapshot } from './types.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1, 12);
const opts = { tz: 'UTC', now: NOW };

/** `n` cards done on `board`, one a day over the last n days (forecast history). */
function history(db: DB, board: string, n: number) {
  for (let i = 0; i < n; i++) {
    const c = createTask(db, board, `d${i}`);
    moveTask(db, c.id, 'done');
    const at = NOW - (i + 1) * DAY;
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(at - 1000, at, c.id);
    db.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(at, c.id);
  }
}

function setup(db: DB) {
  const p = getOrCreateProject(db, '/tmp/snap', 'S');
  history(db, p.id, 14);
  const a = createPhase(db, p.id, 'A');
  const b = createPhase(db, p.id, 'B');
  const cards = [0, 1, 2].map((i) => createTask(db, p.id, `a${i}`, { phase_id: a.id }));
  moveTask(db, cards[0].id, 'done');
  createTask(db, p.id, 'b0', { phase_id: b.id });
  setPhaseTarget(db, a.id, '2027-01-01');
  setPhaseBudget(db, a.id, 50);
  return { p, a, b, cards };
}

const rows = (db: DB) => db.prepare('SELECT * FROM phase_snapshots ORDER BY phase_id, date').all() as PhaseSnapshot[];

function seed(db: DB, projectId: string, phaseId: string, date: string, patch: Partial<PhaseSnapshot>) {
  const r: PhaseSnapshot = {
    project_id: projectId,
    phase_id: phaseId,
    date,
    target_date: null,
    p50: null,
    p85: null,
    p95: null,
    scope: null,
    done: null,
    budget_usd: null,
    spend_usd: null,
    open_risk_score: null,
    rag: null,
    created_at: 0,
    ...patch,
  };
  db.prepare(
    `INSERT INTO phase_snapshots VALUES (@project_id, @phase_id, @date, @target_date, @p50, @p85, @p95, @scope, @done, @budget_usd, @spend_usd, @open_risk_score, @rag, @created_at)`,
  ).run(r);
}

describe('takeSnapshots', () => {
  it('one row per phase per day, with forecast, scope, budget, spend and rag; milestones too', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const { p, a, b, cards } = setup(db);
    db.prepare(`INSERT INTO card_activity (project_id, task_id, usage, created_at) VALUES (?, ?, ?, ?)`).run(
      p.id,
      cards[1].id,
      JSON.stringify({ 'claude-opus-4': { input: 1_000_000, output: 100_000, cache_read: 0, cache_creation: 0 } }),
      NOW - DAY,
    );
    createMilestone(db, { project_id: p.id, title: 'Beta', date: '2026-11-01', phase_id: a.id });
    createMilestone(db, { project_id: p.id, title: 'Loose', date: '2026-12-01' });

    assert.deepEqual(takeSnapshots(db, p.id, '2026-10-01', opts), { phases: 2, milestones: 2 });
    assert.deepEqual(takeSnapshots(db, p.id, '2026-10-02', opts), { phases: 2, milestones: 2 });
    const all = rows(db);
    assert.equal(all.length, 4);
    const ra = all.find((r) => r.phase_id === a.id && r.date === '2026-10-01')!;
    assert.equal(ra.project_id, p.id);
    assert.equal(ra.target_date, '2027-01-01');
    assert.deepEqual([ra.scope, ra.done, ra.budget_usd], [3, 1, 50]);
    assert.ok(ra.p50 && ra.p85 && ra.p95 && ra.p50 <= ra.p85 && ra.p85 <= ra.p95, 'p50 <= p85 <= p95');
    const spend = costMetrics(db, { projectIds: [p.id] }, opts).budgets.find((x) => x.phase_id === a.id)!.actual;
    assert.ok(spend > 0);
    assert.equal(ra.spend_usd, spend);
    assert.equal(ra.rag, 'green');
    const rb = all.find((r) => r.phase_id === b.id && r.date === '2026-10-01')!;
    assert.deepEqual([rb.target_date, rb.p50, rb.p95, rb.rag, rb.spend_usd, rb.budget_usd], [null, null, null, null, 0, null]);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM milestone_snapshots').get() as { n: number }).n, 4);
  });

  it('defaults the date to today (local) and is deterministic', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const { p } = setup(db);
    takeSnapshots(db, p.id, undefined, opts);
    assert.deepEqual([...new Set(rows(db).map((r) => r.date))], ['2026-10-01']);
    const first = rows(db).map(({ created_at: _, ...r }) => r);
    takeSnapshots(db, p.id, undefined, { ...opts, now: NOW + 1 });
    assert.deepEqual(rows(db).map(({ created_at: _, ...r }) => r), first, 'same seed, same numbers');
  });

  it('is idempotent: the same date overwrites that day', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const { p, a } = setup(db);
    createMilestone(db, { project_id: p.id, title: 'M', date: '2026-11-01', phase_id: a.id });
    takeSnapshots(db, p.id, '2026-10-01', opts);
    createTask(db, p.id, 'more', { phase_id: a.id });
    setPhaseBudget(db, a.id, 80);
    const m = getHistory(db, p.id).milestones[0];
    updateMilestone(db, m.milestone_id, { date: '2026-11-10' });
    takeSnapshots(db, p.id, '2026-10-01', opts);
    const all = rows(db);
    assert.equal(all.length, 2);
    const ra = all.find((r) => r.phase_id === a.id)!;
    assert.deepEqual([ra.scope, ra.budget_usd], [4, 80]);
    assert.deepEqual(getHistory(db, p.id).milestones[0].series, [{ date: '2026-10-01', milestone_date: '2026-11-10' }]);
  });

  it('rag reuses report.ts: an open blocker turns green amber; late is red', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const { p, a, b, cards } = setup(db);
    db.prepare('UPDATE tasks SET blocked_at = ? WHERE id = ?').run(NOW, cards[1].id);
    setPhaseTarget(db, b.id, '2026-09-01'); // passed with work left
    takeSnapshots(db, p.id, '2026-10-01', opts);
    const by = new Map(rows(db).map((r) => [r.phase_id, r.rag]));
    assert.equal(by.get(a.id), 'amber');
    assert.equal(by.get(b.id), 'red');
  });

  it('open_risk_score: linked open|mitigating risks; unlinked board risks when the phase has no links', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const { p, a, b, cards } = setup(db);
    const c = createPhase(db, p.id, 'C');
    const phaseLink = (id: string) => [{ target_type: 'phase', target_id: id }];
    createRisk(db, { project_id: p.id, title: 'r1', likelihood: 2, impact: 3, links: phaseLink(a.id) }); // 6
    createRisk(db, { project_id: p.id, title: 'r2', likelihood: 4, impact: 4, status: 'mitigating', links: phaseLink(a.id) }); // 16
    createRisk(db, { project_id: p.id, title: 'r3', likelihood: 5, impact: 5, status: 'closed', links: phaseLink(a.id) }); // ignored
    createRisk(db, { project_id: p.id, title: 'closedOnly', likelihood: 1, impact: 1, status: 'closed', links: phaseLink(c.id) });
    createRisk(db, { project_id: p.id, title: 'u1', likelihood: 1, impact: 2 }); // 2, unlinked
    createRisk(db, { project_id: p.id, title: 'u2', likelihood: 3, impact: 1, status: 'occurred' }); // not open
    createRisk(db, { project_id: p.id, title: 'onCard', likelihood: 3, impact: 3, links: [{ target_type: 'card', target_id: cards[1].id }] }); // linked elsewhere
    const other = getOrCreateProject(db, '/tmp/snap-other', 'O');
    createRisk(db, { project_id: other.id, title: 'elsewhere', likelihood: 5, impact: 5 });
    takeSnapshots(db, p.id, '2026-10-01', opts);
    const by = new Map(rows(db).map((r) => [r.phase_id, r.open_risk_score]));
    assert.equal(by.get(a.id), 22, 'linked open + mitigating, not closed');
    assert.equal(by.get(b.id), 2, 'no links: the board’s unlinked open risks');
    assert.equal(by.get(c.id), 0, 'has links (all closed): no fallback');
  });
});

describe('getHistory', () => {
  it('phase rows ordered by date within the range; milestone series grouped', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const { p, a, b } = setup(db);
    const m1 = createMilestone(db, { project_id: p.id, title: 'M1', date: '2026-11-01', phase_id: a.id });
    const m2 = createMilestone(db, { project_id: p.id, title: 'M2', date: '2026-12-01', phase_id: b.id });
    for (const d of ['2026-10-03', '2026-10-01', '2026-10-02']) {
      if (d === '2026-10-02') updateMilestone(db, m1.id, { date: '2026-11-05' });
      takeSnapshots(db, p.id, d, opts);
    }
    const h = getHistory(db, p.id);
    assert.deepEqual(h.phases.map((r) => r.date), ['2026-10-01', '2026-10-01', '2026-10-02', '2026-10-02', '2026-10-03', '2026-10-03']);
    assert.deepEqual(h.milestones.find((x) => x.milestone_id === m1.id), {
      milestone_id: m1.id,
      title: 'M1',
      series: [
        { date: '2026-10-01', milestone_date: '2026-11-01' },
        { date: '2026-10-02', milestone_date: '2026-11-05' },
        { date: '2026-10-03', milestone_date: '2026-11-01' },
      ],
    });
    const r = getHistory(db, p.id, { from: '2026-10-02', to: '2026-10-02' });
    assert.deepEqual(r.phases.map((x) => x.date), ['2026-10-02', '2026-10-02']);
    assert.ok(r.milestones.every((x) => x.series.length === 1 && x.series[0].date === '2026-10-02'));
    const f = getHistory(db, p.id, { phaseId: a.id, from: '2026-10-02' });
    assert.deepEqual(f.phases.map((x) => [x.phase_id, x.date]), [[a.id, '2026-10-02'], [a.id, '2026-10-03']]);
    assert.deepEqual(f.milestones.map((x) => x.milestone_id), [m1.id]);
    assert.ok(!getHistory(db, p.id, { phaseId: b.id }).milestones.some((x) => x.milestone_id === m1.id));
    assert.deepEqual(getHistory(db, p.id, { phaseId: b.id }).milestones.map((x) => x.milestone_id), [m2.id]);
    const other = getOrCreateProject(db, '/tmp/snap-other', 'O');
    assert.deepEqual(getHistory(db, other.id), { phases: [], milestones: [] });
  });
});

describe('deltasSince', () => {
  it('compares the baseline (first, or earliest on/after since) with the latest snapshot', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const { p, a } = setup(db);
    const m = createMilestone(db, { project_id: p.id, title: 'Beta', date: '2026-11-01', phase_id: a.id });
    const still = createMilestone(db, { project_id: p.id, title: 'Still', date: '2026-11-20', phase_id: a.id });
    const series: [string, Partial<PhaseSnapshot>, string][] = [
      ['2026-09-20', { target_date: '2026-11-01', p85: '2026-10-25', scope: 10, budget_usd: 50, spend_usd: 5, open_risk_score: 4 }, '2026-11-01'],
      ['2026-09-25', { target_date: '2026-11-01', p85: '2026-10-30', scope: 12, budget_usd: 50, spend_usd: 9, open_risk_score: 6 }, '2026-11-03'],
      ['2026-09-28', { target_date: '2026-11-08', p85: '2026-11-04', scope: 15, budget_usd: 80, spend_usd: 20.5, open_risk_score: 1 }, '2026-11-10'],
    ];
    for (const [d, patch, md] of series) {
      seed(db, p.id, a.id, d, patch);
      db.prepare('INSERT INTO milestone_snapshots VALUES (?, ?, ?, ?)').run(m.id, p.id, d, md);
      db.prepare('INSERT INTO milestone_snapshots VALUES (?, ?, ?, ?)').run(still.id, p.id, d, '2026-11-20');
    }
    assert.deepEqual(deltasSince(db, a.id), {
      phase_id: a.id,
      from: '2026-09-20',
      to: '2026-09-28',
      slipDays: { p85: 10, target: 7 },
      scopeChange: { abs: 5, pct: 50 },
      budgetChange: 30,
      spendChange: 15.5,
      riskScoreChange: -3,
      milestoneMoves: [{ id: m.id, title: 'Beta', fromDate: '2026-11-01', toDate: '2026-11-10', days: 9 }],
    });
    const since = deltasSince(db, a.id, '2026-09-22')!; // baseline = 09-25
    assert.equal(since.from, '2026-09-25');
    assert.deepEqual(since.slipDays, { p85: 5, target: 7 });
    assert.deepEqual(since.scopeChange, { abs: 3, pct: 25 });
    assert.equal(since.riskScoreChange, -5);
    assert.deepEqual(since.milestoneMoves.map((x) => [x.fromDate, x.days]), [['2026-11-03', 7]]);
    assert.equal(deltasSince(db, a.id, '2026-10-30'), null, 'nothing on/after since');
    assert.equal(deltasSince(db, 'nope'), null);
  });

  it('null slip when a side has no forecast/target', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const { p, a } = setup(db);
    seed(db, p.id, a.id, '2026-09-20', { p85: null, target_date: '2026-11-01', scope: 0 });
    seed(db, p.id, a.id, '2026-09-21', { p85: '2026-10-10', target_date: '2026-11-01', scope: 2 });
    const d = deltasSince(db, a.id)!;
    assert.deepEqual(d.slipDays, { p85: null, target: 0 });
    assert.deepEqual(d.scopeChange, { abs: 2, pct: null });
    assert.equal(d.budgetChange, null);
  });
});
