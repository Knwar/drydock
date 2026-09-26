import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPhase, createTask, getOrCreateProject, moveTask } from './board.js';
import { openDb, type DB } from './db.js';
import {
  boundedRuns,
  computeForecast,
  forecast,
  intParam,
  MAX_DAYS,
  mulberry32,
  simulate,
  throughputSamples,
} from './forecast.js';
import { MetricsParamError, startOfDay } from './metrics.js';

const DAY = 86_400_000;
const tz = 'UTC';
const now = Date.UTC(2026, 8, 26, 12); // 2026-09-26 12:00 UTC
// n done cards per day on each of the `days` days before today (noon), board created `days` days ago
const history = (perDay: number[]) => {
  const doneAts: number[] = [];
  perDay.forEach((n, i) => {
    for (let k = 0; k < n; k++) doneAts.push(now - (perDay.length - i) * DAY);
  });
  return { doneAts, firstAt: now - perDay.length * DAY };
};

describe('mulberry32 / simulate', () => {
  it('is deterministic for a seed and uniform in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
    assert.ok(xs.every((x) => x >= 0 && x < 1));
    assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, mulberry32(43)));
  });

  it('zero remaining: every run takes 0 days', () => {
    const r = simulate([1, 2], 0, { runs: 100, seed: 1 });
    assert.equal(r.hist[0], 100);
    assert.equal(r.capped, 0);
  });

  it('constant throughput is exact: 10 cards at 2/day = 5 days', () => {
    const r = simulate([2, 2, 2], 10, { runs: 500, seed: 7 });
    assert.equal(r.hist[5], 500);
  });

  it('skipping zero days matches the mean of day-by-day sampling', () => {
    // mean throughput 0.5/day -> ~2 days per card -> ~40 days for 20 cards
    const r = simulate([0, 0, 0, 2], 20, { runs: 5000, seed: 3 });
    let sum = 0;
    r.hist.forEach((c, d) => (sum += c * d));
    const mean = sum / r.runs;
    assert.ok(mean > 36 && mean < 44, `mean ${mean}`);
  });

  it('caps a run at maxDays and counts it', () => {
    const r = simulate([0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 1000, { runs: 200, seed: 9, maxDays: 50 });
    assert.equal(r.capped, 200);
    assert.equal(r.hist[50], 200);
    assert.equal(r.hist.length, 51);
  });

  it('bounds runs by remaining x days', () => {
    assert.equal(boundedRuns(10_000, 300), 10_000);
    assert.ok(boundedRuns(10_000, 5000) < 10_000);
    assert.equal(boundedRuns(10_000, 1_000_000), Math.floor(5_000_000 / MAX_DAYS)); // per-run cost <= MAX_DAYS
    assert.equal(boundedRuns(10_000, 1_000_000, 100_000), 1000); // never below MIN_RUNS
  });
});

describe('throughputSamples', () => {
  it('uses the window ending yesterday, from the first card, calendar days', () => {
    const { samples, history } = throughputSamples([now - DAY, now - DAY, now - 3 * DAY, now], now - 20 * DAY, { tz, now });
    assert.equal(history.days, 20);
    assert.equal(history.from, '2026-09-06');
    assert.equal(history.to, '2026-09-25');
    assert.equal(history.done, 3); // today's done card is not a sample
    assert.equal(samples[19], 2);
    assert.equal(samples[17], 1);
  });

  it('caps the window at `weeks`', () => {
    const { history } = throughputSamples([], now - 400 * DAY, { tz, now, weeks: 2 });
    assert.equal(history.days, 14);
  });

  it('no cards: no samples', () => {
    assert.equal(throughputSamples([], null, { tz, now }).history.days, 0);
  });
});

describe('computeForecast', () => {
  const steady = history([1, 0, 2, 1, 0, 3, 1, 1, 0, 2, 1, 1, 0, 2]);

  it('deterministic with a fixed seed', () => {
    const a = computeForecast(steady.doneAts, steady.firstAt, 30, { tz, now, seed: 1234 });
    const b = computeForecast(steady.doneAts, steady.firstAt, 30, { tz, now, seed: 1234 });
    assert.deepEqual(a, b);
    assert.equal(a.status, 'ok');
    if (a.status !== 'ok') return;
    assert.equal(a.seed, 1234);
    assert.equal(a.runs, 10_000);
    assert.equal(a.method, 'monte-carlo');
    assert.deepEqual(a.samples, { days: 14, done: 15, from: '2026-09-12', to: '2026-09-25' });
    assert.equal(a.histogram.reduce((n, h) => n + h.count, 0), 10_000);
  });

  it('percentiles are ordered and dates are today + days', () => {
    const f = computeForecast(steady.doneAts, steady.firstAt, 30, { tz, now, seed: 5 });
    assert.equal(f.status, 'ok');
    if (f.status !== 'ok') return;
    assert.ok(f.p50.days <= f.p85.days && f.p85.days <= f.p95.days);
    assert.ok(f.p50.days > 0);
    const date = (d: number) => new Date(startOfDay('2026-09-26', tz) + d * DAY).toISOString().slice(0, 10);
    assert.equal(f.p50.date, date(f.p50.days));
    assert.equal(f.p95.date, date(f.p95.days));
    // ~1.07 cards/day -> ~28 days for 30 cards
    assert.ok(f.p50.days > 20 && f.p50.days < 36, `p50 ${f.p50.days}`);
  });

  it('zero remaining: done today, even without history', () => {
    const f = computeForecast([], null, 0, { tz, now, seed: 1 });
    assert.equal(f.status, 'ok');
    if (f.status !== 'ok') return;
    assert.deepEqual(f.p50, { days: 0, date: '2026-09-26' });
    assert.deepEqual(f.p95, { days: 0, date: '2026-09-26' });
    assert.deepEqual(f.histogram, [{ days: 0, count: 10_000 }]);
  });

  it('insufficient history: too few days, too few done, no throughput', () => {
    const short = history([3, 3, 3]);
    const a = computeForecast(short.doneAts, short.firstAt, 5, { tz, now });
    assert.equal(a.status, 'insufficient_history');
    if (a.status !== 'insufficient_history') return;
    assert.equal(a.reason, 'too_few_days');
    assert.deepEqual(a.have, { days: 3, done: 9 });
    assert.deepEqual(a.need, { days: 10, done: 5 });
    assert.equal(a.remaining, 5);

    const sparse = history([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    const b = computeForecast(sparse.doneAts, sparse.firstAt, 5, { tz, now });
    assert.equal(b.status === 'insufficient_history' && b.reason, 'too_few_done');

    const zeros = history(new Array(30).fill(0));
    const c = computeForecast(zeros.doneAts, zeros.firstAt, 5, { tz, now });
    assert.equal(c.status === 'insufficient_history' && c.reason, 'no_throughput');
    assert.deepEqual(c.status === 'insufficient_history' && c.have, { days: 30, done: 0 });
  });

  it('a mostly-zero history hits the run-length cap instead of looping', () => {
    const rare = history([1, 1, 1, 1, 1, ...new Array(37).fill(0)]);
    const f = computeForecast(rare.doneAts, rare.firstAt, 500, { tz, now, seed: 2, maxDays: 365 });
    assert.equal(f.status, 'ok');
    if (f.status !== 'ok') return;
    assert.ok(f.capped > 0);
    assert.equal(f.p95.days, 365);
    assert.equal(f.histogram.at(-1)!.days, 365);
    assert.equal(MAX_DAYS, 3650);
  });

  it('10k runs x 300 remaining finishes well under 200ms', () => {
    const h = history(Array.from({ length: 42 }, (_, i) => (i % 3 === 0 ? 0 : (i % 4) + 1)));
    const worst = history([1, 1, 1, 1, 1, ...new Array(37).fill(0)]); // rare throughput: long runs
    for (const [src, remaining] of [
      [h, 300],
      [worst, 300],
      [worst, 5000],
    ] as const) {
      computeForecast(src.doneAts, src.firstAt, remaining, { tz, now, seed: 1 }); // warm up
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const f = computeForecast(src.doneAts, src.firstAt, remaining, { tz, now, seed: 1 });
        times.push(performance.now() - t0);
        assert.equal(f.status, 'ok');
      }
      const ms = times.sort((a, b) => a - b)[1]; // median of 3: robust to one noisy run under a loaded suite
      assert.ok(ms < 150, `${remaining} remaining took ${ms.toFixed(1)}ms`);
    }
  });
});

describe('forecast (DB)', () => {
  // shift a card's whole history `days` back
  const backdate = (db: DB, id: string, days: number) => {
    db.prepare('UPDATE tasks SET created_at = created_at - ?, updated_at = updated_at - ? WHERE id = ?').run(days * DAY, days * DAY, id);
    db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(days * DAY, id);
  };

  const seed = () => {
    const db = openDb();
    const p = getOrCreateProject(db, '/tmp/forecast-p', 'p');
    const phase = createPhase(db, p.id, 'P1');
    for (let i = 0; i < 12; i++) {
      const t = createTask(db, p.id, `done ${i}`, { tag: i % 2 ? 'ui' : 'api' });
      moveTask(db, t.id, 'done');
      backdate(db, t.id, 1 + i);
    }
    const open = ['a', 'b', 'c'].map((title) => createTask(db, p.id, title, { phase_id: phase.id, tag: 'ui' }));
    createTask(db, p.id, 'loose', { tag: 'api' });
    return { db, p, phase, open };
  };

  it('board, phase and plan targets count their own remaining; history is the scope', () => {
    const { db, p, phase, open } = seed();
    const opts = { tz, now: Date.now(), seed: 1 };
    const boardF = forecast(db, { projectId: p.id }, { kind: 'board' }, opts);
    assert.equal(boardF.status, 'ok');
    assert.equal(boardF.remaining, 4);
    assert.equal(boardF.status === 'ok' && boardF.samples.done, 12);
    assert.equal(forecast(db, { projectId: p.id }, { kind: 'phase', phaseId: phase.id }, opts).remaining, 3);
    const plan = forecast(db, { projectId: p.id }, { kind: 'plan', cardIds: [open[0].id, 'gone'] }, opts);
    assert.equal(plan.remaining, 1);
    const ui = forecast(db, { projectId: p.id, tag: 'ui' }, { kind: 'board' }, opts);
    assert.equal(ui.remaining, 3);
    assert.equal(ui.samples.done, 6);
  });
});

describe('intParam', () => {
  it('parses bounded integers, rejects the rest', () => {
    assert.equal(intParam(null, 'weeks', 2, 52), undefined);
    assert.equal(intParam('6', 'weeks', 2, 52), 6);
    for (const bad of ['1', '53', '2.5', '-3', 'x', '1e1']) {
      assert.throws(() => intParam(bad, 'weeks', 2, 52), MetricsParamError);
    }
  });
});
