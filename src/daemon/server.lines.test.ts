import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
    assert.deepEqual([(await stats()).lines_added, (await stats()).tokens], [10, 100]);

    await commit(tree, 'src/a.ts', 25); // second round
    await post(`/task/${id}/activity`, { agent: 'builder', tokens: 50 });
    assert.deepEqual([(await stats()).lines_added, (await stats()).tokens], [25, 150]);

    await commit(repo, 'src/b.ts', 3); // the base moves on meanwhile
    await wt(repo, 'merge', id);
    await post(`/task/${id}/move`, { lane: 'done' });
    const t = await stats();
    assert.deepEqual([t.lines_added, t.lines_removed, t.cards], [25, 0, 1]);
  });
});
