import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../core/db.js';
import { startDaemon } from './test-daemon.js';

// PUT /phase/:id/target, /milestones CRUD and GET /metrics/schedule against the REAL daemon (temp DB, random port).

const DAY = 86_400_000;

const dayUTC = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('phase targets, milestones and /metrics/schedule', () => {
  it('target PUT, milestones CRUD, schedule, delete/merge handling', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const base = daemon.base;
    const send = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    const ok = async (method: string, path: string, body?: unknown) => {
      const r = await send(method, path, body);
      assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.body)}`);
      return r.body;
    };

    const root = join(daemon.dbDir, 'shop');
    for (const sub of ['web', 'api']) mkdirSync(join(root, sub), { recursive: true });
    const wsId = (await ok('GET', `/project?root=${encodeURIComponent(root)}`)).project_id as string;
    const webId = (await ok('POST', '/vertical', { workspace_id: wsId, name: 'web', root: join(root, 'web') })).project_id as string;
    const apiId = (await ok('POST', '/vertical', { workspace_id: wsId, name: 'api', root: join(root, 'api') })).project_id as string;
    const phase = async (project_id: string, title: string) => (await ok('POST', '/phase', { project_id, title })).phase_id as string;
    const task = async (project_id: string, title: string, extra: Record<string, unknown> = {}) =>
      (await ok('POST', '/task', { project_id, title, ...extra })).task_id as string;

    // 14 done cards on web, one a day over the last 14 days → enough history
    const done: string[] = [];
    for (let i = 0; i < 14; i++) {
      const id = await task(webId, `done ${i}`);
      await ok('POST', `/task/${id}/move`, { lane: 'done' });
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
    const soon = await phase(webId, 'soon');
    const later = await phase(webId, 'later');
    const apiPhase = await phase(apiId, 'api v1');
    for (let i = 0; i < 3; i++) await task(webId, `s${i}`, { phase_id: soon });
    await task(webId, 'l', { phase_id: later });
    await task(apiId, 'a', { phase_id: apiPhase });

    // ── PUT /phase/:id/target ──
    const put = (id: string, body: unknown) => send('PUT', `/phase/${id}/target`, body);
    assert.equal((await put(soon, { target_date: dayUTC(-3) })).body.target_date, dayUTC(-3));
    assert.equal((await put(later, { target_date: dayUTC(365) })).body.target_date, dayUTC(365));
    assert.equal((await put(apiPhase, { target_date: dayUTC(30) })).status, 200);
    assert.equal((await put('nope', { target_date: null })).status, 404);
    for (const bad of [{}, [], { target_date: '2026-02-30' }, { target_date: 20261005 }, { target_date: 'tomorrow' }])
      assert.equal((await put(soon, bad)).status, 400, JSON.stringify(bad));
    const phases = (await ok('GET', `/phases?project=${webId}`)) as { id: string; target_date: string | null }[];
    assert.equal(phases.find((p) => p.id === soon)!.target_date, dayUTC(-3), 'getPhases carries target_date');
    assert.equal((await put(later, { target_date: null })).body.target_date, null);
    await put(later, { target_date: dayUTC(365) });

    // ── /milestones CRUD ──
    const beta = await ok('POST', '/milestones', { project_id: wsId, title: 'Beta', date: dayUTC(20), phase_id: later });
    assert.equal(beta.phase_id, later);
    const onApi = await ok('POST', '/milestones', { project_id: apiId, title: 'API freeze', date: dayUTC(10), phase_id: apiPhase });
    assert.equal((await send('POST', '/milestones', { project_id: wsId, title: 'x', date: 'nope' })).status, 400);
    assert.equal((await send('POST', '/milestones', { project_id: 'nope', title: 'x', date: dayUTC(1) })).status, 404);
    assert.equal((await ok('PATCH', `/milestones/${beta.id}`, { title: 'Public beta' })).title, 'Public beta');
    assert.equal((await send('PATCH', '/milestones/nope', { title: 'x' })).status, 404);
    assert.equal((await send('PATCH', `/milestones/${beta.id}`, { date: '2026-13-01' })).status, 400);
    const tmp = await ok('POST', '/milestones', { project_id: webId, title: 'tmp', date: dayUTC(5) });
    assert.deepEqual(await ok('DELETE', `/milestones/${tmp.id}`), { deleted: tmp.id });
    assert.equal((await send('DELETE', `/milestones/${tmp.id}`)).status, 404);
    assert.deepEqual((await ok('GET', `/milestones?project=${wsId}`)).map((m: any) => m.title), ['API freeze', 'Public beta']);
    assert.equal((await send('GET', '/milestones')).status, 400);
    assert.equal((await send('GET', '/milestones?project=nope')).status, 404);

    // ── GET /metrics/schedule ──
    const s = await ok('GET', `/metrics/schedule?project=${wsId}&tz=UTC&seed=5`);
    assert.equal(s.project_id, wsId);
    assert.equal(s.tz, 'UTC');
    assert.equal(s.today, dayUTC(0));
    const by = Object.fromEntries(s.phases.map((p: any) => [p.title, p]));
    assert.deepEqual(Object.keys(by).sort(), ['api v1', 'later', 'soon'], 'the verticals’ phases');
    assert.equal(by.soon.status, 'late');
    assert.equal(by.soon.remaining, 3);
    assert.equal(by.later.status, 'on_track');
    assert.match(by.later.p85, /^\d{4}-\d\d-\d\d$/);
    assert.deepEqual(by.later.milestones.map((m: any) => m.id), [beta.id]);
    assert.equal(s.milestones.length, 2);
    for (const p of s.phases)
      for (const k of ['id', 'project_id', 'title', 'phase_status', 'position', 'remaining', 'status', 'reason', 'target_date', 'p50', 'p85', 'milestones'])
        assert.ok(k in p, k);
    const web = await ok('GET', `/metrics/schedule?project=${webId}&tz=UTC`);
    assert.deepEqual(web.phases.map((p: any) => p.title), ['soon', 'later'], 'a vertical: its own phases');
    assert.equal((await send('GET', '/metrics/schedule')).status, 400);
    assert.equal((await send('GET', '/metrics/schedule?project=nope')).status, 404);
    assert.equal((await send('GET', `/metrics/schedule?project=${wsId}&tz=Not/AZone`)).status, 400);
    assert.equal((await send('GET', `/metrics/schedule?project=${wsId}&seed=x`)).status, 400);

    // ── merge (fold) nulls phase_id; delete removes a board's milestones ──
    await ok('POST', '/verticals/merge', { from: apiId, into: webId, phases: 'fold' });
    const after = (await ok('GET', `/milestones?project=${wsId}`)) as any[];
    const freeze = after.find((m) => m.id === onApi.id);
    assert.deepEqual([freeze.project_id, freeze.phase_id], [webId, null]);
    await ok('DELETE', `/project/${webId}`);
    const left = (await ok('GET', `/milestones?project=${wsId}`)) as any[];
    assert.deepEqual(left.map((m) => [m.id, m.phase_id]), [[beta.id, null]], 'web’s own gone; the ws one unlinked');
  });
});

function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

describe('target + milestone writes are loopback-only', () => {
  it('a non-loopback caller gets 403 on writes, but may read', async (t) => {
    const ip = nonLoopbackIPv4();
    if (!ip) return t.skip('no non-loopback IPv4 interface on this host');
    const daemon = await startDaemon({ env: { HOST: '0.0.0.0' } });
    t.after(() => daemon.stop());
    const lan = `http://${ip}:${daemon.port}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${lan}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call('PUT', '/phase/any/target', { target_date: null })).status, 403);
    assert.equal((await call('POST', '/milestones', { project_id: 'a', title: 't', date: '2026-10-01' })).status, 403);
    assert.equal((await call('PATCH', '/milestones/any', { title: 'x' })).status, 403);
    assert.equal((await call('DELETE', '/milestones/any')).status, 403);
    assert.equal((await call('GET', '/milestones?project=nope')).status, 404, 'reads are open');
  });
});
