import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../core/db.js';
import { startDaemon } from './test-daemon.js';

// GET /metrics/forecast against the REAL daemon (temp DB, random port).

const DAY = 86_400_000;

describe('daemon GET /metrics/forecast', () => {
  it('board, phase and plan targets; 404s and 400s', async (t) => {
    const daemon = await startDaemon({ env: { KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    t.after(() => daemon.stop());
    const base = daemon.base;
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const json = async (res: Response | Promise<Response>) => {
      const r = await res;
      return { status: r.status, body: (await r.json()) as any };
    };
    const ok = async (path: string) => {
      const r = await json(fetch(`${base}${path}`));
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const status = async (path: string) => (await fetch(`${base}${path}`)).status;

    const root = join(daemon.dbDir, 'app');
    const emptyRoot = join(daemon.dbDir, 'empty');
    mkdirSync(root, { recursive: true });
    mkdirSync(emptyRoot, { recursive: true });
    const pid = (await ok(`/project?root=${encodeURIComponent(root)}`)).project_id as string;
    const emptyId = (await ok(`/project?root=${encodeURIComponent(emptyRoot)}`)).project_id as string;
    const phaseId = (await json(send('POST', '/phase', { project_id: pid, title: 'P1' }))).body.phase_id as string;
    const otherPhase = (await json(send('POST', '/phase', { project_id: emptyId, title: 'E' }))).body.phase_id as string;
    const task = async (title: string, extra: Record<string, unknown> = {}) =>
      (await json(send('POST', '/task', { project_id: pid, title, ...extra }))).body.task_id as string;

    // 14 done cards, one per day over the last 14 days; then 3 open in the phase + 1 loose
    const done: string[] = [];
    for (let i = 0; i < 14; i++) {
      const id = await task(`done ${i}`);
      await send('POST', `/task/${id}/move`, { lane: 'done' });
      done.push(id);
    }
    const db = openDb(join(daemon.dbDir, 'board.db'));
    try {
      done.forEach((id, i) => {
        const shift = (i + 1) * DAY;
        db.prepare('UPDATE tasks SET created_at = created_at - ?, updated_at = updated_at - ? WHERE id = ?').run(shift, shift, id);
        db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(shift, id);
      });
    } finally {
      db.close();
    }
    for (const title of ['a', 'b', 'c']) await task(title, { phase_id: phaseId });
    await task('loose');

    // board
    const b = await ok(`/metrics/forecast?project=${pid}&tz=UTC&seed=7`);
    assert.equal(b.status, 'ok');
    assert.equal(b.remaining, 4);
    assert.equal(b.method, 'monte-carlo');
    assert.equal(b.runs, 10_000);
    assert.equal(b.seed, 7);
    assert.equal(b.tz, 'UTC');
    assert.equal(b.samples.done, 14);
    assert.ok(b.samples.days >= 14);
    assert.ok(b.p50.days <= b.p85.days && b.p85.days <= b.p95.days);
    assert.match(b.p50.date, /^\d{4}-\d\d-\d\d$/);
    assert.equal(b.histogram.reduce((n: number, h: any) => n + h.count, 0), 10_000);
    assert.deepEqual(await ok(`/metrics/forecast?project=${pid}&tz=UTC&seed=7`), b, 'same seed, same answer');

    // phase
    const ph = await ok(`/metrics/forecast?project=${pid}&phase=${phaseId}&tz=UTC&seed=1`);
    assert.equal(ph.status, 'ok');
    assert.equal(ph.remaining, 3);

    // plan: commit a draft that maps one node onto an existing card's board → a new card
    const draftId = (await json(send('POST', '/plan-drafts', { workspace: pid, title: 'Plan' }))).body.id as string;
    assert.equal(await status(`/metrics/forecast?plan=${draftId}`), 409, 'not committed yet');
    const patched = await json(
      send('PATCH', `/plan-drafts/${draftId}`, {
        ops: [
          { op: 'add_node', node: { id: 'x', title: 'X', board_id: pid } },
          { op: 'add_node', node: { id: 'y', title: 'Y', board_id: pid } },
        ],
      }),
    );
    assert.equal((await json(send('POST', `/plan-drafts/${draftId}/commit`, { version: patched.body.draft.version }))).status, 200);
    const pl = await ok(`/metrics/forecast?plan=${draftId}&tz=UTC`);
    assert.equal(pl.status, 'ok');
    assert.equal(pl.remaining, 2);
    assert.equal(typeof pl.seed, 'number');
    assert.equal((await ok(`/metrics/forecast?plan=${draftId}&project=${pid}&tz=UTC`)).remaining, 2);

    // insufficient history: an empty board with open work
    await send('POST', '/task', { project_id: emptyId, title: 'todo' });
    const e = await ok(`/metrics/forecast?project=${emptyId}`);
    assert.deepEqual(
      [e.status, e.reason, e.have, e.need, e.remaining],
      ['insufficient_history', 'no_throughput', { days: 0, done: 0 }, { days: 10, done: 5 }, 1],
    );

    // 404s
    assert.equal(await status('/metrics/forecast?project=nope'), 404);
    assert.equal(await status(`/metrics/forecast?project=${pid}&phase=nope`), 404);
    assert.equal(await status('/metrics/forecast?plan=nope'), 404);
    // 400s
    for (const q of [
      '',
      `project=${pid}&tz=Not/AZone`,
      `project=${pid}&weeks=1`,
      `project=${pid}&weeks=x`,
      `project=${pid}&seed=-1`,
      `project=${pid}&phase=${otherPhase}`,
      `project=${pid}&phase=${phaseId}&plan=${draftId}`,
      `project=${emptyId}&plan=${draftId}`,
    ]) {
      assert.equal(await status(`/metrics/forecast?${q}`), 400, q);
    }
  });
});
