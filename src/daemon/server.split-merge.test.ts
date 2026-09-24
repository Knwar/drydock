import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// POST /project/:id/split-preview, /project/:id/split and /verticals/merge
// against the REAL daemon (temp DB, random port).

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
/** A git repo with one commit, plus the given (empty) subfolders. */
function makeRepo(root: string, folders: string[] = []) {
  mkdirSync(root, { recursive: true });
  for (const f of folders) mkdirSync(join(root, f), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
}

function client(base: string) {
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const getJson = async <T = any>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;
  const project = async (root: string): Promise<string> =>
    (await getJson<{ project_id: string }>(`/project?root=${encodeURIComponent(root)}`)).project_id;
  const task = async (projectId: string, title: string): Promise<string> =>
    ((await (await post('/task', { project_id: projectId, title })).json()) as { task_id: string }).task_id;
  const edit = (projectId: string, taskId: string, file: string) =>
    post('/event', { project_id: projectId, task_id: taskId, type: 'tool', payload: { tool: 'Edit', file } });
  const move = (taskId: string, lane: string) => post(`/task/${taskId}/move`, { lane });
  const vertical = async (workspaceId: string, name: string, root: string): Promise<string> => {
    const res = await post('/vertical', { workspace_id: workspaceId, name, root });
    assert.equal(res.status, 200);
    return ((await res.json()) as { project_id: string }).project_id;
  };
  return { post, getJson, project, task, edit, move, vertical };
}

describe('split / merge routes', () => {
  let daemon: TestDaemon | undefined;
  let tmp: string;
  let c: ReturnType<typeof client>;

  before(async () => {
    // GIT_ENV: init (run by split for separate repos) may commit
    daemon = await startDaemon({ env: { KANKAN_TERMINAL: '0', ...GIT_ENV } });
    c = client(daemon.base);
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-split-')));
  });

  after(async () => {
    await daemon?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('POST /project/:id/split-preview', () => {
    let mono: string;
    let pid: string;
    let web: string;
    let api: string;
    let none: string;

    before(async () => {
      mono = join(tmp, 'preview-mono');
      makeRepo(mono, ['apps/web', 'apps/api']);
      pid = await c.project(mono);
      web = await c.task(pid, 'web card');
      api = await c.task(pid, 'api card');
      none = await c.task(pid, 'no history');
      await c.edit(pid, web, 'apps/web/src/a.ts');
      await c.edit(pid, web, 'apps/web/src/b.ts');
      await c.edit(pid, api, 'apps/api/main.go');
    });

    it('resolves targets, classifies the kit and suggests card placement — without side effects', async () => {
      const ext = join(tmp, 'preview-ext');
      makeRepo(ext);
      const other = join(tmp, 'preview-other');
      makeRepo(other, ['sub']);
      const res = await c.post(`/project/${pid}/split-preview`, {
        targets: [
          { name: 'web', folder: 'apps/web' },
          { name: 'api', folder: './apps/api/' },
          { name: 'ext', folder: ext },
          { name: 'stray', folder: join(other, 'sub') },
        ],
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        targets: { name: string; root: string; folder: string; kit: string }[];
        placement: { card: { id: string }; suggestion: string | null; confidence: string }[];
      };
      assert.deepEqual(
        body.targets.map((t) => [t.name, t.root, t.folder, t.kit]),
        [
          ['web', join(mono, 'apps/web'), 'apps/web', 'shared'],
          ['api', join(mono, 'apps/api'), 'apps/api', 'shared'],
          ['ext', ext, ext, 'installed'],
          ['stray', join(other, 'sub'), join(other, 'sub'), `skipped: folder is inside another repo (${other})`],
        ],
      );
      const byCard = new Map(body.placement.map((p) => [p.card.id, p]));
      assert.equal(byCard.get(web)?.suggestion, '0');
      assert.equal(byCard.get(web)?.confidence, 'strong');
      assert.equal(byCard.get(api)?.suggestion, '1');
      assert.equal(byCard.get(none)?.suggestion, null);
      // nothing happened: no verticals, no kit written, no stray project
      assert.deepEqual(await c.getJson(`/verticals?project=${pid}`), []);
      assert.equal(existsSync(join(ext, '.mcp.json')), false);
      const projects = await c.getJson<{ id: string }[]>('/projects');
      assert.equal(projects.length, 1);
    });

    it('rejects invalid targets with 400', async () => {
      const bad = async (targets: unknown, pattern: RegExp) => {
        const res = await c.post(`/project/${pid}/split-preview`, { targets });
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error: string }).error, pattern);
      };
      await bad([{ name: 'x', folder: 'apps/nope' }], /not an existing directory/);
      await bad([{ name: 'x', folder: '.' }], /must differ/);
      await bad(
        [
          { name: 'a', folder: 'apps/web' },
          { name: 'b', folder: join(mono, 'apps/web') },
        ],
        /duplicate target/,
      );
      await bad([], /targets required/);
      await bad([{ name: '', folder: 'apps/web' }], /name and a folder/);
    });

    it('404 for an unknown project', async () => {
      const res = await c.post('/project/nope/split-preview', { targets: [{ name: 'x', folder: 'x' }] });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /project/:id/split', () => {
    it('splits a standalone monorepo into 2 verticals, moving cards (done cards stay)', async () => {
      const mono = join(tmp, 'split-mono');
      makeRepo(mono, ['apps/web', 'apps/api']);
      const pid = await c.project(mono);
      const a = await c.task(pid, 'a');
      const b = await c.task(pid, 'b');
      const d = await c.task(pid, 'done one');
      await c.move(d, 'done');
      const res = await c.post(`/project/${pid}/split`, {
        targets: [
          { name: 'web', root: join(mono, 'apps/web') },
          { name: 'api', root: join(mono, 'apps/api') },
        ],
        assignments: { [a]: 0, [b]: 1 },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        verticals: { id: string; name: string; parent_id: string; kit: string }[];
        moved: Record<string, string>;
      };
      assert.deepEqual(
        body.verticals.map((v) => [v.name, v.parent_id, v.kit]),
        [
          ['web', pid, 'shared'],
          ['api', pid, 'shared'],
        ],
      );
      const [webV, apiV] = body.verticals.map((v) => v.id);
      assert.deepEqual(body.moved, { [a]: webV, [b]: apiV });
      const ids = async (p: string) => (await c.getJson<{ id: string }[]>(`/board?project=${p}`)).map((x) => x.id);
      assert.deepEqual(await ids(webV), [a]);
      assert.deepEqual(await ids(apiV), [b]);
      assert.deepEqual(await ids(pid), [d]);
    });

    it('installs the kit into a separate-repo absolute target', async () => {
      const mono = join(tmp, 'split-kit-mono');
      makeRepo(mono);
      const ext = join(tmp, 'split-kit-ext');
      makeRepo(ext);
      const pid = await c.project(mono);
      const res = await c.post(`/project/${pid}/split`, { targets: [{ name: 'ext', root: ext }], assignments: {} });
      assert.equal(res.status, 200, await res.clone().text());
      const body = (await res.json()) as { verticals: { root_path: string; parent_id: string; kit: string }[] };
      assert.equal(body.verticals[0].kit, 'installed');
      assert.equal(body.verticals[0].parent_id, pid);
      assert.equal(body.verticals[0].root_path, ext);
      assert.ok(existsSync(join(ext, '.mcp.json')), '.mcp.json installed in the separate repo');
    });

    it('an in-flight card → 400 with its id, nothing changed (and no kit installed)', async () => {
      const mono = join(tmp, 'split-busy');
      makeRepo(mono, ['apps/web']);
      const ext = join(tmp, 'split-busy-ext');
      makeRepo(ext);
      const pid = await c.project(mono);
      const busy = await c.task(pid, 'busy');
      await c.move(busy, 'in_progress');
      const res = await c.post(`/project/${pid}/split`, {
        targets: [
          { name: 'web', root: join(mono, 'apps/web') },
          { name: 'ext', root: ext },
        ],
        assignments: { [busy]: 0 },
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; cardIds: string[] };
      assert.match(body.error, /in progress or in review/);
      assert.deepEqual(body.cardIds, [busy]);
      assert.deepEqual(await c.getJson(`/verticals?project=${pid}`), []);
      assert.deepEqual(
        (await c.getJson<{ id: string }[]>(`/board?project=${pid}`)).map((x) => x.id),
        [busy],
      );
      assert.equal(existsSync(join(ext, '.mcp.json')), false);
    });

    it('invalid targets → 400; unknown project → 404', async () => {
      const mono = join(tmp, 'split-bad');
      makeRepo(mono);
      const pid = await c.project(mono);
      const res = await c.post(`/project/${pid}/split`, {
        targets: [{ name: 'x', root: join(mono, 'nope') }],
        assignments: {},
      });
      assert.equal(res.status, 400);
      assert.equal((await c.post('/project/nope/split', { targets: [], assignments: {} })).status, 404);
    });
  });

  describe('POST /verticals/merge', () => {
    let ws: string;
    let alias: string; // another spelling of ws (like /var ↔ /private/var)
    let wsId: string;

    before(async () => {
      ws = join(tmp, 'merge-ws');
      makeRepo(ws, ['apps/web', 'apps/api', 'apps/busy', 'apps/idle', 'apps/extra', 'apps/p', 'apps/q']);
      alias = join(tmp, 'merge-ws-alias');
      symlinkSync(ws, alias);
      wsId = await c.project(ws);
    });

    it('merges from into into (renamed, re-rooted), broadcasting project_removed', async () => {
      const web = await c.vertical(wsId, 'web', join(ws, 'apps/web'));
      const api = await c.vertical(wsId, 'api', join(ws, 'apps/api'));
      const card = await c.task(api, 'api card');

      const sock = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws`); // all projects
      const removed = new Promise<any>((resolve) =>
        sock.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'project_removed') resolve(msg);
        }),
      );
      await new Promise((r) => sock.once('open', r));
      try {
        const res = await c.post('/verticals/merge', {
          from: api,
          into: web,
          name: 'app',
          root: join(alias, 'apps'), // alternate spelling → stored in the canonical one
          phases: 'append',
        });
        assert.equal(res.status, 200, await res.clone().text());
        const into = (await res.json()) as { id: string; name: string; root_path: string };
        assert.deepEqual([into.id, into.name, into.root_path], [web, 'app', join(ws, 'apps')]);
        assert.deepEqual(await removed, { type: 'project_removed', project_id: api });
      } finally {
        sock.terminate();
      }
      const verticals = await c.getJson<{ id: string }[]>(`/verticals?project=${wsId}`);
      assert.deepEqual(
        verticals.map((v) => v.id),
        [web],
      );
      assert.deepEqual(
        (await c.getJson<{ id: string }[]>(`/board?project=${web}`)).map((x) => x.id),
        [card],
      );
    });

    it('an in-flight card → 400 with its id; a root that is not a shared ancestor → 400', async () => {
      const busy = await c.vertical(wsId, 'busy', join(ws, 'apps/busy'));
      const idle = await c.vertical(wsId, 'idle', join(ws, 'apps/idle'));
      const card = await c.task(busy, 'working');
      await c.move(card, 'in_progress');
      const res = await c.post('/verticals/merge', { from: busy, into: idle, phases: 'fold' });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; cardIds: string[] };
      assert.match(body.error, /in progress or in review/);
      assert.deepEqual(body.cardIds, [card]);

      const elsewhere = join(tmp, 'merge-elsewhere');
      mkdirSync(elsewhere, { recursive: true });
      for (const root of [elsewhere, join(ws, 'apps/web')]) {
        const bad = await c.post('/verticals/merge', { from: busy, into: idle, root, phases: 'append' });
        assert.equal(bad.status, 400);
        assert.match(((await bad.json()) as { error: string }).error, /shared ancestor/);
      }
      const missing = await c.post('/verticals/merge', { from: busy, into: idle, root: join(tmp, 'nope'), phases: 'append' });
      assert.equal(missing.status, 400);
      // nothing changed
      const ids = (await c.getJson<{ id: string }[]>(`/verticals?project=${wsId}`)).map((v) => v.id);
      assert.ok(ids.includes(busy) && ids.includes(idle));
    });

    it('an alternate spelling of the workspace root is rejected for merge root, split target and /vertical', async () => {
      const p = await c.vertical(wsId, 'p', join(ws, 'apps/p'));
      const q = await c.vertical(wsId, 'q', join(ws, 'apps/q'));
      const merge = await c.post('/verticals/merge', { from: p, into: q, root: alias, phases: 'append' });
      assert.equal(merge.status, 400);
      assert.match(((await merge.json()) as { error: string }).error, /workspace/);

      const split = await c.post(`/project/${p}/split-preview`, { targets: [{ name: 'x', folder: alias }] });
      assert.equal(split.status, 400);
      assert.match(((await split.json()) as { error: string }).error, /workspace/);

      const vertical = await c.post('/vertical', { workspace_id: wsId, name: 'x', root: `${alias}/` });
      assert.equal(vertical.status, 400);
      assert.match(((await vertical.json()) as { error: string }).error, /workspace/);
      assert.equal((await c.getJson<unknown[]>(`/verticals?project=${wsId}`)).length, 5);
    });

    it('a valid alternate spelling is stored in the canonical spelling (/vertical, split target)', async () => {
      const res = await c.post('/vertical', { workspace_id: wsId, name: 'extra', root: join(alias, 'apps/extra') });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { root_path: string }).root_path, join(ws, 'apps/extra'));

      const mono = join(tmp, 'split-alias');
      makeRepo(mono, ['apps/web']);
      const monoAlias = join(tmp, 'split-alias-link');
      symlinkSync(mono, monoAlias);
      const pid = await c.project(mono);
      const split = await c.post(`/project/${pid}/split`, {
        targets: [{ name: 'web', root: join(monoAlias, 'apps/web') }],
        assignments: {},
      });
      assert.equal(split.status, 200, await split.clone().text());
      const body = (await split.json()) as { verticals: { root_path: string }[] };
      assert.equal(body.verticals[0].root_path, join(mono, 'apps/web'));
      // reverse direction: a workspace STORED under the alias spelling
      const inv = join(tmp, 'inv-real');
      makeRepo(inv, ['apps/web']);
      const invAlias = join(tmp, 'inv-alias');
      symlinkSync(inv, invAlias);
      const invId = await c.project(invAlias);
      const atRoot = await c.post('/vertical', { workspace_id: invId, name: 'x', root: inv });
      assert.equal(atRoot.status, 400);
      const under = await c.post('/vertical', { workspace_id: invId, name: 'web', root: join(inv, 'apps/web') });
      assert.equal(under.status, 200);
      assert.equal(((await under.json()) as { root_path: string }).root_path, join(invAlias, 'apps/web'));
      // and the workspace root itself, spelled via the alias, is rejected as a split target
      const self = await c.post(`/project/${pid}/split`, { targets: [{ name: 'x', root: monoAlias }], assignments: {} });
      assert.equal(self.status, 400);
    });

    it('bad input → 400', async () => {
      assert.equal((await c.post('/verticals/merge', { from: 'a', phases: 'append' })).status, 400);
      assert.equal((await c.post('/verticals/merge', { from: 'a', into: 'b', phases: 'nope' })).status, 400);
      assert.equal((await c.post('/verticals/merge', { from: 'a', into: 'b', phases: 'append' })).status, 400);
    });
  });
});

interface Proc { pid: number; pgid: number; command: string }

function processes(): Proc[] {
  const out = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] }));
}

describe('merge closes the removed vertical’s terminal', () => {
  it('kills from’s shell and its foreground (fake) claude, leaving nothing behind', async (t) => {
    const binDir = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-merge-bin-')));
    const wsDir = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-merge-ws-')));
    const fake = join(binDir, 'claude');
    // ignores SIGHUP, so only the SIGKILL of its own process group ends it
    writeFileSync(fake, "#!/bin/sh\ntrap '' HUP\nsleep 300\n");
    chmodSync(fake, 0o755);
    const daemon = await startDaemon({
      env: { KANKAN_TERMINAL: '1', SHELL: '/bin/sh', PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    try {
      const cfg = (await (await fetch(`${daemon.base}/config`)).json()) as { terminal: boolean; token: string | null };
      if (!cfg.terminal) return t.skip('node-pty unavailable');
      const c = client(daemon.base);
      mkdirSync(join(wsDir, 'from'));
      mkdirSync(join(wsDir, 'into'));
      const wsId = await c.project(wsDir);
      const from = await c.vertical(wsId, 'from', join(wsDir, 'from'));
      const into = await c.vertical(wsId, 'into', join(wsDir, 'into'));
      const agent = await fetch(
        `${daemon.base}/pty/agent?project=${encodeURIComponent(from)}&token=${encodeURIComponent(cfg.token!)}`,
        { method: 'POST' },
      );
      assert.equal(agent.status, 200);

      const fromDir = join(wsDir, 'from');
      const refs = (p: Proc) => p.command.includes(fromDir) || p.command.includes(binDir);
      let tracked: Proc[] = [];
      for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
        tracked = processes().filter(refs);
        if (tracked.some((p) => p.command.includes(fake))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(tracked.some((p) => p.command.includes(fake)), 'fake claude should be running');
      // the shell (not named after the dirs) and `sleep 300` are caught by process group
      const pgids = new Set(tracked.map((p) => p.pgid));
      const shellPgid = processes().find((p) => p.command.includes(fake))!.pgid;
      assert.ok(shellPgid > 1);

      const res = await c.post('/verticals/merge', { from, into, phases: 'append' });
      assert.equal(res.status, 200, await res.clone().text());

      let left: Proc[] = [];
      for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
        left = processes().filter((p) => refs(p) || pgids.has(p.pgid));
        if (left.length === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(left, [], 'processes of the removed vertical’s session survived the merge');
      assert.equal(daemon.exitCode(), null, 'the daemon itself is still running');
      assert.equal((await fetch(`${daemon.base}/config`)).status, 200);
    } finally {
      await daemon.stop();
      rmSync(binDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});

/** First non-internal IPv4 address, if the box has one. */
function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

describe('split / merge write routes are loopback-only', () => {
  let daemon: TestDaemon | undefined;

  before(async () => {
    daemon = await startDaemon({ env: { HOST: '0.0.0.0', KANKAN_TERMINAL: '0' } });
  });

  after(async () => {
    await daemon?.stop();
  });

  it('a non-loopback caller gets 403 on split-preview, split, merge and /vertical', async (t) => {
    const ip = nonLoopbackIPv4();
    if (!ip) return t.skip('no non-loopback IPv4 interface on this host');
    const lan = `http://${ip}:${daemon!.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${lan}${path}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post('/project/any/split-preview', { targets: [] })).status, 403);
    assert.equal((await post('/project/any/split', { targets: [], assignments: {} })).status, 403);
    assert.equal((await post('/vertical', { workspace_id: 'a', name: 'b', root: '/tmp' })).status, 403);
    assert.equal((await post('/verticals/merge', { from: 'a', into: 'b', phases: 'append' })).status, 403);
  });
});
