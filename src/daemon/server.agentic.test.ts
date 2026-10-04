import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startDaemon } from './test-daemon.js';

// End-to-end coverage for GET /metrics/agentic against the REAL daemon (temp DB, random port).

describe('daemon GET /metrics/agentic', () => {
  it('figures, scope, filters, compare and 400s', async (t) => {
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
    const root = join(daemon.dbDir, 'ag');
    mkdirSync(join(root, 'web'), { recursive: true });
    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const vertical = ((await (await send('POST', '/vertical', { workspace_id: project, name: 'web', root: join(root, 'web') })).json()) as {
      project_id: string;
    }).project_id;
    assert.ok(vertical);
    const task = async (projectId: string, title: string, tag?: string) =>
      ((await (await send('POST', '/task', { project_id: projectId, title, tag })).json()) as { task_id: string }).task_id;
    const move = (id: string, lane: string) => send('POST', `/task/${id}/move`, { lane });

    // a: clean, all criteria checked, first-pass review, linked to a decision (workspace board)
    const a = await task(project, 'A', 'api');
    await send('PATCH', `/task/${a}`, { subtasks: [{ text: 'one', done: true }] });
    await move(a, 'in_review');
    await send('POST', `/task/${a}/review`, { verdict: 'pass' });
    await move(a, 'done');
    await send('POST', '/decisions', { project_id: project, title: 'D', decision: 'd', links: [{ target_type: 'card', target_id: a }] });
    // b: blocked by the agent, reopened by a human (no fail), then done (vertical)
    const b = await task(vertical, 'B', 'ui');
    await move(b, 'in_progress');
    await send('POST', `/task/${b}/block`, { reason: 'which db?' });
    await send('POST', `/task/${b}/unblock`, {});
    await move(b, 'in_review');
    await move(b, 'in_progress');
    await move(b, 'in_review');
    await move(b, 'done');
    // c: redirected, still open
    const c = await task(project, 'C');
    await move(c, 'in_progress');
    await send('POST', `/task/${c}/redirect`, { note: 'new direction' });
    // tool events as the activity hook posts them
    await send('POST', '/event', { project_id: project, task_id: a, type: 'tool', payload: { tool: 'Bash', file: 'git push --force' } });
    await send('POST', '/event', { project_id: vertical, task_id: b, type: 'tool', payload: { tool: 'Edit', file: 'src/b.ts' } });

    const r = await ok(`/metrics/agentic?project=${project}&tz=UTC`);
    assert.deepEqual(Object.keys(r).sort(), ['autonomy', 'batch', 'governance', 'range', 'specAdherence', 'stops']);
    assert.deepEqual([r.autonomy.done, r.autonomy.autonomous, r.autonomy.pct], [2, 1, 0.5]);
    assert.ok(r.autonomy.weekly.length >= 1);
    assert.deepEqual([r.stops.agent, r.stops.human, r.stops.redirects, r.stops.reopens, r.stops.ratio], [1, 2, 1, 1, 0.5]);
    assert.deepEqual([r.batch.threshold, r.batch.cards, r.batch.noData], [200, 0, 2]);
    assert.deepEqual([r.specAdherence.done, r.specAdherence.adherent, r.specAdherence.pct], [2, 1, 0.5]);
    assert.deepEqual([r.governance.toolEvents.total, r.governance.toolEvents.tied], [2, 2]);
    assert.equal(r.governance.risky.count, 1);
    assert.deepEqual(r.governance.decisionLinked, { done: 2, linked: 1, pct: 0.5 });

    // scope narrows to the vertical; filters pass through; batchLines sets the threshold
    const v = await ok(`/metrics/agentic?project=${project}&scope=${vertical}&tz=UTC&batchLines=50`);
    assert.deepEqual([v.autonomy.done, v.stops.agent, v.governance.toolEvents.total, v.batch.threshold], [1, 1, 1, 50]);
    const api = await ok(`/metrics/agentic?project=${project}&tag=api&tz=UTC`);
    assert.deepEqual([api.autonomy.done, api.autonomy.pct], [1, 1]);

    // compare=previous: previous figures + windows; a window before everything sees nothing
    const now = Date.now();
    const cmp = await ok(`/metrics/agentic?project=${project}&tz=UTC&from=${now - 86_400_000}&to=${now + 60_000}&compare=previous`);
    assert.equal(cmp.autonomy.done, 2);
    assert.deepEqual(cmp.previous, {
      autonomy: { done: 0, pct: null },
      stops: { agent: 0, human: 0, ratio: null },
      batch: { pctOver: null, median: null },
      specAdherence: { pct: null },
      governance: { tiedPct: null, risky: 0, decisionLinkedPct: null },
    });
    assert.ok(cmp.window && cmp.previousWindow);
    assert.ok(cmp.previousWindow.to < cmp.window.from);
    // all time: nothing to compare against
    const all = await ok(`/metrics/agentic?project=${project}&compare=previous`);
    assert.deepEqual([all.previous, all.window, all.previousWindow], [null, null, null]);

    // 400 / 404s
    assert.equal((await get('/metrics/agentic')).status, 400);
    assert.equal((await get('/metrics/agentic?project=nope')).status, 404);
    assert.equal((await get(`/metrics/agentic?project=${project}&tz=Mars/Base`)).status, 400);
    assert.equal((await get(`/metrics/agentic?project=${project}&from=garbage`)).status, 400);
    assert.equal((await get(`/metrics/agentic?project=${project}&batchLines=0`)).status, 400);
    assert.equal((await get(`/metrics/agentic?project=${project}&batchLines=abc`)).status, 400);
    assert.equal((await get(`/metrics/agentic?project=${project}&scope=elsewhere`)).status, 400);
    assert.equal((await get(`/metrics/agentic?project=${project}&workType=bogus`)).status, 400);
    assert.equal((await get(`/metrics/agentic?project=${project}&compare=bogus&from=2026-01-01`)).status, 400);
  });

  it('an empty board', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const root = join(daemon.dbDir, 'empty');
    mkdirSync(root, { recursive: true });
    const project = ((await (await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const res = await fetch(`${daemon.base}/metrics/agentic?project=${project}&tz=UTC`);
    assert.equal(res.status, 200);
    const r = (await res.json()) as any;
    assert.deepEqual([r.autonomy.done, r.autonomy.pct, r.stops.ratio, r.batch.median, r.specAdherence.pct], [0, null, null, null, null]);
  });
});
