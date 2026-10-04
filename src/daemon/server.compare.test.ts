import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb, type DB } from '../core/db.js';
import { addDays, dayKey, lastFourWeeksStart, startOfDay } from '../core/metrics.js';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// Period-over-period compare, the workType filter + breakdowns, flow's firstActivityAt and
// task work_type, against the REAL daemon (temp DB, random port). History is seeded through
// the API, then its timestamps are moved into two back-to-back 7-day windows.

const H = 3_600_000;
const D = 24 * H;
const M = 1_000_000;

describe('daemon compare + workType', () => {
  let daemon: TestDaemon | undefined;
  let db: DB | undefined;
  let base: string;
  let pid: string;
  let cur1: string;
  let cur2: string;
  let cur3: string;
  let prev1: string;
  // current window C = [T0, T0 + 7d - 1], previous P = [T0 - 7d, T0 - 1]
  const today = new Date();
  const T0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 14 * D;
  const C = { from: T0, to: T0 + 7 * D - 1 };
  const P = { from: T0 - 7 * D, to: T0 - 1 };
  const STARTED = Date.now() - 60_000;

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await send(method, path, body);
    const b = (await r.json()) as any;
    assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(b)}`);
    return b;
  };
  const get = (path: string) => ok('GET', path);
  const status = async (path: string) => {
    const r = await send('GET', path);
    return { status: r.status, body: (await r.json()) as any };
  };
  const win = (w: { from: number; to: number }) => `from=${w.from}&to=${w.to}`;

  /** Run a card action, then move the events it logged (and the card's times) to `t`. */
  const at = async (id: string, t: number, action: () => Promise<unknown>) => {
    await action();
    db!.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ? AND created_at > ?').run(t, id, STARTED);
    db!.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(t, id);
  };
  const create = async (title: string, t: number, extra: Record<string, unknown> = {}) => {
    const id = (await ok('POST', '/task', { project_id: pid, title, ...extra })).task_id as string;
    db!.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(t, id);
    db!.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(t, t, id);
    return id;
  };
  const move = (id: string, lane: string, t: number) => at(id, t, () => ok('POST', `/task/${id}/move`, { lane }));
  const review = (id: string, verdict: string, t: number) => at(id, t, () => ok('POST', `/task/${id}/review`, { verdict }));
  const block = async (id: string, from: number, to: number) => {
    await at(id, from, () => ok('POST', `/task/${id}/block`, { reason: 'waiting' }));
    await at(id, to, () => ok('POST', `/task/${id}/unblock`, {}));
  };
  const spend = async (id: string, input: number, t: number) => {
    await ok('POST', `/task/${id}/activity`, { agent: 'builder', usage: { 'model-x': { input } } });
    db!.prepare('UPDATE card_activity SET created_at = ? WHERE task_id = ? AND created_at > ?').run(t, id, STARTED);
  };
  const needsYou = (from: number, ms: number) =>
    db!
      .prepare(`INSERT INTO wait_intervals (project_id, kind, started_at, ended_at, closed_by) VALUES (?, 'needs_you', ?, ?, 'idle')`)
      .run(pid, from, from + ms);

  before(async () => {
    daemon = await startDaemon({ env: { KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    base = daemon.base;
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    pid = (await get(`/project?root=${encodeURIComponent(root)}`)).project_id;
    db = openDb(join(daemon.dbDir, 'board.db'));
    await ok('PUT', '/settings/prices', { models: {}, default: { input: 1, output: 1, cache_read: 1, cache_creation: 1 } });

    // previous window: unclassified, blocked 2h, fail then pass (2 rounds, 1 rework); lead 2d, cycle 1d
    prev1 = await create('prev1', T0 - 6 * D);
    await block(prev1, T0 - 6 * D + H, T0 - 6 * D + 3 * H);
    await move(prev1, 'in_progress', T0 - 5 * D);
    await move(prev1, 'in_review', T0 - 5 * D + H);
    await review(prev1, 'fail', T0 - 5 * D + 2 * H);
    await move(prev1, 'in_progress', T0 - 5 * D + 3 * H);
    await move(prev1, 'in_review', T0 - 5 * D + 4 * H);
    await review(prev1, 'pass', T0 - 5 * D + 5 * H);
    await move(prev1, 'done', T0 - 4 * D);
    await spend(prev1, M, T0 - 5 * D); // $1

    // current window: a feature (pass first time; lead 2d, cycle 1d) ...
    cur1 = await create('cur1', T0 + D, { work_type: 'feature' });
    await move(cur1, 'in_progress', T0 + 2 * D);
    await move(cur1, 'in_review', T0 + 2 * D + H);
    await review(cur1, 'pass', T0 + 2 * D + 2 * H);
    await move(cur1, 'done', T0 + 3 * D);
    await spend(cur1, 2 * M, T0 + 2 * D); // $2
    // ... a defect (blocked 1h, no review; lead 4d, cycle 3d) ...
    cur2 = await create('cur2', T0 + D, { work_type: 'defect' });
    await move(cur2, 'in_progress', T0 + 2 * D);
    await block(cur2, T0 + 2 * D + H, T0 + 2 * D + 2 * H);
    await move(cur2, 'done', T0 + 5 * D);
    await spend(cur2, 3 * M, T0 + 3 * D); // $3
    // ... and debt still in progress
    cur3 = await create('cur3', T0 + 2 * D, { work_type: 'debt' });
    await move(cur3, 'in_progress', T0 + 3 * D);
    // ... and a feature that spent $4, then was deleted (its runs still count)
    const gone = await create('gone', T0 + 2 * D, { work_type: 'feature' });
    await spend(gone, 4 * M, T0 + 4 * D);
    await ok('DELETE', `/task/${gone}`);

    needsYou(T0 - 3 * D, 10 * 60_000);
    needsYou(T0 - 2 * D, 20 * 60_000);
    needsYou(T0 + D, 30 * 60_000);
  });

  after(async () => {
    db?.close();
    await daemon?.stop();
  });

  it('flow: previous headline block + windows; byte-identical without compare', async () => {
    const plain = await (await send('GET', `/metrics/flow?project=${pid}&tz=UTC&${win(C)}`)).text();
    const r = await get(`/metrics/flow?project=${pid}&tz=UTC&${win(C)}&compare=previous`);
    const { previous, window, previousWindow, ...rest } = r;
    assert.equal(JSON.stringify(rest), plain, 'the current result is unchanged');
    assert.ok(!('previous' in JSON.parse(plain)) && !('window' in JSON.parse(plain)));
    assert.deepEqual(window, C);
    assert.deepEqual(previousWindow, P);
    assert.equal(r.throughput.total, 2);
    assert.deepEqual([r.cycleTime.p50, r.cycleTime.p85, r.leadTime.p50, r.leadTime.p85], [D, 3 * D, 2 * D, 4 * D]);
    assert.deepEqual(previous, { throughput: 1, cycleTime: { p50: D, p85: D }, leadTime: { p50: 2 * D, p85: 2 * D } });
    // an explicit window gives the same block
    const explicit = await get(`/metrics/flow?project=${pid}&tz=UTC&${win(C)}&compare=${P.from},${P.to}`);
    assert.deepEqual(explicit.previous, previous);
    assert.deepEqual(explicit.previousWindow, P);
  });

  it('summary: throughput sum, cycle p50/p85, WIP', async () => {
    const r = await get(`/metrics/summary?project=${pid}&tz=UTC&${win(C)}&compare=previous`);
    assert.deepEqual(r.window, C);
    assert.deepEqual(r.previousWindow, P);
    assert.deepEqual(r.previous, {
      throughput: 1,
      cycleTime: { p50: D, p85: D },
      wip: { backlog: 0, queued: 0, in_progress: 0, in_review: 0 },
    });
    assert.equal(r.wip.in_progress, 1);
    const prev = await get(`/metrics/summary?project=${pid}&tz=UTC&${win(P)}`);
    assert.equal(prev.throughput.reduce((n: number, w: any) => n + w.count, 0), 1);
  });

  it('summary: compare runs over the actual (4 ISO week) range; previous is the 4 weeks before', async () => {
    const sum = (r: any) => r.throughput.reduce((n: number, w: any) => n + w.count, 0);
    const check = async (q: string, to: number) => {
      const r = await get(`/metrics/summary?project=${pid}&tz=UTC&${q}&compare=previous`);
      const start = lastFourWeeksStart(to, 'UTC');
      assert.equal(r.range.from, start, q);
      assert.deepEqual(r.window, { from: start, to }, q);
      assert.deepEqual(r.previousWindow, { from: start - 28 * D, to: start - 1 }, q);
      const prev = await get(`/metrics/summary?project=${pid}&tz=UTC&from=${start - 28 * D}&to=${start - 1}`);
      assert.equal(r.previous.throughput, sum(prev), q);
      assert.deepEqual(r.previous.cycleTime, { p50: prev.cycleTime.p50, p85: prev.cycleTime.p85 }, q);
      return r;
    };
    const old = await check(`from=${T0 - 60 * D}&to=${C.to}`, C.to); // from older than 4 weeks: clamped
    assert.equal(sum(old), 3);
    await check(`to=${C.to}`, C.to); // only to: still the 4-week range
    // no from / to at all: the 4 weeks to now (summary is never all time)
    const now = await get(`/metrics/summary?project=${pid}&tz=UTC&compare=previous`);
    assert.ok(now.previous && now.window.from === now.range.from);
    assert.equal(now.previousWindow.to, now.window.from - 1);
  });

  it('quality: firstPassRate, avgRounds, rework', async () => {
    const r = await get(`/metrics/quality?project=${pid}&tz=UTC&${win(C)}&compare=previous`);
    assert.deepEqual([r.totals.firstPassRate, r.totals.avgRounds, r.totals.rework], [1, 1, 0]);
    assert.deepEqual(r.previous, { firstPassRate: 0, avgRounds: 2, rework: 1 });
    assert.deepEqual(r.previousWindow, P);
  });

  it('cost: previous totals; byWorkType incl. none and deleted', async () => {
    const r = await get(`/metrics/cost?project=${pid}&tz=UTC&${win(C)}&compare=previous`);
    assert.deepEqual(r.totals, { cost: 9, tokens: 9 * M, runs: 3, cards: 3 });
    assert.deepEqual(r.previous, { totals: { cost: 1, tokens: M, runs: 1, cards: 1 } }, 'no all-time medianCardCost');
    assert.deepEqual(r.byWorkType, [
      { workType: 'feature', cost: 2, cards: 1 },
      { workType: 'defect', cost: 3, cards: 1 },
      { workType: 'debt', cost: 0, cards: 0 },
      { workType: 'risk', cost: 0, cards: 0 },
      { workType: 'none', cost: 0, cards: 0 },
      { workType: 'deleted', cost: 4, cards: 1 },
    ]);
    assert.equal(r.byWorkType.reduce((n: number, x: any) => n + x.cost, 0), r.totals.cost, 'sums to totals');
    const all = await get(`/metrics/cost?project=${pid}&tz=UTC`);
    assert.deepEqual(all.byWorkType.find((x: any) => x.workType === 'none'), { workType: 'none', cost: 1, cards: 1 });
    assert.ok(!('previous' in all));
    // workType=none is unclassified EXISTING cards: the deleted card's runs are not in it
    assert.deepEqual((await get(`/metrics/cost?project=${pid}&tz=UTC&workType=none`)).totals, { cost: 1, tokens: M, runs: 1, cards: 1 });
    assert.equal((await get(`/metrics/cost?project=${pid}&tz=UTC&workType=feature`)).totals.cost, 2);
  });

  it('wait: needsYou + blocked count/totalMs/p50', async () => {
    const r = await get(`/metrics/wait?project=${pid}&tz=UTC&${win(C)}&compare=previous`);
    assert.deepEqual([r.needsYou.count, r.needsYou.totalMs, r.blocked.count, r.blocked.totalMs], [1, 30 * 60_000, 1, H]);
    assert.deepEqual(r.previous, {
      needsYou: { count: 2, totalMs: 30 * 60_000, p50: 10 * 60_000 },
      blocked: { count: 1, totalMs: 2 * H, p50: 2 * H },
    });
  });

  it('report: the metrics block; default range compares too', async () => {
    const r = await get(`/report?project=${pid}&tz=UTC&${win(C)}&compare=previous`);
    const prev = await get(`/report?project=${pid}&tz=UTC&${win(P)}`);
    assert.equal(r.metrics.throughput, 2);
    assert.equal(r.previous.throughput, 1);
    const m = prev.metrics;
    assert.deepEqual(r.previous, {
      throughput: m.throughput,
      cycle_time: m.cycle_time,
      first_pass: m.first_pass,
      waiting_on_you: { total_ms: m.waiting_on_you.total_ms, count: m.waiting_on_you.count },
      cost: { total_usd: m.cost.total_usd, runs: m.cost.runs },
    });
    assert.deepEqual(r.previous.waiting_on_you, { total_ms: 30 * 60_000, count: 2 });
    assert.deepEqual(r.previousWindow, P);
    // default range: previous = the 7 calendar days before it, in the request tz (DST-safe)
    for (const tz of ['UTC', 'America/New_York']) {
      const def = await get(`/report?project=${pid}&tz=${encodeURIComponent(tz)}&compare=previous`);
      assert.ok(def.previous, 'the default 7-day range is a window, not all time');
      assert.equal(def.window.from, def.range.from);
      const fromDay = dayKey(def.range.from, tz);
      assert.equal(def.previousWindow.from, startOfDay(addDays(fromDay, -7), tz), tz);
      assert.equal(def.previousWindow.to, def.window.from - 1, tz);
      assert.equal(dayKey(def.previousWindow.from, tz), addDays(fromDay, -7), tz);
    }
    assert.ok(!('previous' in (await get(`/report?project=${pid}&tz=UTC`))));
  });

  it('all time → previous null; invalid compare → 400', async () => {
    for (const path of ['/metrics/flow', '/metrics/quality', '/metrics/cost', '/metrics/wait']) {
      const r = await get(`${path}?project=${pid}&tz=UTC&compare=previous`);
      assert.equal(r.previous, null, path);
      assert.equal(r.window, null, path);
      assert.equal(r.previousWindow, null, path);
      assert.equal((await get(`${path}?project=${pid}&tz=UTC&compare=${P.from},${P.to}`)).previous, null, `${path} explicit`);
      assert.equal((await get(`${path}?project=${pid}&tz=UTC&to=${C.to}&compare=previous`)).previous, null, `${path} only to`);
    }
    for (const path of ['/metrics/flow', '/metrics/summary', '/metrics/quality', '/metrics/cost', '/metrics/wait']) {
      for (const bad of ['bogus', `${P.to},${P.from}`, '', '1,2,3', 'x,y']) {
        const res = await status(`${path}?project=${pid}&tz=UTC&${win(C)}&compare=${bad}`);
        assert.equal(res.status, 400, `${path} compare=${bad}`);
        assert.match(res.body.error, /invalid compare/);
      }
    }
    assert.equal((await status(`/report?project=${pid}&tz=UTC&compare=nope`)).status, 400);
  });

  it('workType filter on metrics and card-filter routes; unknown → 400', async () => {
    const flow = (q: string) => get(`/metrics/flow?project=${pid}&tz=UTC&${win(C)}&${q}`);
    assert.equal((await flow('workType=feature')).throughput.total, 1);
    assert.equal((await flow('workType=risk')).throughput.total, 0);
    assert.equal((await get(`/metrics/flow?project=${pid}&tz=UTC&${win(P)}&workType=none`)).throughput.total, 1);
    assert.equal((await get(`/metrics/summary?project=${pid}&tz=UTC&${win(C)}&workType=debt`)).wip.in_progress, 1);
    assert.equal((await get(`/metrics/quality?project=${pid}&tz=UTC&workType=none`)).totals.reviewed, 1);
    assert.equal((await get(`/metrics/cost?project=${pid}&tz=UTC&workType=defect`)).totals.cost, 3);
    assert.equal((await get(`/metrics/cost?project=${pid}&tz=UTC&workType=none`)).totals.cost, 1);
    const ws = await get(`/workspace/cards?project=${pid}&workType=feature`);
    assert.ok(JSON.stringify(ws).includes(cur1) && !JSON.stringify(ws).includes(cur2));
    assert.ok(JSON.stringify(await get(`/workspace/cards?project=${pid}&workType=none`)).includes(prev1));
    for (const path of ['/metrics/flow', '/metrics/summary', '/metrics/quality', '/metrics/cost', '/metrics/forecast', '/workspace/summary', '/workspace/cards', '/home']) {
      const res = await status(`${path}?project=${pid}&tz=UTC&workType=chore`);
      assert.equal(res.status, 400, path);
      assert.match(res.body.error, /invalid workType/);
    }
    for (const path of ['/metrics/schedule', '/metrics/usage-burn']) {
      const res = await status(`${path}?project=${pid}&tz=UTC&workType=feature`);
      assert.equal(res.status, 400, path);
      assert.equal(res.body.error, `workType isn't supported on ${path}`);
    }
    // wait + report don't filter by it yet, but don't reject it either
    for (const path of ['/metrics/wait', '/report']) assert.equal((await status(`${path}?project=${pid}&tz=UTC&workType=feature`)).status, 200, path);
  });

  it('workType applies to forecast and burn', async () => {
    const fc = (q: string) => get(`/metrics/forecast?project=${pid}&tz=UTC&${q}`);
    assert.equal((await fc('workType=debt')).remaining, 1);
    assert.equal((await fc('workType=feature')).remaining, 0);
    assert.equal((await fc('workType=feature')).samples.done, 1);
    assert.equal((await fc('workType=none')).samples.done, 1);
    const phase = (await ok('POST', '/phase', { project_id: pid, title: 'Burn' })).phase_id;
    const x = (await ok('POST', '/task', { project_id: pid, title: 'bx', phase_id: phase, work_type: 'feature' })).task_id;
    await ok('POST', '/task', { project_id: pid, title: 'by', phase_id: phase, work_type: 'risk' });
    await ok('POST', `/task/${x}/move`, { lane: 'done' });
    const burn = (q: string) => get(`/metrics/burn?project=${pid}&tz=UTC&phase=${phase}${q}`);
    const [all, feat, risk] = [await burn(''), await burn('&workType=feature'), await burn('&workType=risk')];
    assert.deepEqual([all.scope, all.done], [2, 1]);
    assert.deepEqual([feat.scope, feat.done], [1, 1]);
    assert.deepEqual([risk.scope, risk.done], [1, 0]);
    assert.equal((await status(`/metrics/burn?project=${pid}&tz=UTC&phase=${phase}&workType=chore`)).status, 400);
  });

  it('flow: throughputByWorkType incl. none; firstActivityAt', async () => {
    const c = await get(`/metrics/flow?project=${pid}&tz=UTC&${win(C)}`);
    assert.deepEqual(c.throughputByWorkType, { feature: 1, defect: 1, debt: 0, risk: 0, none: 0 });
    const p = await get(`/metrics/flow?project=${pid}&tz=UTC&${win(P)}`);
    assert.deepEqual(p.throughputByWorkType, { feature: 0, defect: 0, debt: 0, risk: 0, none: 1 });
    assert.equal(c.firstActivityAt, T0 - 6 * D, 'scope-wide, not the window');
    assert.equal((await get(`/metrics/flow?project=${pid}&tz=UTC&workType=feature`)).firstActivityAt, T0 + D);
    assert.equal((await get(`/metrics/flow?project=${pid}&tz=UTC&tag=nope`)).firstActivityAt, null, 'empty scope');
  });

  it('task work_type: POST/PATCH accept + validate; task JSON carries it', async () => {
    const id = (await ok('POST', '/task', { project_id: pid, title: 'typed', work_type: 'risk' })).task_id;
    assert.equal((await get(`/task/${id}`)).work_type, 'risk');
    const card = (await get(`/board?project=${pid}`)) as any;
    assert.ok(JSON.stringify(card).includes('"work_type":"risk"'));
    const bad = await send('POST', '/task', { project_id: pid, title: 'x', work_type: 'chore' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as any).error, /invalid work_type/);
    await ok('PATCH', `/task/${id}`, { work_type: 'debt' });
    assert.equal((await get(`/task/${id}`)).work_type, 'debt');
    const badPatch = await send('PATCH', `/task/${id}`, { work_type: 'chore' });
    assert.equal(badPatch.status, 400);
    assert.equal((await get(`/task/${id}`)).work_type, 'debt');
    await ok('PATCH', `/task/${id}`, { work_type: null });
    assert.equal((await get(`/task/${id}`)).work_type, null);
    assert.equal((await get(`/task/${cur3}`)).work_type, 'debt');
  });
});
