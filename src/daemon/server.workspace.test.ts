import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// End-to-end coverage for the workspace/vertical HTTP routes (+ the /phase/:id
// position guard). Spawns the REAL daemon on a random port with a temp DB,
// via the shared test-daemon helper (same as server.gate.test.ts).

describe('daemon workspace/vertical routes', () => {
  let daemon: TestDaemon | undefined;
  const sockets: WebSocket[] = [];
  let dir: string;
  let port: number;
  let wsRoot: string;
  let vRoot: string;
  let workspaceId: string;
  let verticalId: string;
  const base = () => `http://127.0.0.1:${port}`;
  const get = (path: string) => fetch(`${base()}${path}`);
  const post = (path: string, body: unknown) =>
    fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  before(async () => {
    daemon = await startDaemon({
      env: { HOST: '127.0.0.1', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '' },
    });
    port = daemon.port;
    dir = daemon.dbDir;
    wsRoot = join(dir, 'workspace');
    vRoot = join(wsRoot, 'api');
    mkdirSync(vRoot, { recursive: true });
    // a set-up workspace (what `kankan init` writes) → visible in /projects
    writeFileSync(join(wsRoot, '.mcp.json'), '{}');
    const res = await get(`/project?root=${encodeURIComponent(wsRoot)}`);
    workspaceId = ((await res.json()) as { project_id: string }).project_id;
  });

  after(async () => {
    for (const ws of sockets) ws.terminate();
    await daemon?.stop();
  });

  it('POST /vertical creates a vertical and broadcasts verticals to the workspace', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?project=${workspaceId}`);
    sockets.push(ws);
    const got = new Promise<any>((resolve) =>
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'verticals') resolve(msg);
      }),
    );
    await new Promise((r) => ws.once('open', r));
    const res = await post('/vertical', { workspace_id: workspaceId, name: 'api', root: vRoot });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { project_id: string; name: string; root_path: string; parent_id: string };
    assert.equal(body.name, 'api');
    assert.equal(body.parent_id, workspaceId);
    assert.ok(body.root_path);
    verticalId = body.project_id;
    const msg = await got;
    ws.close();
    assert.equal(msg.project_id, workspaceId);
    assert.deepEqual(
      msg.verticals.map((v: { id: string }) => v.id),
      [verticalId],
    );
  });

  it('POST /vertical rejects missing fields and a bad root with 400', async () => {
    assert.equal((await post('/vertical', { workspace_id: workspaceId, name: 'x' })).status, 400);
    assert.equal((await post('/vertical', { name: 'x', root: vRoot })).status, 400);
    assert.equal((await post('/vertical', {})).status, 400);
    const bad = await post('/vertical', { workspace_id: workspaceId, name: 'x', root: join(dir, 'nope') });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /not an existing directory/);
  });

  it('GET /verticals lists the workspace verticals', async () => {
    const res = await get(`/verticals?project=${workspaceId}`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { id: string; parent_id: string }[];
    assert.deepEqual(
      rows.map((r) => [r.id, r.parent_id]),
      [[verticalId, workspaceId]],
    );
  });

  it('GET /workspace resolves from both the workspace and the vertical id', async () => {
    for (const id of [workspaceId, verticalId]) {
      const res = await get(`/workspace?project=${id}`);
      assert.equal(res.status, 200);
      const view = (await res.json()) as { workspace: { id: string }; verticals: { id: string }[] };
      assert.equal(view.workspace.id, workspaceId);
      assert.deepEqual(
        view.verticals.map((v) => v.id),
        [verticalId],
      );
    }
  });

  it('GET /workspace with an unknown id → 404', async () => {
    const res = await get('/workspace?project=does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'unknown project' });
  });

  it('GET /projects lists the vertical (with parent_id) though it has no cards or .mcp.json', async () => {
    const rows = (await (await get('/projects')).json()) as { id: string; parent_id: string | null }[];
    assert.equal(rows.find((r) => r.id === workspaceId)?.parent_id, null);
    assert.equal(rows.find((r) => r.id === verticalId)?.parent_id, workspaceId);
  });

  it('POST /phase/:id rejects a non-integer / < 1 / null position with 400', async () => {
    const created = await post('/phase', { project_id: workspaceId, title: 'P1' });
    const { phase_id } = (await created.json()) as { phase_id: string };
    for (const position of ['abc', 0, 1.5, null]) {
      const res = await post(`/phase/${phase_id}`, { position });
      assert.equal(res.status, 400, `position ${JSON.stringify(position)}`);
      assert.deepEqual(await res.json(), { error: 'position must be an integer >= 1' });
    }
    const ok = await post(`/phase/${phase_id}`, { position: 1 });
    assert.equal(ok.status, 200);
  });

  it('DELETE /project/<workspace> detaches its verticals instead of deleting them', async () => {
    const res = await fetch(`${base()}/project/${workspaceId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const view = await get(`/workspace?project=${verticalId}`);
    assert.equal(view.status, 200);
    const body = (await view.json()) as { workspace: { id: string; parent_id: string | null }; verticals: unknown[] };
    assert.equal(body.workspace.id, verticalId);
    assert.equal(body.workspace.parent_id, null);
    assert.deepEqual(body.verticals, []);
  });

  it('DELETE /project/<vertical> broadcasts verticals to its workspace', async () => {
    const wsRes = await get(`/project?root=${encodeURIComponent(join(dir, 'ws2'))}`);
    const ws2 = ((await wsRes.json()) as { project_id: string }).project_id;
    const v2Root = join(dir, 'ws2-web');
    mkdirSync(v2Root);
    const v = await post('/vertical', { workspace_id: ws2, name: 'web', root: v2Root });
    const v2 = ((await v.json()) as { project_id: string }).project_id;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?project=${ws2}`);
    sockets.push(ws);
    const got = new Promise<any>((resolve) =>
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'verticals') resolve(msg);
      }),
    );
    await new Promise((r) => ws.once('open', r));
    assert.equal((await fetch(`${base()}/project/${v2}`, { method: 'DELETE' })).status, 200);
    const msg = await got;
    ws.close();
    assert.equal(msg.project_id, ws2);
    assert.deepEqual(msg.verticals, []);
  });
});
