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

test('sessionCwd: falls back to the input when git fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kankan-ptyenv-plain-'));
  try {
    // A nonexistent path makes git fail regardless of whether tmpdir sits in a repo.
    const missing = join(dir, 'missing');
    assert.equal(sessionCwd(missing), missing);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionEnv: binds KANKAN_PROJECT_ID + TERM + DAEMON_URL, overriding inherited values', () => {
  const env = sessionEnv(
    { PATH: '/usr/bin', HOME: '/home/u', KANKAN_PROJECT_ID: 'stale', DAEMON_URL: 'http://stale:1', TERM: 'dumb', GONE: undefined },
    'p-123',
    'http://localhost:7890',
  );
  assert.equal(env.KANKAN_PROJECT_ID, 'p-123');
  assert.equal(env.DAEMON_URL, 'http://localhost:7890');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.ok(!('GONE' in env));
});

test('sessionEnv: drops daemon-only vars', () => {
  const env = sessionEnv(
    { PATH: '/usr/bin', PORT: '7890', HOST: '0.0.0.0', DB_PATH: '/x/board.db', KANKAN_TERMINAL: '1', KANKAN_DISPATCHER: '1', KANKAN_STRICT_TARGETS: '1' },
    'p-123',
    'http://localhost:7890',
  );
  for (const k of ['PORT', 'HOST', 'DB_PATH', 'KANKAN_TERMINAL', 'KANKAN_DISPATCHER', 'KANKAN_STRICT_TARGETS']) {
    assert.ok(!(k in env), `${k} should be dropped`);
  }
  assert.equal(env.PATH, '/usr/bin');
});
