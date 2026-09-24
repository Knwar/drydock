import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionCwd, sessionEnv } from './pty-env.js';

test('sessionCwd: a subfolder of a git repo resolves to the repo root', () => {
  const repo = mkdtempSync(join(tmpdir(), 'kankan-ptyenv-git-'));
  try {
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    const sub = join(repo, 'apps', 'mobile');
    mkdirSync(sub, { recursive: true });
    assert.equal(realpathSync(sessionCwd(sub)), realpathSync(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('sessionCwd: a non-git dir is returned unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kankan-ptyenv-plain-'));
  try {
    assert.equal(sessionCwd(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionEnv: binds KANKAN_PROJECT_ID + TERM, overriding an inherited binding', () => {
  const env = sessionEnv({ PATH: '/usr/bin', KANKAN_PROJECT_ID: 'stale', TERM: 'dumb', GONE: undefined }, 'p-123');
  assert.equal(env.KANKAN_PROJECT_ID, 'p-123');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.PATH, '/usr/bin');
  assert.ok(!('GONE' in env));
});
