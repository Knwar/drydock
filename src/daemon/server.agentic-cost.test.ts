import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { startDaemon } from './test-daemon.js';

// End-to-end coverage for GET /metrics/agentic-cost against the REAL daemon (temp DB, random port).

describe('daemon GET /metrics/agentic-cost', () => {
  it('figures, live parts, filters, compare and 400s', async (t) => {
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
    const root = join(daemon.dbDir, 'ac');
    mkdirSync(root, { recursive: true });
    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const phase = ((await (await send('POST', '/phase', { project_id: project, title: 'P1' })).json()) as { phase_id: string }).phase_id;
    await send('POST', '/phase/advance', { project_id: project });
    const task = async (title: string, extra: Record<string, unknown> = {}) =>
      ((await (await send('POST', '/task', { project_id: project, title, phase_id: phase, ...extra })).json()) as { task_id: string }).task_id;
    const usage = { 'claude-sonnet-5': { input: 1_000_000, output: 0, cache_read: 0, cache_creation: 0 } }; // $3 at the placeholder rates
    const activity = async (id: string) => {
      assert.equal((await send('POST', `/task/${id}/activity`, { agent: 'builder', usage })).status, 200);
      await sleep(5);
    };
    const review = async (id: string, verdict: string) => {
      assert.equal((await send('POST', `/task/${id}/review`, { verdict })).status, 200);
      await sleep(5);
    };

    // a: run → fail → run → pass ($3 rework of $6)
    const a = await task('A', { tag: 'api' });
    await send('POST', `/task/${a}/move`, { lane: 'in_progress' });
    await sleep(5);
    await activity(a);
    await review(a, 'fail');
    await activity(a);
    await review(a, 'pass');
    // b: depends on a, blocked now (queue + slip)
    const b = await task('B', { tag: 'ui', depends_on: [a] });
    await send('POST', `/task/${b}/move`, { lane: 'in_progress' });
    await send('POST', `/task/${b}/block`, { reason: 'which db?' });

    const r = await ok(`/metrics/agentic-cost?project=${project}&tz=UTC`);
    assert.deepEqual(Object.keys(r).sort(), ['costAnomaly', 'currency', 'decisionLatencyCost', 'prices', 'range', 'reworkCost', 'usageRunway']);
    assert.deepEqual([r.reworkCost.cost, r.reworkCost.totalCost, r.reworkCost.pct, r.reworkCost.runs], [3, 6, 0.5, 1]);
    assert.equal(r.reworkCost.top[0].id, a);
    assert.equal(r.decisionLatencyCost.label, '$ of idle agent time');
    assert.deepEqual(r.decisionLatencyCost.queue.map((q: any) => [q.kind, q.task_id]), [['blocker', b]]);
    assert.equal(r.decisionLatencyCost.slip.phase.id, phase);
    assert.equal(r.decisionLatencyCost.slip.basis, 'critical_path');
    assert.equal(r.costAnomaly.series.length, 1);
    assert.equal(r.usageRunway.status, 'unavailable');

    // a usage push makes the runway live
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 86_400;
    await send('POST', '/usage', { seven_day: { used_percentage: 40, resets_at: resetsAt } });
    const live = await ok(`/metrics/agentic-cost?project=${project}&tz=UTC`);
    assert.equal(live.usageRunway.status, 'ok');
    assert.ok(live.usageRunway.weekly);

    // filters pass through
    const ui = await ok(`/metrics/agentic-cost?project=${project}&tag=ui&tz=UTC`);
    assert.deepEqual([ui.reworkCost.cost, ui.reworkCost.totalCost], [0, 0]);

    // compare=previous: headline figures for the window before; live parts only on the current one
    const now = Date.now();
    const cmp = await ok(`/metrics/agentic-cost?project=${project}&tz=UTC&from=${now - 3_600_000}&to=${now + 60_000}&compare=previous`);
    assert.equal(cmp.reworkCost.cost, 3);
    assert.deepEqual(cmp.previous, {
      reworkCost: { cost: 0, tokens: 0, pct: null },
      decisionLatencyCost: { humanWaitHours: 0, idleCost: null },
      costAnomaly: { flagged: 0 },
    });
    assert.ok(cmp.previousWindow.to < cmp.window.from);
    assert.ok(cmp.decisionLatencyCost.slip && cmp.usageRunway);

    // 400 / 404s
    assert.equal((await get('/metrics/agentic-cost')).status, 400);
    assert.equal((await get('/metrics/agentic-cost?project=nope')).status, 404);
    assert.equal((await get(`/metrics/agentic-cost?project=${project}&tz=Mars/Base`)).status, 400);
    assert.equal((await get(`/metrics/agentic-cost?project=${project}&from=garbage`)).status, 400);
    assert.equal((await get(`/metrics/agentic-cost?project=${project}&workType=bogus`)).status, 400);
    assert.equal((await get(`/metrics/agentic-cost?project=${project}&from=2026-02-01&to=2026-01-01`)).status, 400);
  });

  it('an empty board', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const root = join(daemon.dbDir, 'empty');
    mkdirSync(root, { recursive: true });
    const project = ((await (await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const res = await fetch(`${daemon.base}/metrics/agentic-cost?project=${project}&tz=UTC`);
    assert.equal(res.status, 200);
    const r = (await res.json()) as any;
    assert.deepEqual([r.reworkCost.cost, r.reworkCost.pct, r.decisionLatencyCost.idleCost, r.costAnomaly.flagged.length], [0, null, null, 0]);
    assert.equal(r.decisionLatencyCost.slip.reason, 'no active phase');
    assert.deepEqual(r.decisionLatencyCost.queue, []);
  });
});
