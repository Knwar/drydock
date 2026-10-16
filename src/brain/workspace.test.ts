import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { isInside, readConfig, resolveDbPath, setupWorkspace } from './workspace.js';
// @ts-expect-error plain JS hook, no types
import { checkToolCall } from '../../.claude/hooks/boundary.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-ws-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
const env = { BRAIN_HOME: join(tmp, 'home') } as NodeJS.ProcessEnv;

describe('setupWorkspace', () => {
  it('creates the layout, root settings and the pointer, and moves the DB into the workspace', () => {
    assert.equal(resolveDbPath(env), join(tmp, 'home', 'bootstrap.db'));
    const ws = setupWorkspace(join(tmp, 'ws'), env);
    for (const d of ['vault/projects', 'vault/personal/daily', 'projects', '.ai-brain']) assert.ok(existsSync(join(ws.root, d)), d);
    const settings = JSON.parse(readFileSync(join(ws.root, '.claude', 'settings.json'), 'utf8'));
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /boundary\.js/);
    assert.equal(readConfig(env).workspace, ws.root);
    assert.equal(resolveDbPath(env), join(ws.root, '.ai-brain', 'board.db'));
    assert.equal(resolveDbPath({ ...env, DB_PATH: '/x/y.db' }), '/x/y.db');
  });

  it('is idempotent and keeps files the user changed', () => {
    const first = setupWorkspace(join(tmp, 'ws'), env);
    const again = setupWorkspace(join(tmp, 'ws'), env);
    assert.deepEqual(first, again);
  });

  it('refuses relative paths, / and the home folder', () => {
    assert.throws(() => setupWorkspace('relative/ws', env), /absolute/);
    assert.throws(() => setupWorkspace('/', env), /dedicated/);
  });
});

describe('isInside', () => {
  it('handles prefixes, .. and symlinks', () => {
    mkdirSync(join(tmp, 'root', 'a'), { recursive: true });
    mkdirSync(join(tmp, 'rootish'), { recursive: true });
    symlinkSync(join(tmp, 'rootish'), join(tmp, 'root', 'escape'));
    assert.ok(isInside(join(tmp, 'root'), join(tmp, 'root', 'a', 'new-file.txt')));
    assert.ok(!isInside(join(tmp, 'root'), join(tmp, 'rootish')));
    assert.ok(!isInside(join(tmp, 'root'), join(tmp, 'root', 'a', '..', '..', 'rootish')));
    assert.ok(!isInside(join(tmp, 'root'), join(tmp, 'root', 'escape', 'secret')));
  });
});

describe('boundary hook', () => {
  const root = join(tmp, 'guard');
  mkdirSync(join(root, 'projects', 'kusic'), { recursive: true });
  const cwd = join(root, 'projects', 'kusic');
  const home = '/Users/someone';
  const check = (tool: string, input: object, at = cwd) => checkToolCall({ root, cwd: at, tool, input, home });

  it('allows file tools inside the workspace', () => {
    assert.equal(check('Read', { file_path: join(cwd, 'src/a.ts') }), null);
    assert.equal(check('Write', { file_path: 'notes.md' }), null);
    assert.equal(check('Glob', { pattern: '**/*.ts' }), null);
    assert.equal(check('Grep', { pattern: 'TODO', path: join(root, 'vault') }), null);
  });

  it('blocks file tools that leave it', () => {
    assert.match(check('Read', { file_path: '/etc/passwd' }), /outside the AI Brain workspace/);
    assert.match(check('Edit', { file_path: '../../../outside.txt' }), /outside/);
    assert.match(check('Read', { file_path: '~/.ssh/id_rsa' }), /outside/);
    assert.match(check('Glob', { pattern: '/Users/**/*.env' }), /outside/);
    assert.match(check('Grep', { pattern: 'x', path: '/' }), /outside/);
    assert.match(check('NotebookEdit', { notebook_path: '/tmp/n.ipynb' }), /outside/);
  });

  it('checks shell commands', () => {
    assert.equal(check('Bash', { command: 'npm test && git status' }), null);
    assert.equal(check('Bash', { command: 'ls ../ 2>/dev/null' }), null); // ../ from kusic is projects/
    assert.equal(check('Bash', { command: '/usr/bin/env node scripts/x.js > out.log' }), null);
    assert.equal(check('Bash', { command: 'curl https://example.com/a/b' }), null);
    assert.match(check('Bash', { command: 'cat /etc/hosts' }), /outside/);
    assert.match(check('Bash', { command: 'cd ../../.. && ls' }), /outside/);
    assert.match(check('Bash', { command: 'cp secrets.txt ~/Desktop/' }), /outside/);
    assert.match(check('Bash', { command: 'rm -rf $HOME/stuff' }), /outside/);
    assert.match(check('Bash', { command: 'git -C /Users/someone/other status' }), /outside/);
    assert.match(check('Bash', { command: "echo hi > '/tmp/x'" }), /outside/);
  });

  it('runs as a hook: exit 2 with the reason on stderr when blocked, exit 0 otherwise', () => {
    const hook = join(import.meta.dirname, '..', '..', '.claude', 'hooks', 'boundary.js');
    const run = (input: object) =>
      spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd, ...input }), env: { ...process.env, BRAIN_WORKSPACE: root }, encoding: 'utf8' });
    const blocked = run({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /outside the AI Brain workspace/);
    assert.equal(run({ tool_name: 'Read', tool_input: { file_path: join(cwd, 'a.ts') } }).status, 0);
  });

  it('leaves sessions outside the workspace alone, and does nothing without a workspace', () => {
    assert.equal(check('Read', { file_path: '/etc/hosts' }, '/somewhere/else'), null);
    assert.equal(checkToolCall({ root: null, cwd, tool: 'Read', input: { file_path: '/etc/hosts' } }), null);
  });
});
