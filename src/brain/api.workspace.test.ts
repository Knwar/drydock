import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

describe('/api/workspace (onboarding)', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-api-ws-')));
  let d: TestDaemon;
  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home') } });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };

  it('starts unconfigured on the bootstrap DB', async () => {
    const r = await call('GET', '/api/workspace');
    assert.equal(r.body.configured, false);
    assert.equal(r.body.db, join(tmp, 'home', 'bootstrap.db'));
  });

  it('rejects a relative path', async () => {
    const r = await call('POST', '/api/workspace', { path: 'not/absolute' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /absolute/);
  });

  it('sets up the folder and moves the live DB into it without a restart', async () => {
    const ws = join(tmp, 'My Brain');
    const r = await call('POST', '/api/workspace', { path: ws });
    assert.equal(r.status, 200);
    assert.equal(r.body.root, ws);
    assert.equal(r.body.db, join(ws, '.ai-brain', 'board.db'));
    assert.ok(existsSync(join(ws, 'vault', 'projects')));
    assert.ok(existsSync(join(ws, '.ai-brain', 'board.db')));
    // the board API keeps working on the new DB
    const projects = await fetch(d.base + '/projects');
    assert.equal(projects.status, 200);
  });
});
