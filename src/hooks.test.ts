import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
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

  const scopeWarn = (filePath: string, projectId?: string) =>
    spawnSync(process.execPath, [join(HOOKS, 'scope-warn.js')], {
      input: JSON.stringify({ cwd: wsRoot, tool_name: 'Edit', tool_input: { file_path: filePath } }),
      env: env(projectId),
      encoding: 'utf8',
    });

  it('scope-warn: vertical-bound edit inside its root is silent', () => {
    const r = scopeWarn(join(vRoot, 'src', 'x.ts'), verticalId);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
  });

  it('scope-warn: vertical-bound edit elsewhere in the workspace warns (exit 2)', () => {
    const file = join(wsRoot, 'web', 'x.ts');
    const r = scopeWarn(file, verticalId);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(`[kankan] scope: ${file} is outside vertical "api" (${vRoot}).`), r.stderr);
    assert.match(r.stderr, /belongs on the workspace board/);
  });

  it('scope-warn: worktree paths map back to the repo path', () => {
    const inTree = scopeWarn(join(wsRoot, '.trees', 'abc123', 'api', 'x.ts'), verticalId);
    assert.equal(inTree.status, 0, inTree.stderr);
    const outTree = scopeWarn(join(wsRoot, '.trees', 'abc123', 'other', 'x.ts'), verticalId);
    assert.equal(outTree.status, 2);
    assert.match(outTree.stderr, /\[kankan\] scope:/);
  });

  it('scope-warn: a sibling folder sharing the prefix is out of scope', () => {
    const r = scopeWarn(`${vRoot}2/x.ts`, verticalId);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /outside vertical "api"/);
  });

  it('scope-warn: unbound or workspace-bound sessions are silent', () => {
    const file = join(wsRoot, 'web', 'x.ts');
    for (const r of [scopeWarn(file), scopeWarn(file, workspaceId)]) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout + r.stderr, '');
    }
  });

  it('kankan init installs scope-warn.js and its PostToolUse entry', () => {
    const target = mkdtempSync(join(tmpdir(), 'kankan-init-'));
    try {
      const script = join(HOOKS, '..', '..', 'scripts', 'init-project.sh');
      const r = spawnSync('sh', [script, target, 'scope-test'], {
        env: {
          ...process.env,
          DAEMON_URL: daemon!.base,
          KANKAN_UPDATE: '',
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(target, '.claude', 'hooks', 'scope-warn.js')));
      const settings = JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf8'));
      const entry = settings.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
        e.hooks.some((h) => h.command.includes('scope-warn.js')),
      );
      assert.equal(entry?.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
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

  // run on-notify.js asynchronously so the ws client keeps receiving meanwhile
  const notify = (cwd: string, projectId?: string) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [join(HOOKS, 'on-notify.js')], { cwd, env: env(projectId) });
      child.on('exit', (code) => resolve(code));
      child.stdin.end(
        JSON.stringify({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', cwd }),
      );
    });
  const statusSocket = async () => {
    const ws = new WebSocket(`${daemon!.base.replace('http', 'ws')}/ws`);
    const statuses: { agent: string; verb: string; detail: string }[] = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'status') statuses.push(msg.status);
    });
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
    return { ws, statuses };
  };

  it("on-notify: a vertical-bound session broadcasts 'needs you' as the orchestrator", async () => {
    const { ws, statuses } = await statusSocket();
    try {
      assert.equal(await notify(wsRoot, verticalId), 0);
      for (let i = 0; i < 50 && statuses.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(statuses.length, 1, JSON.stringify(statuses));
      assert.equal(statuses[0].verb, 'needs you');
      assert.equal(statuses[0].agent, 'orchestrator');
      assert.equal(statuses[0].detail, 'Claude needs your permission to use Bash');
    } finally {
      ws.close();
    }
  });

  it('on-notify: no resolvable project exits 0 and broadcasts nothing', async () => {
    const stray = mkdtempSync(join(tmpdir(), 'kankan-notify-'));
    const { ws, statuses } = await statusSocket();
    try {
      assert.equal(await notify(stray), 0);
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(statuses, []);
    } finally {
      ws.close();
      rmSync(stray, { recursive: true, force: true });
    }
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

describe('init-project.sh: first commit + registration', { timeout: 180_000 }, () => {
  let daemon: TestDaemon | undefined;
  let tmp: string;
  const script = join(HOOKS, '..', '..', 'scripts', 'init-project.sh');
  const init = (target: string) =>
    spawnSync('sh', [script, target, 'init-test'], {
      env: {
        ...process.env,
        DAEMON_URL: daemon!.base,
        KANKAN_UPDATE: '',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'commit.gpgsign',
        GIT_CONFIG_VALUE_0: 'false',
      },
      encoding: 'utf8',
    });

  before(async () => {
    daemon = await startDaemon();
    tmp = mkdtempSync(join(tmpdir(), 'kankan-init-'));
  });

  after(async () => {
    await daemon?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a non-git folder gets a minimal .gitignore so .env and node_modules stay out of the first commit', () => {
    const target = join(tmp, 'fresh');
    mkdirSync(join(target, 'node_modules'), { recursive: true });
    writeFileSync(join(target, 'node_modules', 'x'), 'x');
    writeFileSync(join(target, '.env'), 'SECRET=1');
    writeFileSync(join(target, 'index.js'), '');
    const r = init(target);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(target, '.gitignore')));
    assert.match(r.stdout, /installed:.* \.gitignore/);
    const files = spawnSync('git', ['-C', target, 'ls-files'], { encoding: 'utf8' }).stdout.split('\n');
    assert.ok(files.includes('index.js'));
    assert.ok(files.includes('.gitignore'));
    assert.ok(!files.includes('.env'));
    assert.ok(!files.some((f) => f.startsWith('node_modules')));
  });

  it('an existing git repo with no commits also gets the .gitignore before the first commit', () => {
    const target = join(tmp, 'empty-repo');
    mkdirSync(target);
    assert.equal(spawnSync('git', ['init', '-q', target]).status, 0);
    writeFileSync(join(target, '.env'), 'SECRET=1');
    const r = init(target);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(target, '.gitignore')));
    const files = spawnSync('git', ['-C', target, 'ls-files'], { encoding: 'utf8' }).stdout.split('\n');
    assert.ok(files.includes('.gitignore'));
    assert.ok(!files.includes('.env'));
  });

  it('an existing .gitignore is left untouched', () => {
    const target = join(tmp, 'own-ignore');
    mkdirSync(target);
    const custom = '# mine\n*.log\n';
    writeFileSync(join(target, '.gitignore'), custom);
    const r = init(target);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), custom);
  });

  it('existing settings without a Notification key gain the on-notify.js entry', () => {
    const target = join(tmp, 'own-settings');
    mkdirSync(join(target, '.claude'), { recursive: true });
    const mine = {
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    };
    writeFileSync(join(target, '.claude', 'settings.json'), JSON.stringify(mine));
    const r = init(target);
    assert.equal(r.status, 0, r.stderr);
    const settings = JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf8'));
    assert.ok(existsSync(join(target, '.claude', 'hooks', 'on-notify.js')));
    assert.ok(
      settings.hooks.Notification?.some((e: { hooks: { command: string }[] }) =>
        e.hooks.some((h) => h.command.includes('on-notify.js')),
      ),
      JSON.stringify(settings.hooks),
    );
    assert.equal(settings.model, 'opus');
    assert.ok(
      settings.hooks.Stop.some((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command === 'echo mine')),
    );
  });

  it('a path with & and a space registers under the right root', async () => {
    const target = join(tmp, 'a&b c');
    mkdirSync(target);
    const r = init(target);
    assert.equal(r.status, 0, r.stderr);
    const res = await fetch(`${daemon!.base}/project?root=${encodeURIComponent(target)}&create=0`);
    const body = (await res.json()) as { project_id?: string };
    assert.ok(body.project_id, JSON.stringify(body));
  });
});
