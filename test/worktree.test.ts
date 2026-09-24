import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// scripts/worktree.js merge: serialized by an mkdir lock in the git common dir.
// Runs the real script against a throwaway repo.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'worktree.js');

describe('worktree merge lock', () => {
  let repo: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const lockDir = () => join(repo, '.git', 'kankan-merge.lock');
  const wt = (...args: string[]) =>
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const wtAsync = (...args: string[]) =>
    new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: repo, stdio: 'ignore' });
      child.on('close', done);
    });
  /** add card <id> and commit <file> with <content> in its worktree */
  const card = (id: string, file: string, content: string) => {
    wt('add', id);
    const tree = join(repo, '.trees', id);
    writeFileSync(join(tree, file), content);
    git(tree, 'add', file);
    git(tree, 'commit', '-m', `edit ${file} on ${id}`);
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-wt-')));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('runs concurrent merges one at a time; both land', async () => {
    card('aaa', 'a.txt', 'a\n');
    card('bbb', 'b.txt', 'b\n');
    const codes = await Promise.all([wtAsync('merge', 'aaa'), wtAsync('merge', 'bbb')]);
    assert.deepEqual(codes, [0, 0]);
    assert.ok(existsSync(join(repo, 'a.txt')));
    assert.ok(existsSync(join(repo, 'b.txt')));
    const log = git(repo, 'log', '--format=%s', 'main');
    assert.match(log, /Merge card\/aaa/);
    assert.match(log, /Merge card\/bbb/);
    assert.equal(existsSync(lockDir()), false);
  });

  it('takes over a stale lock whose owner pid is dead', async () => {
    card('ccc', 'c.txt', 'c\n');
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), 'owner'), '999999\nold\n');
    assert.equal(await wtAsync('merge', 'ccc'), 0);
    assert.ok(existsSync(join(repo, 'c.txt')));
    assert.equal(existsSync(lockDir()), false);
  });

  it('releases the lock when a merge conflicts', async () => {
    card('ddd', 'shared.txt', 'from ddd\n');
    card('eee', 'shared.txt', 'from eee\n');
    assert.equal(await wtAsync('merge', 'ddd'), 0);
    assert.equal(await wtAsync('merge', 'eee'), 1);
    assert.equal(existsSync(lockDir()), false);
  });
});
