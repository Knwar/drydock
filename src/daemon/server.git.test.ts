import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// Source Control lists every file the branch changed vs its base — committed,
// uncommitted, untracked and deleted — not just the working tree's changes.

describe('daemon /git/status', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  const run = promisify(execFile);
  const git = (cwd: string, ...args: string[]) => run('git', args, { cwd });

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
  });
  after(async () => {
    await daemon?.stop();
  });

  it('lists the branch changes vs main plus uncommitted and untracked files', async () => {
    const repo = join(daemon!.dbDir, 'repo');
    mkdirSync(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'keep.txt'), 'keep\n');
    writeFileSync(join(repo, 'gone.txt'), 'gone\n');
    writeFileSync(join(repo, 'edit.txt'), 'v1\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'base');
    await git(repo, 'checkout', '-b', 'feat');
    writeFileSync(join(repo, 'committed.txt'), 'new\n'); // committed on the branch
    rmSync(join(repo, 'gone.txt'));
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'branch work');
    writeFileSync(join(repo, 'edit.txt'), 'v2\n'); // uncommitted edit
    writeFileSync(join(repo, 'loose.txt'), 'loose\n'); // untracked

    const project = ((await (await fetch(`${base}/project?root=${encodeURIComponent(repo)}`)).json()) as any).project_id;
    const status = (await (await fetch(`${base}/git/status?project=${project}`)).json()) as any;
    assert.equal(status.branch, 'feat');
    assert.equal(status.base, 'main');
    const byPath = Object.fromEntries(status.files.map((f: any) => [f.path, f.status]));
    assert.deepEqual(byPath, { 'committed.txt': 'A', 'edit.txt': 'M', 'gone.txt': 'D', 'loose.txt': '??' });

    const diff = await (await fetch(`${base}/git/diff?project=${project}&file=committed.txt`)).text();
    assert.match(diff, /\+new/); // committed work diffs against the base, not HEAD

    // on main itself (no upstream): only the uncommitted changes
    await git(repo, 'stash', '-u');
    await git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'keep.txt'), 'changed\n');
    const onMain = (await (await fetch(`${base}/git/status?project=${project}`)).json()) as any;
    assert.equal(onMain.base, 'HEAD');
    assert.deepEqual(onMain.files, [{ status: 'M', path: 'keep.txt' }]);
  });
});
