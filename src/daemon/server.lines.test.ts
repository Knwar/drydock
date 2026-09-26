import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// Lines written per card through the real routes: each build run's activity post
// re-measures the card's whole change (no double counting across rounds), and
// moving the merged card to done records the merge commit's numbers.

const WORKTREE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'worktree.js');

describe('daemon line counts', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  const post = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // async on purpose: a sync child blocks the event loop, so undici can miss the
  // daemon closing an idle keep-alive socket and the next request hits ECONNRESET
  const run = promisify(execFile);
  const git = (cwd: string, ...args: string[]) => run('git', args, { cwd });
  const wt = (cwd: string, ...args: string[]) => run(process.execPath, [WORKTREE, ...args], { cwd });
  const commit = async (dir: string, file: string, n: number) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), Array.from({ length: n }, (_, i) => `x${i}`).join('\n') + '\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', `edit ${file}`);
  };

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
  });
  after(async () => {
    await daemon?.stop();
  });

  it('rebuilds replace, not add; done records the merge commit', async () => {
    const repo = join(daemon!.dbDir, 'repo');
    mkdirSync(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await commit(repo, 'README.md', 1);
    await git(repo, 'checkout', '-b', 'feat');
    await commit(repo, 'old.ts', 500); // on the base branch, not the card's work

    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(repo)}`)).json()) as any).project_id;
    const id = ((await (await post('/task', { project_id: project, title: 'card' })).json()) as any).task_id;
    await post(`/task/${id}`, { assigned_agent: 'Ada', worktree_path: `.trees/${id}`, branch: `card/${id}` }, 'PATCH');
    await wt(repo, 'add', id);
    const tree = join(repo, '.trees', id);
    const stats = async () => ((await (await fetch(`${base}/stats?project=${project}`)).json()) as any).totals;

    await commit(tree, 'src/a.ts', 10);
    await commit(tree, 'package-lock.json', 400);
    assert.equal((await post(`/task/${id}/activity`, { agent: 'builder', tokens: 100 })).status, 200);
    let t = await until(stats, (x) => x.lines_added === 10);
    assert.deepEqual([t.lines_added, t.tokens], [10, 100]);

    await commit(tree, 'src/a.ts', 25); // second round
    await post(`/task/${id}/activity`, { agent: 'builder', tokens: 50 });
    t = await until(stats, (x) => x.lines_added === 25);
    assert.deepEqual([t.lines_added, t.tokens], [25, 150]);

    await commit(repo, 'src/b.ts', 3); // the base moves on meanwhile
    await wt(repo, 'merge', id);
    await post(`/task/${id}/move`, { lane: 'done' });
    t = await until(stats, (x) => x.lines_removed === 0 && x.lines_added === 25);
    assert.deepEqual([t.lines_added, t.lines_removed, t.cards], [25, 0, 1]);
  });
});

/** Poll `read` until `ok` holds (the recount lands after the response). */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// A slow git (a PATH shim that sleeps on the recount's log/diff calls) must not
// hold up the activity or done responses: they reply first, and the recount
// lands later with a card broadcast.
describe('daemon line counts: slow git', () => {
  const SLOW_S = 3;
  let daemon: TestDaemon | undefined;
  let base: string;
  const run = promisify(execFile);
  const git = (cwd: string, ...args: string[]) => run('git', args, { cwd });
  const post = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const timed = async (f: () => Promise<Response>) => {
    const t0 = Date.now();
    const res = await f();
    return { status: res.status, ms: Date.now() - t0 };
  };

  before(async () => {
    const realGit = (await run('which', ['git'])).stdout.trim();
    const bin = mkdtempSync(join(tmpdir(), 'kankan-slow-git-'));
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\ncase " $* " in *" --merges "*|*" --numstat "*) sleep ${SLOW_S};; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    daemon = await startDaemon({ env: { PATH: `${bin}:${process.env.PATH}` } });
    base = daemon.base;
  });
  after(async () => {
    await daemon?.stop();
  });

  it('activity and done reply before the recount, which then broadcasts the card', async () => {
    const repo = join(daemon!.dbDir, 'repo');
    mkdirSync(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'init');
    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(repo)}`)).json()) as any).project_id;
    const id = ((await (await post('/task', { project_id: project, title: 'card' })).json()) as any).task_id;
    await run(process.execPath, [WORKTREE, 'add', id], { cwd: repo });
    const tree = join(repo, '.trees', id);
    writeFileSync(join(tree, 'a.ts'), 'a\nb\nc\n');
    await git(tree, 'add', '-A');
    await git(tree, 'commit', '-m', 'a');
    const stats = async () => ((await (await fetch(`${base}/stats?project=${project}`)).json()) as any).totals;

    const sock = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws`);
    await new Promise((r) => sock.once('open', r));
    try {
      const cardMsg = new Promise<void>((resolve) =>
        sock.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'card' && msg.card?.id === id) resolve();
        }),
      );
      const act = await timed(() => post(`/task/${id}/activity`, { agent: 'builder', tokens: 1 }));
      assert.equal(act.status, 200);
      assert.ok(act.ms < SLOW_S * 1000, `activity took ${act.ms}ms`);
      assert.equal((await stats()).lines_added, 0); // not counted yet
      await cardMsg; // the recount's broadcast
      assert.equal((await stats()).lines_added, 3);

      await run(process.execPath, [WORKTREE, 'merge', id], { cwd: repo });
      const done = await timed(() => post(`/task/${id}/move`, { lane: 'done' }));
      assert.equal(done.status, 200);
      assert.ok(done.ms < SLOW_S * 1000, `done took ${done.ms}ms`);
      assert.equal((await until(stats, (t) => t.lines_added === 3)).lines_added, 3);
    } finally {
      sock.close();
    }
  });
});
