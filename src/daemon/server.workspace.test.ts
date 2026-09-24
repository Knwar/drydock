import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// Git in temp repos must not depend on the user's global config (identity, signing).
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'kankan-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'kankan-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdio: 'ignore',
  });
/** A git repo with one commit (so init has nothing to commit). */
function makeRepo(root: string) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
}

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
      // GIT_ENV: init (run by POST /vertical for separate repos) may commit
      env: { HOST: '127.0.0.1', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '', ...GIT_ENV },
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

describe('POST /vertical kit install (monorepo vs separate repo)', () => {
  const INIT_TIMEOUT = 120_000; // init may build dist/ on first run
  let daemon: TestDaemon | undefined;
  let tmp: string;
  let wsRoot: string;
  let workspaceId: string;
  const post = (path: string, body: unknown) =>
    fetch(`${daemon!.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const projects = async () =>
    (await (await fetch(`${daemon!.base}/projects`)).json()) as { id: string; name: string; parent_id: string | null }[];

  before(async () => {
    daemon = await startDaemon({ env: GIT_ENV });
    tmp = mkdtempSync(join(tmpdir(), 'kankan-vertical-kit-'));
    wsRoot = join(tmp, 'workspace');
    makeRepo(wsRoot);
    writeFileSync(join(wsRoot, '.mcp.json'), '{}');
    const res = await fetch(`${daemon.base}/project?root=${encodeURIComponent(wsRoot)}`);
    workspaceId = ((await res.json()) as { project_id: string }).project_id;
  });

  after(async () => {
    await daemon?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('monorepo subfolder → kit shared, nothing written into the subfolder', async () => {
    const sub = join(wsRoot, 'api');
    mkdirSync(sub);
    const res = await post('/vertical', { workspace_id: workspaceId, name: 'api', root: sub });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { kit: string }).kit, 'shared');
    assert.equal(existsSync(join(sub, '.mcp.json')), false);
  });

  it('separate repo → kit installed, adopted as a vertical without a duplicate project', { timeout: INIT_TIMEOUT }, async () => {
    const sep = join(tmp, 'web');
    makeRepo(sep);
    const res = await post('/vertical', { workspace_id: workspaceId, name: 'web', root: sep });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { project_id: string; parent_id: string; kit: string };
    assert.equal(body.kit, 'installed');
    assert.equal(body.parent_id, workspaceId);
    assert.ok(existsSync(join(sep, '.mcp.json')));
    assert.ok(existsSync(join(sep, '.claude', 'hooks', 'lib.js')));
    // init was pointed at THIS test daemon, not a real one on :7890
    assert.match(readFileSync(join(sep, '.mcp.json'), 'utf8'), new RegExp(`localhost:${daemon!.port}`));
    const view = (await (await fetch(`${daemon!.base}/workspace?project=${workspaceId}`)).json()) as {
      verticals: { id: string }[];
    };
    assert.ok(view.verticals.some((v) => v.id === body.project_id));
    // init registered it as 'web' (folder basename); adoption must not leave a second one
    const rows = (await projects()).filter((r) => r.name === 'web');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, body.project_id);
    assert.equal(rows[0].parent_id, workspaceId);
  });

  it('subfolder of another repo → kit skipped, nothing written into that repo', async () => {
    const other = join(tmp, 'other');
    makeRepo(other);
    const sub = join(other, 'pkg');
    mkdirSync(sub);
    const res = await post('/vertical', { workspace_id: workspaceId, name: 'pkg', root: sub });
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { kit: string }).kit, /^skipped: folder is inside another repo/);
    assert.equal(existsSync(join(other, '.mcp.json')), false);
    assert.equal(existsSync(join(sub, '.mcp.json')), false);
  });

  it('a vertical as workspace_id → 400 before any kit is written (validation precedes init)', async () => {
    const sub = join(wsRoot, 'svc');
    mkdirSync(sub);
    const vRes = await post('/vertical', { workspace_id: workspaceId, name: 'svc', root: sub });
    const verticalId = ((await vRes.json()) as { project_id: string }).project_id;
    const sep = join(tmp, 'mobile');
    makeRepo(sep);
    const res = await post('/vertical', { workspace_id: verticalId, name: 'mobile', root: sep });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /verticals cannot have verticals/);
    assert.equal(existsSync(join(sep, '.mcp.json')), false);
    assert.equal(existsSync(join(sep, '.claude')), false);
  });

  it('init failure → 500 with stderr tail, no vertical created', { timeout: INIT_TIMEOUT }, async () => {
    // The kankan checkout is its own git toplevel, and init refuses to bootstrap
    // kankan into itself — a portable, guaranteed init failure.
    const knwrRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const before = (await projects()).length;
    const res = await post('/vertical', { workspace_id: workspaceId, name: 'self', root: knwrRoot });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, 'kit install failed');
    assert.match(body.detail, /refusing to bootstrap knwr into itself/);
    assert.equal((await projects()).length, before);
  });
});
