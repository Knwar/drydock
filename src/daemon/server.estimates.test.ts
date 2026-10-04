import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startDaemon } from './test-daemon.js';

// End-to-end coverage for estimate_hours over HTTP and GET /metrics/estimates against the REAL daemon.

describe('daemon estimate_hours + GET /metrics/estimates', () => {
  it('create / patch validation, figures, filters, compare and 400s', async (t) => {
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
    const root = join(daemon.dbDir, 'est');
    mkdirSync(root, { recursive: true });
    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;

    // HTTP create / patch
    const a = ((await (await send('POST', '/task', { project_id: project, title: 'A', tag: 'api', estimate_hours: 6 })).json()) as { task_id: string })
      .task_id;
    assert.equal((await ok(`/task/${a}`)).estimate_hours, 6);
    assert.equal((await send('POST', '/task', { project_id: project, title: 'Bad', estimate_hours: 0 })).status, 400);
    assert.equal((await send('PATCH', `/task/${a}`, { estimate_hours: 1001 })).status, 400);
    assert.equal((await send('PATCH', `/task/${a}`, { estimate_hours: 'six' })).status, 400);
    assert.equal((await ok(`/task/${a}`)).estimate_hours, 6, 'a rejected patch changes nothing');
    assert.equal((await send('PATCH', `/task/${a}`, { estimate_hours: null })).status, 200);
    assert.equal((await ok(`/task/${a}`)).estimate_hours, null);
    assert.equal((await send('PATCH', `/task/${a}`, { estimate_hours: 4 })).status, 200);

    const b = ((await (await send('POST', '/task', { project_id: project, title: 'B', tag: 'ui' })).json()) as { task_id: string }).task_id;
    for (const id of [a, b]) {
      await send('POST', `/task/${id}/move`, { lane: 'in_progress' });
      await send('POST', `/task/${id}/move`, { lane: 'done' });
    }

    const r = await ok(`/metrics/estimates?project=${project}&tz=UTC`);
    assert.deepEqual(Object.keys(r).sort(), ['coverage', 'done', 'hourlyRate', 'perception', 'range']);
    assert.equal(r.done, 2);
    assert.deepEqual(r.coverage, { estimated: 1, pct: 0.5 });
    assert.deepEqual([r.hourlyRate.cards, r.hourlyRate.noSpend, r.hourlyRate.hoursPerDollar], [0, 1, null]); // no runs recorded
    assert.deepEqual(r.perception.cards.map((p: any) => [p.id, p.estimateHours]), [[a, 4]]);

    const ui = await ok(`/metrics/estimates?project=${project}&tag=ui&tz=UTC`);
    assert.deepEqual([ui.done, ui.coverage.pct], [1, 0]);

    const now = Date.now();
    const cmp = await ok(`/metrics/estimates?project=${project}&tz=UTC&from=${now - 3_600_000}&to=${now + 60_000}&compare=previous`);
    assert.equal(cmp.done, 2);
    assert.deepEqual(cmp.previous, {
      done: 0,
      coverage: { pct: null },
      hourlyRate: { hoursPerDollar: null, dollarsPerHour: null },
      perception: { medianRatio: null },
    });
    assert.ok(cmp.previousWindow.to < cmp.window.from);

    assert.equal((await get('/metrics/estimates')).status, 400);
    assert.equal((await get('/metrics/estimates?project=nope')).status, 404);
    assert.equal((await get(`/metrics/estimates?project=${project}&tz=Mars/Base`)).status, 400);
    assert.equal((await get(`/metrics/estimates?project=${project}&from=garbage`)).status, 400);
    assert.equal((await get(`/metrics/estimates?project=${project}&workType=bogus`)).status, 400);
  });
});
