import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startDaemon } from './test-daemon.js';

// End-to-end coverage for GET /metrics/quality against the REAL daemon
// (temp DB, random port); reviews go through POST /task/:id/review.

describe('daemon GET /metrics/quality', () => {
  it('totals, breakdowns, filters and 400s', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const base = daemon.base;
    const send = (method: string, path: string, body: unknown) =>
      fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const get = async (path: string) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: (await res.json()) as any };
    };
    const ok = async (path: string) => {
      const r = await get(path);
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const root = join(daemon.dbDir, 'q');
    mkdirSync(root, { recursive: true });
    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const phaseId = ((await (await send('POST', '/phase', { project_id: project, title: 'P1' })).json()) as { phase_id: string })
      .phase_id;
    const task = async (title: string, extra: Record<string, unknown>) => {
      const id = ((await (await send('POST', '/task', { project_id: project, title, ...extra })).json()) as { task_id: string }).task_id;
      await send('PATCH', `/task/${id}`, { assigned_agent: extra.agent });
      return id;
    };
    const move = (id: string, lane: string) => send('POST', `/task/${id}/move`, { lane });
    const review = async (id: string, verdict: string) => {
      const r = await send('POST', `/task/${id}/review`, { verdict });
      assert.equal(r.status, 200);
    };

    // a: pass first time (phase, ui, alice)
    const a = await task('A', { phase_id: phaseId, tag: 'ui', agent: 'alice' });
    await move(a, 'in_review');
    await review(a, 'pass');
    await move(a, 'done');
    // b: fail -> in_progress -> pass (phase, api, bob)
    const b = await task('B', { phase_id: phaseId, tag: 'api', agent: 'bob' });
    await move(b, 'in_review');
    await review(b, 'fail');
    await move(b, 'in_progress');
    await move(b, 'in_review');
    await review(b, 'pass');
    await move(b, 'done');
    // c: two fails, capped (no phase, ui, alice)
    const c = await task('C', { tag: 'ui', agent: 'alice' });
    await move(c, 'in_review');
    await review(c, 'fail');
    await move(c, 'in_progress');
    await move(c, 'in_review');
    await review(c, 'fail');
    // d: never reviewed; e: reached done without a review
    await task('D', { tag: 'ui' });
    await move(await task('E', {}), 'done');

    const r = await ok(`/metrics/quality?project=${project}&tz=UTC`);
    assert.deepEqual(Object.keys(r).sort(), ['byAgent', 'byPhase', 'byTag', 'range', 'totals', 'weekly']);
    assert.deepEqual(r.totals, {
      reviewed: 3,
      done: 2,
      unreviewedDone: 1,
      notYetReviewed: 1,
      firstPassRate: 1 / 3,
      avgRounds: 5 / 3,
      capped: 1,
      rework: 2,
    });
    const phase = r.byPhase.find((p: any) => p.phase_id === phaseId);
    assert.equal(phase.title, 'P1');
    assert.equal(phase.firstPassRate, 0.5);
    assert.equal(r.byAgent.find((x: any) => x.agent === 'alice').capped, 1);
    assert.equal(r.byTag.find((x: any) => x.tag === 'api').avgRounds, 2);
    assert.ok(r.weekly.length >= 1 && r.weekly.length <= 2); // 2 only if the run straddles a UTC week boundary
    assert.match(r.weekly[0].week, /^\d{4}-W\d\d$/);
    assert.equal(r.weekly.reduce((n: number, w: any) => n + w.reviewed, 0), 3);

    // filters
    const f = (qs: string) => ok(`/metrics/quality?project=${project}&tz=UTC&${qs}`);
    assert.equal((await f(`phase=${phaseId}`)).totals.reviewed, 2);
    assert.deepEqual((await f('tag=ui')).totals.capped, 1);
    const bob = (await f('agent=bob')).totals;
    assert.deepEqual([bob.reviewed, bob.firstPassRate, bob.avgRounds, bob.rework], [1, 0, 2, 1]);
    const old = Date.now() - 30 * 86_400_000;
    const past = await f(`from=${old - 86_400_000}&to=${old}`);
    assert.deepEqual(past.totals, {
      reviewed: 0,
      done: 0,
      unreviewedDone: 0,
      notYetReviewed: 0,
      firstPassRate: null,
      avgRounds: null,
      capped: 0,
      rework: 0,
    });
    assert.ok(past.weekly.every((w: any) => w.reviewed === 0 && w.firstPassRate === null));

    // bad params
    const bad = async (path: string, status: number, re: RegExp) => {
      const res = await get(path);
      assert.equal(res.status, status, `${path}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, re);
    };
    await bad('/metrics/quality', 400, /project required/);
    await bad('/metrics/quality?project=nope', 404, /unknown project/);
    await bad(`/metrics/quality?project=${project}&tz=Mars/Olympus`, 400, /invalid tz/);
    await bad(`/metrics/quality?project=${project}&from=soon`, 400, /invalid from/);
    await bad(`/metrics/quality?project=${project}&from=2000&to=1000`, 400, /from must be <= to/);
    await bad(`/metrics/quality?project=${project}&from=0`, 400, /range too long/);
  });
});
