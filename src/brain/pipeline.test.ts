import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('project pipeline', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-pipe-')));
  const ws = join(tmp, 'ws');
  let d: TestDaemon;
  let id = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${data.error}`), { status: res.status });
    return data;
  };
  const waitFor = async (conv: string, pred: (m: any) => boolean) => {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const { messages } = await call('GET', `/api/conversations/${encodeURIComponent(conv)}/messages`);
      const hit = messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out in ${conv}`);
  };

  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE } });
    await call('POST', '/api/workspace', { path: ws });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a project inside the workspace with git, the kit, a vault folder and requirements v1', async () => {
    const p = await call('POST', '/api/projects', { name: 'Kusic Player', description: 'Shared listening rooms.' });
    id = p.id;
    assert.equal(p.root, join(ws, 'projects', 'kusic-player'));
    assert.ok(existsSync(join(p.root, '.git')));
    assert.ok(existsSync(join(p.root, 'CLAUDE.md')));
    assert.ok(existsSync(join(p.root, '.claude', 'hooks', 'boundary.js')));
    assert.match(readFileSync(join(ws, 'vault', 'projects', 'kusic-player', 'requirements', 'current.md'), 'utf8'), /Shared listening rooms/);
    const list = await call('GET', '/api/projects');
    assert.equal(list[0].stage, 'requirements');
    await assert.rejects(call('POST', '/api/projects', { name: 'Kusic Player' }), /already exists/);
  });

  it('versions requirements and ignores unchanged saves', async () => {
    await call('POST', `/api/projects/${id}/requirements`, { markdown: '# R\n\nv2 text' });
    await call('POST', `/api/projects/${id}/requirements`, { markdown: '# R\n\nv2 text' });
    const versions = await call('GET', `/api/projects/${id}/requirements`);
    assert.deepEqual(versions.map((v: any) => v.version), [2, 1]);
  });

  it('finalising requirements locks them and opens the team step with the always-on core', async () => {
    const r = await call('POST', `/api/projects/${id}/requirements/final`);
    assert.equal(r.recommendation, true);
    const team = await call('GET', `/api/projects/${id}/team`);
    assert.deepEqual(team.recommendation.items.map((i: any) => i.key), ['architect', 'pm', 'qc', 'security']);
    assert.ok(team.recommendation.items.every((i: any) => i.required && i.reason));
    // the Main agent was asked to tailor it, in a quiet thread of its own
    await waitFor(`sys:team:${id}`, (m) => m.author === 'main' && m.kind === 'text');
  });

  it('starting the design needs an Architect, then brings in the Architect', async () => {
    const err = await fetch(`${d.base}/api/projects/${id}/design/start`, { method: 'POST' });
    assert.equal(err.status, 409);
    assert.equal((await err.json()).needs_role, 'architect');
    await call('POST', `/api/projects/${id}/team`, { keys: ['architect'] });
    await call('POST', '/api/roles', { template: 'cto' });
    const { channel } = await call('POST', `/api/projects/${id}/design/start`);
    assert.equal(channel, 'ch:kusic-player-design');
    const reply = await waitFor(channel, (m) => m.author === 'architect' && m.kind === 'text');
    assert.match(reply.body, /requirements for Kusic Player are final/);
    await assert.rejects(call('POST', `/api/projects/${id}/requirements`, { markdown: 'changed' }), /final/);
    const p = await call('GET', `/api/projects/${id}`);
    assert.equal(p.stage, 'design');
  });

  it('validates the C4 model and writes it to the vault', async () => {
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'listener', kind: 'person', name: 'Listener', description: 'Plays music' });
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'api', kind: 'container', name: 'API', technology: 'Node.js', description: 'REST API' });
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'mobile', kind: 'container', name: 'Mobile app', technology: 'Flutter', description: 'Player' });
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'db', kind: 'store', name: 'Database', technology: 'PostgreSQL', description: 'Data' });
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'api.auth', parent_id: 'api', kind: 'component', name: 'Auth', description: 'JWTs' });
    await call('POST', `/api/projects/${id}/design/relations`, { source: 'mobile', target: 'api', label: 'Calls the API', technology: 'HTTPS/JSON' });
    await assert.rejects(call('POST', `/api/projects/${id}/design/relations`, { source: 'api', target: 'db', label: 'uses' }), /specific label/);
    await assert.rejects(call('POST', `/api/projects/${id}/design/elements`, { id: 'Bad Id', kind: 'container', name: 'x' }), /element id/);
    await assert.rejects(call('POST', `/api/projects/${id}/design/elements`, { id: 'x', kind: 'robot', name: 'x' }), /kind must be/);
    const design = await call('GET', `/api/projects/${id}/design`);
    assert.equal(design.elements.length, 5);
    assert.match(readFileSync(join(ws, 'vault', 'projects', 'kusic-player', 'design', 'system-design.md'), 'utf8'), /Mobile app → API: Calls the API \[HTTPS\/JSON\]/);
    const after = await call('DELETE', `/api/projects/${id}/design/api`);
    assert.ok(!after.elements.some((e: any) => e.id === 'api' || e.id === 'api.auth'));
    assert.equal(after.relations.length, 0);
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'api', kind: 'container', name: 'API', technology: 'Node.js', description: 'REST API' });
  });

  it('finalising the design creates one vertical per app container and asks the PM for a roadmap', async () => {
    await assert.rejects(call('POST', `/api/projects/${id}/start`), /no phases yet/);
    await assert.rejects(call('POST', `/api/projects/${id}/design/final`), /needs a PM/);
    await call('POST', '/api/roles', { template: 'pm' });
    const { channel } = await call('POST', `/api/projects/${id}/design/final`);
    assert.equal(channel, 'ch:kusic-player-build');
    const p = await call('GET', `/api/projects/${id}`);
    assert.equal(p.stage, 'plan');
    assert.deepEqual(p.verticals.map((v: any) => v.name).sort(), ['API', 'Mobile app']);
    assert.ok(existsSync(join(p.root, 'mobile-app', 'README.md')));
    await waitFor(channel, (m) => m.author === 'pm' && m.kind === 'text');
  });

  it('lists and reads files inside the workspace only', async () => {
    const dir = await call('GET', '/api/files?path=vault/projects/kusic-player');
    assert.ok(dir.entries.some((e: any) => e.name === 'requirements' && e.dir));
    const file = await call('GET', '/api/files?path=vault/projects/kusic-player/decisions.md').catch((e) => e);
    assert.equal(file.status, 404);
    await assert.rejects(call('GET', '/api/files?path=../../etc'), /404/);
  });
});
