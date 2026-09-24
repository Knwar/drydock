import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDaemon, type TestDaemon } from './daemon/test-daemon.js';

// Hook project resolution: a KANKAN_PROJECT_ID env binding wins when valid,
// otherwise the cwd decides. Hooks run as real child processes against a real
// test daemon.

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'hooks');

describe('hook project resolution', () => {
  let daemon: TestDaemon | undefined;
  let wsRoot: string;
  let vRoot: string;
  let workspaceId: string;
  let verticalId: string;

  // explicit env: never inherit a KANKAN_PROJECT_ID from the parent process
  const env = (projectId?: string) => {
    const e: Record<string, string> = { PATH: process.env.PATH ?? '', DAEMON_URL: daemon!.base };
    if (projectId) e.KANKAN_PROJECT_ID = projectId;
    return e;
  };
  const injectBoard = (cwd: string, projectId?: string) =>
    spawnSync(process.execPath, [join(HOOKS, 'inject-board.js')], {
      input: JSON.stringify({ cwd }),
      env: env(projectId),
      encoding: 'utf8',
    });

  before(async () => {
    daemon = await startDaemon();
    wsRoot = join(daemon.dbDir, 'workspace');
    vRoot = join(wsRoot, 'api');
    mkdirSync(vRoot, { recursive: true });
    writeFileSync(join(wsRoot, '.mcp.json'), '{}');
    const ws = await fetch(`${daemon.base}/project?root=${encodeURIComponent(wsRoot)}`);
    workspaceId = ((await ws.json()) as { project_id: string }).project_id;
    const v = await fetch(`${daemon.base}/vertical`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, name: 'api', root: vRoot }),
    });
    verticalId = ((await v.json()) as { project_id: string }).project_id;
  });

  after(async () => {
    await daemon?.stop();
  });

  it('env KANKAN_PROJECT_ID binds the vertical even from the workspace root', () => {
    const r = injectBoard(wsRoot, verticalId);
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`project_id=${verticalId} \\(api\\)`));
    assert.match(r.stdout, new RegExp(`vertical "api" of workspace "[^"]+" \\(workspace_id=${workspaceId}\\)`));
    assert.ok(r.stdout.includes(`scope: ${vRoot}.`));
  });

  it('no env: the workspace root resolves the workspace and lists its verticals', () => {
    const r = injectBoard(wsRoot);
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`project_id=${workspaceId} `));
    assert.match(r.stdout, /\[kankan\] workspace verticals:/);
    assert.ok(r.stdout.includes(`[kankan]   api (${verticalId}) — ${vRoot}`));
  });

  it('a bogus KANKAN_PROJECT_ID falls back to the cwd', () => {
    const r = injectBoard(wsRoot, 'bogus');
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`project_id=${workspaceId} `));
  });

  it("no env: the vertical's own folder resolves the vertical", () => {
    const r = injectBoard(vRoot);
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`project_id=${verticalId} `));
    assert.match(r.stdout, /vertical "api" of workspace/);
  });

  it('contextFor keeps the .trees cardId under an env binding', () => {
    const lib = pathToFileURL(join(HOOKS, 'lib.js')).href;
    const script = `const { contextFor } = await import(${JSON.stringify(lib)});
console.log(JSON.stringify(await contextFor(${JSON.stringify(join(wsRoot, '.trees', 'abc123'))})));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: env(verticalId),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { projectId: verticalId, cardId: 'abc123' });
  });
});
