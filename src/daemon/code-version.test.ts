import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cachedCodeVersion, readCodeVersion } from './code-version.js';

describe('code version', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const at = (file: string, sec: number) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), 'x\n');
    utimesSync(join(root, file), sec, sec);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kankan-codever-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('outside git: sha null; mtime is the newest non-test file under src/daemon and src/core', async () => {
    at('src/core/a.ts', 1_000);
    at('src/daemon/deep/b.ts', 2_000);
    at('src/daemon/b.test.ts', 9_000); // tests don't count
    at('src/overlay/app.js', 9_000); // outside the watched folders
    assert.deepEqual(await readCodeVersion(root), { sha: null, mtime: 2_000_000 });
    assert.deepEqual(await readCodeVersion(join(root, 'nope')), { sha: null, mtime: 0 });
  });

  it('reads the short HEAD sha; the cached reader holds its value for the ttl', async () => {
    at('src/core/a.ts', 1_000);
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'init');
    const v = await readCodeVersion(root);
    assert.equal(v.sha, git('rev-parse', '--short', 'HEAD'));
    const read = cachedCodeVersion(root, 60_000);
    assert.deepEqual(await read(), v);
    at('src/core/a.ts', 5_000);
    assert.deepEqual(await read(), v); // cached
    assert.equal((await cachedCodeVersion(root, 0)()).mtime, 5_000_000);
  });
});
