import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDaemon, type TestDaemon } from '../src/daemon/test-daemon.js';

// End-to-end "Workspace mode": a real daemon + a throwaway git monorepo, driven
// only through the daemon's HTTP API, scripts/worktree.js and the SessionStart
// hook — the same surfaces the MCP tools, the orchestrator and hooks use.
// Steps are ordered and share state.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREE_JS = join(ROOT, 'scripts', 'worktree.js');
const INJECT_BOARD = join(ROOT, '.claude', 'hooks', 'inject-board.js');

// git identity + no signing, for our git calls AND the worktree.js children
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  // the user's global/system config (hooks, templates, merge settings) stays out
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const env = { ...process.env, ...GIT_ENV };

describe('workspace mode end-to-end', { timeout: 180_000 }, () => {
  let daemon: TestDaemon;
  let repo: string;
  let mainBranch: string;
  let wsId: string;
  let apiId: string;
  let webId: string;
  let contractCard: string;
  let webCard: string;
  let apiCard: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commit = (cwd: string, msg: string) => git(cwd, 'commit', '-m', msg);
  const wt = (...args: string[]) =>
    new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [WORKTREE_JS, ...args], { cwd: repo, env, stdio: 'ignore' });
      child.on('close', done);
    });
  /** spawn worktree.js with stdout captured; `exited` flips on close */
  const wtWatched = (...args: string[]) => {
    const child = spawn(process.execPath, [WORKTREE_JS, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'ignore'] });
    const run = { out: '', exited: false, code: new Promise<number | null>((done) => child.on('close', done)) };
    child.stdout.on('data', (c) => (run.out += c));
    run.code.then(() => (run.exited = true));
    return run;
  };
  async function until(cond: () => boolean, what: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${daemon.base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }
  const ok = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await api<T>(method, path, body);
    assert.equal(r.status, 200, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  before(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-e2e-ws-')));
    git(repo, 'init');
    mkdirSync(join(repo, 'api'));
    mkdirSync(join(repo, 'web'));
    writeFileSync(join(repo, 'api', 'README.md'), 'api\n');
    writeFileSync(join(repo, 'web', 'README.md'), 'web\n');
    writeFileSync(join(repo, 'package.json'), '{ "name": "mono", "private": true }\n');
    git(repo, 'add', '.');
    commit(repo, 'init');
    mainBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    daemon = await startDaemon();
  });

  after(async () => {
    await daemon?.stop();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('registers the workspace and api/web verticals (kit shared)', async () => {
    wsId = (await ok('GET', `/project?root=${encodeURIComponent(repo)}`)).project_id;
    assert.ok(wsId);
    const a = await ok('POST', '/vertical', { workspace_id: wsId, name: 'api', root: join(repo, 'api') });
    const w = await ok('POST', '/vertical', { workspace_id: wsId, name: 'web', root: join(repo, 'web') });
    assert.equal(a.kit, 'shared');
    assert.equal(w.kit, 'shared');
    assert.equal(a.parent_id, wsId);
    assert.equal(w.parent_id, wsId);
    apiId = a.project_id;
    webId = w.project_id;
  });

  it('gates a web card on a workspace contract card (cross-board depends_on)', async () => {
    contractCard = (await ok('POST', '/task', { project_id: wsId, title: 'API contract' })).task_id;
    webCard = (await ok('POST', '/task', { project_id: webId, title: 'Web client', depends_on: [contractCard] })).task_id;
    apiCard = (await ok('POST', '/task', { project_id: apiId, title: 'API endpoint' })).task_id;

    assert.equal(await ok('GET', `/next?project=${webId}`), null);
    assert.equal((await ok('GET', `/next?project=${apiId}`)).id, apiCard);
  });

  it('merges two worktrees concurrently via the merge lock', async () => {
    assert.equal(await wt('add', apiCard), 0);
    assert.equal(await wt('add', contractCard), 0);
    const apiTree = join(repo, '.trees', apiCard);
    const contractTree = join(repo, '.trees', contractCard);
    writeFileSync(join(apiTree, 'api', 'x.ts'), 'export const x = 1;\n');
    git(apiTree, 'add', '.');
    commit(apiTree, 'api: endpoint');
    writeFileSync(join(contractTree, 'contract.json'), '{ "x": "number" }\n');
    git(contractTree, 'add', '.');
    commit(contractTree, 'contract');

    // Hold the lock ourselves (owner = this live pid → never stale) so both
    // merges provably contend for it, then release it.
    const common = resolve(repo, git(repo, 'rev-parse', '--git-common-dir'));
    const lock = join(common, 'kankan-merge.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), `${process.pid}\nholder\n`);
    const runs = [wtWatched('merge', apiCard), wtWatched('merge', contractCard)];
    try {
      await until(() => runs.every((r) => r.out.includes('waiting for another merge to finish') || r.exited), 'both merges to wait');
      assert.deepEqual(runs.map((r) => r.exited), [false, false], `a merge exited while the lock was held: ${runs.map((r) => r.out).join(' | ')}`);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    const codes = await Promise.all(runs.map((r) => r.code));
    assert.deepEqual(codes, [0, 0]);

    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), mainBranch);
    assert.equal(readFileSync(join(repo, 'api', 'x.ts'), 'utf8'), 'export const x = 1;\n');
    assert.ok(existsSync(join(repo, 'contract.json')));
    const log = git(repo, 'log', '--format=%s', mainBranch);
    assert.match(log, new RegExp(`Merge card/${apiCard}`));
    assert.match(log, new RegExp(`Merge card/${contractCard}`));
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(apiTree), false);
    assert.equal(existsSync(contractTree), false);

    // merged → done, as the orchestrator does on a pass
    assert.equal((await ok('POST', `/task/${apiCard}/move`, { lane: 'done' })).lane, 'done');
  });

  it('ungates the web card once the contract card is done', async () => {
    assert.equal((await ok('POST', `/task/${contractCard}/move`, { lane: 'done' })).lane, 'done');
    const next = await ok('GET', `/next?project=${webId}`);
    assert.equal(next.id, webCard);
  });

  it('summarizes boards, session states and lanes', async () => {
    await ok('POST', '/status', { project_id: webId, agent: 'orchestrator', verb: 'needs you', detail: 'pick a UI kit' });
    await ok('POST', '/status', { project_id: apiId, agent: 'orchestrator', verb: 'Edit', detail: 'api/x.ts' });

    const s = await ok('GET', `/workspace/summary?project=${wsId}`);
    assert.equal(s.workspace.id, wsId);
    assert.deepEqual(
      s.boards.map((b: any) => b.project.id),
      [wsId, apiId, webId],
    );
    assert.deepEqual(
      s.boards.map((b: any) => b.project.name),
      [s.workspace.name, 'api', 'web'],
    );
    const [ws, apiB, webB] = s.boards;
    assert.equal(webB.session.state, 'needs_you');
    assert.equal(apiB.session.state, 'working');
    assert.equal(ws.session.state, 'offline');
    const empty = { backlog: 0, queued: 0, in_progress: 0, in_review: 0, done: 0 };
    assert.deepEqual(ws.lanes, { ...empty, done: 1 });
    assert.deepEqual(apiB.lanes, { ...empty, done: 1 });
    assert.deepEqual(webB.lanes, { ...empty, backlog: 1 });
  });

  it('SessionStart hook bound to a vertical prints its role line', async () => {
    const out = await new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, [INJECT_BOARD], {
        cwd: repo,
        env: { PATH: process.env.PATH ?? '', DAEMON_URL: daemon.base, KANKAN_PROJECT_ID: webId },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('error', fail);
      child.on('close', (code) => (code === 0 ? done(stdout) : fail(new Error(`hook exited ${code}`))));
      child.stdin.end(JSON.stringify({ cwd: repo }));
    });
    assert.match(out, new RegExp(`project_id=${webId}\\b`));
    assert.match(out, /vertical "web" of workspace/);
    assert.match(out, new RegExp(`workspace_id=${wsId}`));
  });
});
