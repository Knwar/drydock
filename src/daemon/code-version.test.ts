import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cachedCodeVersion, readCodeVersion } from './code-version.js';

describe('code version', () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const at = (file: string, sec: number, content = 'x\n') => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
    utimesSync(join(root, file), sec, sec);
  };
  const commit = () => {
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'c');
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-codever-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('fingerprint follows src/daemon + src/core code only (not tests, overlay or commits)', async () => {
    at('src/core/a.ts', 1_000);
    at('src/daemon/deep/b.ts', 2_000);
    git(root, 'init', '-q', '-b', 'main');
    commit();
    const v = await readCodeVersion(root);
    assert.equal(v.files, 2);
    assert.equal(v.sha, git(root, 'rev-parse', '--short', 'HEAD'));

    at('src/daemon/b.test.ts', 9_000); // tests don't count
    at('src/overlay/app.js', 9_000); // served live from disk: doesn't count
    commit(); // a new commit alone doesn't count either
    const same = await readCodeVersion(root);
    assert.equal(same.fingerprint, v.fingerprint);
    assert.notEqual(same.sha, v.sha); // informational only

    at('src/core/a.ts', 5_000); // touched
    const touched = await readCodeVersion(root);
    assert.notEqual(touched.fingerprint, v.fingerprint);
    at('src/core/a.ts', 5_000, 'longer\n'); // same mtime, other size
    assert.notEqual((await readCodeVersion(root)).fingerprint, touched.fingerprint);
    at('src/core/new.ts', 1_000); // a file added
    assert.equal((await readCodeVersion(root)).files, 3);
  });

  it('sha only when the root is its own git toplevel (not a project it is installed in)', async () => {
    at('pkg/src/core/a.ts', 1_000);
    git(root, 'init', '-q', '-b', 'main');
    commit();
    assert.equal((await readCodeVersion(join(root, 'pkg'))).sha, null);
    const missing = await readCodeVersion(join(root, 'nope'));
    assert.deepEqual([missing.files, missing.sha], [0, null]);
  });

  it('the cached reader holds its value for the ttl', async () => {
    at('src/core/a.ts', 1_000);
    const read = cachedCodeVersion(root, 60_000);
    const v = await read();
    at('src/core/a.ts', 5_000);
    assert.deepEqual(await read(), v); // cached
    assert.notEqual((await cachedCodeVersion(root, 0)()).fingerprint, v.fingerprint);
  });
});
