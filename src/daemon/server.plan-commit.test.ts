import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { openDb } from '../core/db.js';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// /plan-drafts/:id/{diff,commit,run} against the REAL daemon (temp DB, random port).

interface Card {
  id: string;
  project_id: string;
  title: string;
  lane: string;
  phase_id: string | null;
  depends_on: string[];
  subtasks: { text: string; done: boolean }[];
}
interface Committed {
  diff: {
    errors: { code: string }[];
    boards: { board_id: string; phases: { name: string; position: number; after: string | null }[]; activate: string | null }[];
  };
  draft: { draft: { version: number; committed_version: number | null; data: { committed: Record<string, string> } }; dirty: boolean };
}

describe('/plan-drafts commit + run routes', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  let wsId: string;
  let webId: string;

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ok = async <T>(res: Response | Promise<Response>): Promise<T> => {
    const r = await res;
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()) as T;
  };
  const card = (id: string) => ok<Card>(fetch(`${base}/task/${id}`));
  const phases = (pid: string) => ok<{ id: string; title: string; position: number }[]>(fetch(`${base}/phases?project=${pid}`));
  const createDraft = async (title: string) => {
    const d = await ok<{ id: string }>(send('POST', '/plan-drafts', { workspace: wsId, title }));
    return d.id;
  };
  const patch = (id: string, ops: unknown[]) => ok<{ draft: { version: number } }>(send('PATCH', `/plan-drafts/${id}`, { ops }));
  const commit = (id: string, version: number) => ok<Committed>(send('POST', `/plan-drafts/${id}/commit`, { version }));

  /** a (workspace, Foundation) → b (web, Foundation) → c (web, Build, no spec). */
  const seed = async (title: string) => {
    const id = await createDraft(title);
    await patch(id, [
      { op: 'add_node', node: { id: 'a', title: 'API contract', board_id: wsId, phase: 'Foundation', requirements: 'r', subtasks: ['s'] } },
      { op: 'add_node', node: { id: 'b', title: 'Web client', board_id: webId, phase: 'Foundation', requirements: 'r', subtasks: ['s'] } },
      { op: 'add_node', node: { id: 'c', title: 'Web page', board_id: webId, phase: 'Build' } },
      { op: 'add_edge', from: 'a', to: 'b' },
      { op: 'add_edge', from: 'b', to: 'c' },
    ]);
    return id;
  };

  before(async () => {
    daemon = await startDaemon({ env: { HOST: '127.0.0.1', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    base = `http://127.0.0.1:${daemon.port}`;
    const root = join(daemon.dbDir, 'shop');
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    wsId = (await ok<{ project_id: string }>(fetch(`${base}/project?root=${encodeURIComponent(root)}`))).project_id;
    webId = (await ok<{ project_id: string }>(send('POST', '/vertical', { workspace_id: wsId, name: 'web', root: join(root, 'apps', 'web') })))
      .project_id;
    await ok(send('POST', '/phase', { project_id: webId, title: 'Foundation' }));
  });

  after(async () => {
    await daemon?.stop();
  });

  it('diff then commit: phases/cards/cross-board deps; re-commit reuses cards; kept + locked cards', async () => {
    const id = await seed('Launch');
    const diff = await ok<Committed['diff']>(fetch(`${base}/plan-drafts/${id}/diff`));
    assert.deepEqual(diff.errors, []);
    assert.deepEqual(
      diff.boards.map((b) => [b.board_id, b.phases, b.activate]),
      [
        [wsId, [{ name: 'Foundation', position: 1, after: null }], 'Foundation'],
        [webId, [{ name: 'Build', position: 2, after: 'Foundation' }], 'Foundation'],
      ],
    );

    const r = await commit(id, 2);
    assert.deepEqual(r.diff, diff);
    assert.equal(r.draft.dirty, false);
    const m = r.draft.draft.data.committed;
    const [a, b, c] = await Promise.all([card(m.a), card(m.b), card(m.c)]);
    assert.equal(a.project_id, wsId);
    assert.equal(b.project_id, webId);
    assert.deepEqual(b.depends_on, [a.id]);
    assert.deepEqual(c.depends_on, [b.id]);
    const web = await phases(webId);
    assert.deepEqual(web.map((p) => p.title), ['Foundation', 'Build'], 'Foundation reused, Build after it (depends on it)');
    assert.equal(b.phase_id, web[0].id);

    // edit: rename b, drop c (backlog → deleted), start a then drop it (kept), start + edit nothing else
    await ok(send('POST', `/task/${m.a}/move`, { lane: 'in_progress' }));
    const v = (
      await patch(id, [
        { op: 'update_node', id: 'b', patch: { title: 'Web client v2' } },
        { op: 'remove_node', id: 'a' },
        { op: 'remove_node', id: 'c' },
      ])
    ).draft.version;
    const r2 = await commit(id, v);
    assert.deepEqual(r2.draft.draft.data.committed, { b: m.b }, 'same card, no duplicate');
    assert.equal((await card(m.b)).title, 'Web client v2');
    assert.equal((await fetch(`${base}/task/${m.c}`)).status >= 400, true, 'backlog card deleted');
    assert.equal((await card(m.a)).lane, 'in_progress', 'started card kept');
    const kept = (r2.diff.boards as unknown as { kept: { card_id: string; note: string; reason: string }[] }[]).flatMap((x) => x.kept);
    assert.deepEqual(kept.map((k) => [k.card_id, k.note, k.reason]), [[m.a, 'kept, no longer in plan', 'started']]);

    // a started card whose node changes is locked
    await ok(send('POST', `/task/${m.b}/move`, { lane: 'in_progress' }));
    const v2 = (await patch(id, [{ op: 'update_node', id: 'b', patch: { title: 'Nope' } }])).draft.version;
    const r3 = await commit(id, v2);
    const locked = (r3.diff.boards as unknown as { locked: { card_id: string; fields: string[] }[] }[]).flatMap((x) => x.locked);
    assert.deepEqual(locked, [{ node_id: 'b', card_id: m.b, title: 'Web client v2', lane: 'in_progress', fields: ['title'], reason: 'started' }]);
    assert.equal((await card(m.b)).title, 'Web client v2');
  });

  it('new phases: dependency order, placed after the active phase, goals set', async () => {
    const root = join(daemon!.dbDir, 'metrics');
    mkdirSync(root, { recursive: true });
    const pid = (await ok<{ project_id: string }>(fetch(`${base}/project?root=${encodeURIComponent(root)}`))).project_id;
    const phase = async (title: string) => (await ok<{ phase_id: string }>(send('POST', '/phase', { project_id: pid, title }))).phase_id;
    await ok(send('POST', `/phase/${await phase('Setup')}`, { status: 'done' }));
    await ok(send('POST', `/phase/${await phase('Board UX')}`, { status: 'active' }));
    await phase('Cloud relay');
    const id = (await ok<{ id: string }>(send('POST', '/plan-drafts', { workspace: pid, title: 'Metrics' }))).id;
    const { version } = (
      await patch(id, [
        { op: 'add_node', node: { id: 'r0', title: 'Report shell', board_id: pid, phase: 'Reporting' } },
        { op: 'add_node', node: { id: 'f1', title: 'Cycle time', board_id: pid, phase: 'Flow' } },
        { op: 'add_node', node: { id: 'r1', title: 'Weekly report', board_id: pid, phase: 'Reporting' } },
        { op: 'add_edge', from: 'f1', to: 'r1' },
      ])
    ).draft;
    const diff = await ok<Committed['diff']>(fetch(`${base}/plan-drafts/${id}/diff`));
    assert.deepEqual(diff.boards.map((b) => [b.phases, b.activate]), [
      [
        [
          { name: 'Flow', position: 3, after: 'Board UX' },
          { name: 'Reporting', position: 4, after: 'Flow' },
        ],
        null,
      ],
    ]);
    await commit(id, version);
    const after = await ok<{ title: string; position: number; status: string; goal: string | null }[]>(fetch(`${base}/phases?project=${pid}`));
    assert.deepEqual(after.map((p) => [p.title, p.position, p.status, p.goal]), [
      ['Setup', 1, 'done', null],
      ['Board UX', 2, 'active', null],
      ['Flow', 3, 'planned', 'Metrics · Flow'],
      ['Reporting', 4, 'planned', 'Metrics · Reporting'],
      ['Cloud relay', 5, 'planned', null],
    ]);
  });

  it('preserves an external depends_on', async () => {
    const outside = (await ok<{ task_id: string }>(send('POST', '/task', { project_id: webId, title: 'Outside' }))).task_id;
    const id = await seed('External');
    const m = (await commit(id, 2)).draft.draft.data.committed;
    await ok(send('PATCH', `/task/${m.b}`, { depends_on: [m.a, outside] }));
    const v = (await patch(id, [{ op: 'remove_edge', from: 'a', to: 'b' }])).draft.version;
    await commit(id, v);
    assert.deepEqual((await card(m.b)).depends_on, [outside]);
  });

  it('commit validation: bad version → 400; stale → 409; cycle → 409 {errors}; nothing written', async () => {
    const id = await seed('Guard');
    assert.equal((await send('POST', `/plan-drafts/${id}/commit`, {})).status, 400);
    assert.equal((await send('POST', `/plan-drafts/${id}/commit`, { version: '2' })).status, 400);
    const stale = await send('POST', `/plan-drafts/${id}/commit`, { version: 1 });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: 'draft is at version 2, not 1',
      code: 'stale',
      version: 2,
    });
    const v = (await patch(id, [{ op: 'add_edge', from: 'c', to: 'a' }])).draft.version;
    const cyc = await send('POST', `/plan-drafts/${id}/commit`, { version: v });
    assert.equal(cyc.status, 409);
    const body = (await cyc.json()) as { code: string; errors: { code: string }[] };
    assert.equal(body.code, 'invalid_plan');
    assert.deepEqual(body.errors.map((e) => e.code), ['cycle']);
    const view = await ok<{ draft: { committed_version: number | null; data: { committed: object } } }>(fetch(`${base}/plan-drafts/${id}`));
    assert.equal(view.draft.committed_version, null);
    assert.deepEqual(view.draft.data.committed, {});
    assert.equal((await send('POST', '/plan-drafts/nope/commit', { version: 1 })).status, 404);
  });

  it('a failure mid-commit rolls the whole commit back', async () => {
    const id = await createDraft('Rollback');
    const { version } = (
      await patch(id, [
        { op: 'add_node', node: { id: 'x', title: 'First', board_id: wsId, phase: 'RollbackPhase' } },
        { op: 'add_node', node: { id: 'y', title: 'boom-route', board_id: webId } },
        { op: 'add_edge', from: 'x', to: 'y' },
      ])
    ).draft;
    // force the second card insert to fail, after the phase and the first card were written
    const db = openDb(join(daemon!.dbDir, 'board.db'));
    const counts = () =>
      ['tasks', 'phases', 'task_events', 'outbox'].map(
        (t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    try {
      db.exec(`CREATE TRIGGER boom_route BEFORE INSERT ON tasks WHEN NEW.title = 'boom-route'
               BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
      const before = counts();
      const res = await send('POST', `/plan-drafts/${id}/commit`, { version });
      assert.equal(res.status, 400); // the daemon's catch-all maps an unexpected error to 400
      assert.deepEqual(counts(), before);
      assert.equal((await phases(wsId)).some((p) => p.title === 'RollbackPhase'), false);
      const view = await ok<{ draft: { committed_version: number | null } }>(fetch(`${base}/plan-drafts/${id}`));
      assert.equal(view.draft.committed_version, null);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS boom_route');
      db.close();
    }
    const r = await commit(id, version);
    assert.equal(Object.keys(r.draft.draft.data.committed).length, 2);
  });

  it('run: dirty → 409; queue queues only spec’d cards; autopilot sets the vertical flag only; WS announcements', async () => {
    const id = await seed('Run');
    assert.equal((await send('POST', `/plan-drafts/${id}/run`, { mode: 'queue' })).status, 409, 'never committed');
    const m = (await commit(id, 2)).draft.draft.data.committed;
    await patch(id, [{ op: 'set_title', title: 'Run 2' }]);
    const dirty = await send('POST', `/plan-drafts/${id}/run`, { mode: 'queue' });
    assert.equal(dirty.status, 409);
    assert.equal(((await dirty.json()) as { code: string }).code, 'dirty');
    await commit(id, 3);
    assert.equal((await send('POST', `/plan-drafts/${id}/run`, { mode: 'go' })).status, 400);

    // the workspace board's socket: it gets its own card/autopilot messages plus the verticals list
    const sock = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws?project=${wsId}`);
    const seen: any[] = [];
    sock.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    const waitFor = (pred: (m: any) => boolean, ms = 5000) =>
      new Promise<any>((resolve, reject) => {
        const deadline = Date.now() + ms;
        const check = () => {
          const hit = seen.find(pred);
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return reject(new Error('timed out waiting for a WS message'));
          setTimeout(check, 10);
        };
        check();
      });
    await new Promise((r) => sock.once('open', r));
    try {
      await waitFor((x) => x.type === 'init');
      const q = await ok<{ queued: string[]; skipped: { card_id: string; reason: string }[] }>(
        send('POST', `/plan-drafts/${id}/run`, { mode: 'queue' }),
      );
      assert.deepEqual(q.queued.sort(), [m.a, m.b].sort());
      assert.deepEqual(q.skipped.map((s) => [s.card_id, s.reason]), [[m.c, 'needs spec']]);
      assert.equal((await card(m.c)).lane, 'backlog');
      await waitFor((x) => x.type === 'card' && x.card.id === m.a && x.card.lane === 'queued');

      const ap = await ok<{
        autopilot: { enabled: { board_id: string }[]; not_enabled: { board_id: string; reason: string; message?: string }[] };
      }>(send('POST', `/plan-drafts/${id}/run`, { mode: 'autopilot' }));
      assert.deepEqual(ap.autopilot.enabled.map((e) => e.board_id), [webId]);
      assert.deepEqual(ap.autopilot.not_enabled, [
        { board_id: wsId, reason: 'main_session', message: 'Autopilot never drives the main session; its cards are queued for you' },
      ]);
      assert.equal((await card(m.a)).lane, 'queued', "the workspace's card stays queued for the human");
      const flags = await ok<{ verticals: { id: string; autopilot: number }[]; workspace: { autopilot: number } }>(
        fetch(`${base}/workspace?project=${wsId}`),
      );
      assert.equal(flags.workspace.autopilot, 0);
      assert.equal(flags.verticals.find((x) => x.id === webId)!.autopilot, 1);
      const verticals = await waitFor((x) => x.type === 'verticals');
      assert.equal(verticals.verticals.find((x: { id: string }) => x.id === webId).autopilot, 1);
      assert.ok(!seen.some((x) => x.type === 'autopilot' && x.project_id === wsId), 'no autopilot toggle on the workspace');
    } finally {
      sock.terminate();
    }
  });

  it('commit announces cards, phases and the draft over WS', async () => {
    const id = await seed('Live');
    const sock = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws?project=${wsId}`);
    const seen: any[] = [];
    sock.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    const waitFor = (pred: (m: any) => boolean, ms = 5000) =>
      new Promise<any>((resolve, reject) => {
        const deadline = Date.now() + ms;
        const check = () => {
          const hit = seen.find(pred);
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return reject(new Error('timed out waiting for a WS message'));
          setTimeout(check, 10);
        };
        check();
      });
    await new Promise((r) => sock.once('open', r));
    try {
      await waitFor((x) => x.type === 'init');
      const m = (await commit(id, 2)).draft.draft.data.committed;
      await waitFor((x) => x.type === 'card' && x.card.id === m.a);
      await waitFor((x) => x.type === 'phases' && x.project_id === wsId);
      await waitFor((x) => x.type === 'plan_draft' && x.id === id);
      const v = (await patch(id, [{ op: 'remove_node', id: 'a' }])).draft.version;
      await commit(id, v);
      await waitFor((x) => x.type === 'card_removed' && x.card_id === m.a);
    } finally {
      sock.terminate();
    }
  });
});

function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

describe('/plan-drafts diff/commit/run are loopback-only', () => {
  let daemon: TestDaemon | undefined;
  before(async () => {
    daemon = await startDaemon({ env: { HOST: '0.0.0.0', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
  });
  after(async () => {
    await daemon?.stop();
  });

  it('a non-loopback caller gets 403', async (t) => {
    const ip = nonLoopbackIPv4();
    if (!ip) return t.skip('no non-loopback IPv4 interface on this host');
    const lan = `http://${ip}:${daemon!.port}`;
    assert.equal((await fetch(`${lan}/plan-drafts/any/diff`)).status, 403);
    assert.equal((await fetch(`${lan}/plan-drafts/any/commit`, { method: 'POST', body: '{"version":1}' })).status, 403);
    assert.equal((await fetch(`${lan}/plan-drafts/any/run`, { method: 'POST', body: '{"mode":"queue"}' })).status, 403);
  });
});
