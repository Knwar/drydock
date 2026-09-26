import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// End-to-end coverage for GET /metrics/flow, /metrics/burn and /metrics/summary
// against the REAL daemon (temp DB, random port).

describe('daemon GET /metrics/*', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  let wsId: string;
  let apiId: string;
  let emptyId: string;
  let phaseId: string;
  let emptyPhaseId: string;
  let a: string;
  let b: string;
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const project = async (root: string) =>
    ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string }).project_id;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as any };
  };
  const ok = async (path: string) => {
    const r = await get(path);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const task = async (project_id: string, title: string, extra: Record<string, unknown> = {}) => {
    const res = await send('POST', '/task', { project_id, title, ...extra });
    return ((await res.json()) as { task_id: string }).task_id;
  };
  const move = (id: string, lane: string) => send('POST', `/task/${id}/move`, { lane });

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
    const wsRoot = join(daemon.dbDir, 'ws');
    mkdirSync(join(wsRoot, 'api'), { recursive: true });
    mkdirSync(join(daemon.dbDir, 'empty'), { recursive: true });
    wsId = await project(wsRoot);
    emptyId = await project(join(daemon.dbDir, 'empty'));
    const v = await send('POST', '/vertical', { workspace_id: wsId, name: 'api', root: join(wsRoot, 'api') });
    apiId = ((await v.json()) as { project_id: string }).project_id;
    phaseId = ((await (await send('POST', '/phase', { project_id: wsId, title: 'P1' })).json()) as { phase_id: string }).phase_id;
    emptyPhaseId = ((await (await send('POST', '/phase', { project_id: emptyId, title: 'E' })).json()) as { phase_id: string })
      .phase_id;

    // A: workspace, in the phase, tag ui, assigned to alice, done
    a = await task(wsId, 'A', { tag: 'ui', phase_id: phaseId });
    await send('PATCH', `/task/${a}`, { assigned_agent: 'alice', worktree_path: '.trees/a', branch: 'card/a' });
    await move(a, 'in_review');
    await move(a, 'done');
    // B: vertical, tag api, in progress
    b = await task(apiId, 'B', { tag: 'api' });
    await move(b, 'in_progress');
    // C: workspace, in the phase, still in backlog
    await task(wsId, 'C', { phase_id: phaseId, tag: 'ui' });
  });

  after(async () => {
    await daemon?.stop();
  });

  it('flow: a workspace expands to its verticals; shape and counts', async () => {
    const f = await ok(`/metrics/flow?project=${wsId}&tz=UTC`);
    assert.equal(f.cards, 3);
    assert.equal(f.partial, 0);
    assert.equal(f.range.tz, 'UTC');
    assert.ok(f.range.days >= 1 && f.range.days <= 2); // 2 only if the run straddles UTC midnight
    assert.equal(f.throughput.total, 1);
    assert.equal(f.throughput.weekly.reduce((n: number, w: any) => n + w.count, 0), 1);
    assert.match(f.throughput.weekly[0].week, /^\d{4}-W\d\d$/);
    assert.equal(f.throughput.daily.length, f.range.days);
    assert.deepEqual(Object.keys(f.points[0]).sort(), ['cycleTimeMs', 'doneAt', 'id', 'leadTimeMs', 'title']);
    assert.equal(f.points[0].id, a);
    assert.equal(f.cycleTime.count, 1);
    assert.equal(f.leadTime.count, 1);
    assert.ok(f.cycleTime.p50 >= 0 && f.cycleTime.p85 >= 0 && f.cycleTime.p95 >= 0);
    const { date, ...lanes } = f.cfd[f.cfd.length - 1];
    assert.match(date, /^\d{4}-\d\d-\d\d$/);
    assert.deepEqual(lanes, { backlog: 1, queued: 0, in_progress: 1, in_review: 0, done: 1 });

    // the vertical alone
    assert.equal((await ok(`/metrics/flow?project=${apiId}`)).cards, 1);
  });

  it('flow: phase, tag, agent and date filters apply', async () => {
    const f = (q: string) => ok(`/metrics/flow?project=${wsId}&${q}`);
    assert.equal((await f(`phase=${phaseId}`)).cards, 2);
    assert.equal((await f('tag=api')).cards, 1);
    assert.equal((await f('tag=ui')).throughput.total, 1);
    const alice = await f('agent=alice');
    assert.equal(alice.cards, 1);
    assert.equal(alice.points[0].id, a);
    assert.equal((await f('agent=nobody')).cards, 0);
    // every card was created today: a window ending 30 days ago has none
    const old = Date.now() - 30 * 86_400_000;
    const past = await f(`from=${old - 86_400_000}&to=${old}&tz=UTC`);
    assert.equal(past.cards, 0);
    assert.equal(past.throughput.total, 0);
    assert.equal(past.range.days, 2);
    // a bare local day is accepted
    const today = new Date().toISOString().slice(0, 10);
    assert.equal((await f(`from=2020-01-01&to=${today}&tz=UTC`)).throughput.daily, null);
  });

  it('flow: empty project is zero-filled', async () => {
    const f = await ok(`/metrics/flow?project=${emptyId}`);
    assert.equal(f.cards, 0);
    assert.deepEqual(f.points, []);
    assert.deepEqual(f.cycleTime, { p50: null, p85: null, p95: null, count: 0 });
    assert.equal(f.throughput.total, 0);
    assert.equal(f.cfd.length, f.range.days);
  });

  it('burn: scope and done for a phase; empty phase', async () => {
    const burn = await ok(`/metrics/burn?project=${wsId}&phase=${phaseId}&tz=UTC`);
    assert.deepEqual(burn.phase, { id: phaseId, title: 'P1', status: 'planned' });
    assert.equal(burn.scope, 2);
    assert.equal(burn.done, 1);
    assert.equal(burn.approximated, 0);
    assert.deepEqual(Object.keys(burn.series[0]).sort(), ['date', 'done', 'remaining', 'scope']);
    assert.equal(burn.series[burn.series.length - 1].remaining, 1);
    const empty = await ok(`/metrics/burn?project=${emptyId}&phase=${emptyPhaseId}`);
    assert.equal(empty.scope, 0);
    assert.ok(empty.series.every((s: any) => s.scope === 0));
  });

  it('summary: compact shape', async () => {
    const s = await ok(`/metrics/summary?project=${wsId}&tz=UTC`);
    assert.deepEqual(Object.keys(s).sort(), ['cards', 'cycleTime', 'oldestInFlight', 'partial', 'range', 'throughput', 'wip']);
    assert.ok(s.throughput.length <= 4 && s.throughput.length >= 1);
    assert.equal(s.throughput.reduce((n: number, w: any) => n + w.count, 0), 1);
    assert.equal(s.cycleTime.count, 1);
    assert.deepEqual(s.wip, { backlog: 1, queued: 0, in_progress: 1, in_review: 0 });
    assert.equal(s.oldestInFlight.id, b);
    assert.equal(s.oldestInFlight.lane, 'in_progress');
  });

  it('bad params → 400, unknown project / phase → 404', async () => {
    const bad = async (path: string, status: number, re: RegExp) => {
      const r = await get(path);
      assert.equal(r.status, status, `${path}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, re);
    };
    await bad('/metrics/flow', 400, /project required/);
    await bad('/metrics/flow?project=nope', 404, /unknown project/);
    await bad(`/metrics/flow?project=${wsId}&tz=Mars/Olympus`, 400, /invalid tz/);
    await bad(`/metrics/flow?project=${wsId}&from=soon`, 400, /invalid from/);
    await bad(`/metrics/flow?project=${wsId}&to=2026-02-31`, 400, /invalid to/);
    await bad(`/metrics/flow?project=${wsId}&from=2000&to=1000`, 400, /from must be <= to/);
    await bad(`/metrics/flow?project=${wsId}&from=0`, 400, /range too long/);
    await bad(`/metrics/burn?project=${wsId}`, 400, /phase required/);
    await bad(`/metrics/burn?project=${wsId}&phase=nope`, 404, /unknown phase/);
    await bad(`/metrics/burn?project=${wsId}&phase=${emptyPhaseId}`, 400, /not on this project/);
    await bad(`/metrics/summary?project=${wsId}&tz=nope`, 400, /invalid tz/);
  });
});
