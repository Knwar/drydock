import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// /plan-drafts routes against the REAL daemon (temp DB, random port).

interface View {
  draft: { id: string; workspace_id: string; title: string; version: number; data: { nodes: { id: string }[] } };
  layout: { columns: Record<string, number>; longestChain: string[] } | null;
  validation: { errors: { code: string }[]; warnings: { code: string }[] };
  boards: { id: string; name: string; root: string }[];
  dirty: boolean;
}

const node = (id: string, board_id: string) => ({ id, title: `T ${id}`, board_id });

describe('/plan-drafts routes', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  let wsId: string;
  let verticalId: string;

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const create = async (title: string, workspace = wsId) => {
    const res = await send('POST', '/plan-drafts', { workspace, title });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as View['draft'];
  };
  const get = async (id: string) => {
    const res = await fetch(`${base}/plan-drafts/${id}`);
    assert.equal(res.status, 200);
    return (await res.json()) as View;
  };

  before(async () => {
    daemon = await startDaemon({ env: { HOST: '127.0.0.1', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    base = `http://127.0.0.1:${daemon.port}`;
    const root = join(daemon.dbDir, 'shop');
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    const res = await fetch(`${base}/project?root=${encodeURIComponent(root)}`);
    wsId = ((await res.json()) as { project_id: string }).project_id;
    const v = await send('POST', '/vertical', { workspace_id: wsId, name: 'web', root: join(root, 'apps', 'web') });
    assert.equal(v.status, 200, await v.clone().text());
    verticalId = ((await v.json()) as { project_id: string }).project_id;
  });

  after(async () => {
    await daemon?.stop();
  });

  it('create → list → get with layout, validation, boards and dirty', async () => {
    const d = await create('Launch');
    assert.equal(d.workspace_id, wsId);
    assert.equal(d.version, 1);
    const list = (await (await fetch(`${base}/plan-drafts?workspace=${wsId}`)).json()) as Record<string, unknown>[];
    const row = list.find((x) => x.id === d.id)!;
    assert.ok(row);
    for (const k of ['title', 'version', 'node_count', 'edge_count', 'committed_version', 'committed_at', 'updated_at'])
      assert.ok(k in row, k);
    assert.equal(row.node_count, 0);
    const view = await get(d.id);
    assert.equal(view.draft.id, d.id);
    assert.deepEqual(view.layout, { columns: {}, longestChain: [] });
    assert.deepEqual(view.validation, { errors: [], warnings: [], groups: [] });
    assert.deepEqual(
      view.boards.map((b) => [b.id, b.root]),
      [
        [wsId, ''],
        [verticalId, 'apps/web'],
      ],
    );
    assert.equal(view.dirty, true);
  });

  it('a vertical id resolves to its workspace (list + create)', async () => {
    const d = await create('Via vertical', verticalId);
    assert.equal(d.workspace_id, wsId);
    const list = (await (await fetch(`${base}/plan-drafts?workspace=${verticalId}`)).json()) as { id: string }[];
    assert.ok(list.some((x) => x.id === d.id));
  });

  it('PATCH applies ops, bumps version, renames via set_title', async () => {
    const d = await create('Ops');
    const res = await send('PATCH', `/plan-drafts/${d.id}`, {
      version: 1,
      ops: [
        { op: 'add_node', node: node('a', wsId) },
        { op: 'add_node', node: node('b', verticalId) },
        { op: 'add_edge', from: 'a', to: 'b' },
        { op: 'set_title', title: 'Renamed' },
      ],
    });
    assert.equal(res.status, 200, await res.clone().text());
    const view = (await res.json()) as View;
    assert.equal(view.draft.version, 2);
    assert.equal(view.draft.title, 'Renamed');
    assert.deepEqual(view.layout, { columns: { a: 0, b: 1 }, longestChain: ['a', 'b'] });
    assert.deepEqual(view.validation.errors, []);
    assert.deepEqual(await get(d.id), view);

    // no version field → still applies
    const res2 = await send('PATCH', `/plan-drafts/${d.id}`, { ops: [{ op: 'remove_edge', from: 'a', to: 'b' }] });
    assert.equal(res2.status, 200);
    assert.equal(((await res2.json()) as View).draft.version, 3);
  });

  it('a bad op → 400 {error, code} and the draft is unchanged', async () => {
    const d = await create('Bad');
    const before = await get(d.id);
    const res = await send('PATCH', `/plan-drafts/${d.id}`, {
      ops: [{ op: 'add_node', node: node('a', wsId) }, { op: 'add_edge', from: 'a', to: 'nope' }],
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, 'unknown_node');
    assert.ok(body.error);
    assert.deepEqual(await get(d.id), before);
  });

  it('a version mismatch → 409 {error, version} and nothing applied', async () => {
    const d = await create('Stale');
    const res = await send('PATCH', `/plan-drafts/${d.id}`, { version: 7, ops: [{ op: 'set_title', title: 'X' }] });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; version: number };
    assert.equal(body.version, 1);
    assert.ok(body.error);
    assert.equal((await get(d.id)).draft.title, 'Stale');
  });

  it('a cycle → layout null + a cycle error', async () => {
    const d = await create('Cycle');
    const res = await send('PATCH', `/plan-drafts/${d.id}`, {
      ops: [
        { op: 'add_node', node: node('a', wsId) },
        { op: 'add_node', node: node('b', wsId) },
        { op: 'add_edge', from: 'a', to: 'b' },
        { op: 'add_edge', from: 'b', to: 'a' },
      ],
    });
    assert.equal(res.status, 200);
    const view = (await res.json()) as View;
    assert.equal(view.layout, null);
    assert.deepEqual(
      view.validation.errors.map((e) => e.code),
      ['cycle'],
    );
  });

  it('delete, then the id is unknown → 404 on every route', async () => {
    const d = await create('Doomed');
    const del = await send('DELETE', `/plan-drafts/${d.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { deleted: d.id });
    assert.equal((await fetch(`${base}/plan-drafts/${d.id}`)).status, 404);
    assert.equal((await send('PATCH', `/plan-drafts/${d.id}`, { ops: [] })).status, 404);
    assert.equal((await send('DELETE', `/plan-drafts/${d.id}`)).status, 404);
    assert.equal((await fetch(`${base}/plan-drafts?workspace=nope`)).status, 404);
    assert.equal((await send('POST', '/plan-drafts', { workspace: 'nope', title: 'x' })).status, 404);
  });

  it('a WS client on the workspace receives plan_draft on PATCH and plan_draft_removed on DELETE', async () => {
    const d = await create('Live');
    const sock = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws?project=${wsId}`);
    const seen: any[] = [];
    const waitFor = (type: string) =>
      new Promise<any>((resolve) => {
        const check = () => {
          const m = seen.find((x) => x.type === type);
          if (m) resolve(m);
          else setTimeout(check, 10);
        };
        check();
      });
    sock.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    await new Promise((r) => sock.once('open', r));
    try {
      await waitFor('init');
      const res = await send('PATCH', `/plan-drafts/${d.id}`, { ops: [{ op: 'set_title', title: 'Live 2' }] });
      assert.equal(res.status, 200);
      assert.deepEqual(await waitFor('plan_draft'), { type: 'plan_draft', id: d.id, workspace_id: wsId, version: 2 });
      assert.equal((await send('DELETE', `/plan-drafts/${d.id}`)).status, 200);
      assert.deepEqual(await waitFor('plan_draft_removed'), {
        type: 'plan_draft_removed',
        id: d.id,
        workspace_id: wsId,
      });
    } finally {
      sock.terminate();
    }
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

describe('/plan-drafts writes are loopback-only', () => {
  let daemon: TestDaemon | undefined;

  before(async () => {
    daemon = await startDaemon({ env: { HOST: '0.0.0.0', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
  });

  after(async () => {
    await daemon?.stop();
  });

  it('a non-loopback caller gets 403 on POST, PATCH and DELETE', async (t) => {
    const ip = nonLoopbackIPv4();
    if (!ip) return t.skip('no non-loopback IPv4 interface on this host');
    const lan = `http://${ip}:${daemon!.port}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${lan}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call('POST', '/plan-drafts', { workspace: 'a', title: 'b' })).status, 403);
    assert.equal((await call('PATCH', '/plan-drafts/any', { ops: [] })).status, 403);
    assert.equal((await call('DELETE', '/plan-drafts/any')).status, 403);
  });
});
