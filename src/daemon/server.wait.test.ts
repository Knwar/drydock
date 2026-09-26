import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startDaemon } from './test-daemon.js';

// GET /metrics/wait against the REAL daemon (temp DB, random port): needs_you
// intervals driven through POST /status (as the Notification hook does), and
// blockers through raise / resolve.

describe('daemon GET /metrics/wait', () => {
  it('reflects needs_you transitions and blockers; validates params', async (t) => {
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
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const phase = ((await (await send('POST', '/phase', { project_id: project, title: 'P1' })).json()) as { phase_id: string })
      .phase_id;
    const task = async (title: string, extra: Record<string, unknown> = {}) =>
      ((await (await send('POST', '/task', { project_id: project, title, ...extra })).json()) as { task_id: string }).task_id;
    const a = await task('A', { phase_id: phase });
    const b = await task('B');
    const status = (verb: string, extra: Record<string, unknown> = {}) =>
      send('POST', '/status', { project_id: project, agent: 'orchestrator', verb, ...extra });

    // nothing yet
    let w = await ok(`/metrics/wait?project=${project}&tz=UTC`);
    assert.deepEqual(w.needsYou, { count: 0, totalMs: 0, duration: { p50: null, p85: null, count: 0 } });
    assert.deepEqual(w.waiting, { count: 0, longestMs: null, needsYou: [], blockers: [] });
    assert.equal(w.range.tz, 'UTC');

    // into needs_you (the Notification hook's ping), on card A
    await status('Edit');
    await status('needs you', { detail: 'Claude needs your permission to use Bash', task_id: a });
    w = await ok(`/metrics/wait?project=${project}`);
    assert.equal(w.needsYou.count, 1);
    assert.equal(w.needsYou.duration.count, 0);
    assert.equal(w.waiting.count, 1);
    assert.equal(w.waiting.needsYou[0].task_id, a);
    assert.equal(w.waiting.needsYou[0].agent_id, 'orchestrator');
    assert.equal(w.waiting.needsYou[0].reason, 'Claude needs your permission to use Bash');
    assert.ok(w.waiting.longestMs >= 0);

    // and out of it
    await status('Bash');
    w = await ok(`/metrics/wait?project=${project}`);
    assert.equal(w.needsYou.count, 1);
    assert.equal(w.needsYou.duration.count, 1);
    assert.equal(w.waiting.count, 0);
    assert.equal(w.byPhase.find((p: any) => p.phase_id === phase).needsYou.count, 1);
    assert.equal(w.byBoard[0].project_id, project);
    assert.equal(w.byBoard[0].name, 'app');

    // the Notification hook's idle_prompt (source 'notification') does not end a wait; a Stop idle does
    await status('needs you', { detail: 'perm' });
    assert.equal((await status('idle', { detail: 'waiting for user', source: 'notification' })).status, 200);
    w = await ok(`/metrics/wait?project=${project}`);
    assert.equal(w.waiting.needsYou.length, 1);
    assert.equal((await ok(`/session?project=${project}`)).state, 'needs_you');
    await status('idle', { detail: 'waiting for user' });
    w = await ok(`/metrics/wait?project=${project}`);
    assert.equal(w.waiting.needsYou.length, 0);
    assert.equal(w.needsYou.count, 2);
    assert.equal(w.needsYou.duration.count, 2);
    // outside needs_you a notification idle is an ordinary idle ping
    await status('Edit');
    await status('idle', { source: 'notification' });
    assert.equal((await ok(`/session?project=${project}`)).state, 'idle');

    // blockers: raise on A and B, resolve B
    assert.equal((await send('POST', `/task/${a}/block`, { reason: 'which db?' })).status, 200);
    assert.equal((await send('POST', `/task/${b}/block`, { reason: 'naming?' })).status, 200);
    assert.equal((await send('POST', `/task/${b}/unblock`, { note: 'use X' })).status, 200);
    w = await ok(`/metrics/wait?project=${project}`);
    assert.equal(w.blocked.count, 2);
    assert.equal(w.blocked.resolution.count, 1);
    assert.deepEqual(
      w.waiting.blockers.map((x: any) => [x.task_id, x.reason]),
      [[a, 'which db?']],
    );
    assert.equal(w.waiting.count, 1);

    // phase filter: only card A's needs_you + blocker
    w = await ok(`/metrics/wait?project=${project}&phase=${phase}`);
    assert.equal(w.needsYou.count, 1);
    assert.equal(w.needsYou.duration.count, 1);
    assert.equal(w.blocked.count, 1);

    // a window entirely in the past sees nothing but still reports what is waiting now
    w = await ok(`/metrics/wait?project=${project}&from=2020-01-01&to=2020-01-02&tz=UTC`);
    assert.equal(w.needsYou.count, 0);
    assert.equal(w.blocked.count, 0);
    assert.equal(w.waiting.count, 1);

    // validation
    assert.equal((await get('/metrics/wait')).status, 400);
    assert.equal((await get('/metrics/wait?project=nope')).status, 404);
    assert.equal((await get(`/metrics/wait?project=${project}&tz=Mars/Base`)).status, 400);
    assert.equal((await get(`/metrics/wait?project=${project}&from=garbage`)).status, 400);
    const bad = await get(`/metrics/wait?project=${project}&from=2020-01-02&to=2020-01-01&tz=UTC`);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /from must be <= to/);
  });
});
