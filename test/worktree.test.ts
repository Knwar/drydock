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

  it('add: failing to record the base in git config only warns (exit 0, worktree + branch kept)', () => {
    writeFileSync(join(repo, '.git', 'config.lock'), ''); // git config can't take the lock
    let out;
    try {
      out = execFileSync(process.execPath, [SCRIPT, 'add', 'fff'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    } finally {
      rmSync(join(repo, '.git', 'config.lock'), { force: true });
    }
    assert.match(out.toString(), /\.trees\/fff on card\/fff/);
    assert.ok(existsSync(join(repo, '.trees', 'fff')));
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'card/fff'), 'card/fff');
    assert.throws(() => git(repo, 'config', '--get', 'branch.card/fff.kankanbase'));
  });

  it('releases the lock when a merge conflicts', async () => {
    card('ddd', 'shared.txt', 'from ddd\n');
    card('eee', 'shared.txt', 'from eee\n');
    assert.equal(await wtAsync('merge', 'ddd'), 0);
    assert.equal(await wtAsync('merge', 'eee'), 1);
    assert.equal(existsSync(lockDir()), false);
  });
});

describe('worktree verify gate', () => {
  let repo: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const run = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
    }
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-verify-')));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    mkdirSync(join(repo, '.ai-brain'));
    // the check: fails while broken.txt exists in the tree
    writeFileSync(join(repo, '.ai-brain', 'run.json'), JSON.stringify({ kind: 'none', verify: 'for i in $(seq 1 100); do echo noise $i; done; test ! -e broken.txt || { echo "TEST FAILED: broken.txt"; exit 1; }' }));
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('refuses to merge a card whose checks fail, prints only the tail, and merges once fixed', () => {
    run('add', 'ccc');
    const tree = join(repo, '.trees', 'ccc');
    writeFileSync(join(tree, 'broken.txt'), 'x');
    git(tree, 'add', '.');
    git(tree, 'commit', '-m', 'broken');
    const v = run('verify', 'ccc');
    assert.equal(v.code, 1);
    assert.match(v.out, /verify FAILED[\s\S]*TEST FAILED: broken.txt/);
    assert.ok(!v.out.includes('noise 1\n'), 'only the tail of a long output');
    const m = run('merge', 'ccc');
    assert.equal(m.code, 1);
    assert.match(m.out, /not merged/);
    assert.ok(existsSync(tree), 'the card stays in its worktree');
    git(tree, 'rm', '-q', 'broken.txt');
    git(tree, 'commit', '-m', 'fix');
    const ok = run('merge', 'ccc');
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /verify passed/);
  });

  it('uses package.json scripts when no verify is set, and passes when there is nothing to run', () => {
    writeFileSync(join(repo, '.ai-brain', 'run.json'), JSON.stringify({ kind: 'none' }));
    assert.match(run('verify', '.').out, /no check set/);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'echo linted', test: 'echo tested' } }));
    const r = run('verify', '.');
    assert.equal(r.code, 0);
    assert.match(r.out, /verify passed: npm run lint && npm test/);
  });
});
