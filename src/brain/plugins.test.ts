import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('project types and plugins', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-plugins-')));
  const log = join(tmp, 'claude.log');
  let d: TestDaemon;
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${r.data.error}`);
    return r.data;
  };
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log } });
    await call('POST', '/api/workspace', { path: join(tmp, 'ws') });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  let book = '';
  it('a general project has no design stage and no software plugins; software keeps both', async () => {
    book = (await call('POST', '/api/projects', { name: 'Night Ferry', description: 'A short mystery novel.', type: 'general' })).id;
    const app = (await call('POST', '/api/projects', { name: 'Ferry App', description: 'Ticketing app.' })).id;
    const b = await call('GET', `/api/projects/${book}`);
    assert.equal(b.type, 'general');
    assert.deepEqual(b.plugins, []);
    assert.deepEqual(b.stages, ['idea', 'create', 'requirements', 'plan', 'build']);
    assert.ok(b.pluginList.every((x: any) => !x.on && !x.suggested));
    const a = await call('GET', `/api/projects/${app}`);
    assert.equal(a.type, 'software');
    assert.deepEqual(a.plugins, ['design', 'live']);
    assert.ok(a.stages.includes('design'));
  });

  it('the team step recommends only a PM and QC for general work, then goes straight to planning', async () => {
    await call('POST', `/api/projects/${book}/requirements/final`);
    const rec = (await call('GET', `/api/projects/${book}`)).recommendation;
    assert.deepEqual(rec.items.filter((i: any) => i.kind === 'core').map((i: any) => i.key), ['pm', 'qc']);
    const needs = await raw('POST', `/api/projects/${book}/design/start`);
    assert.equal(needs.status, 409);
    assert.equal(needs.data.needs_role, 'pm');
    await call('POST', `/api/projects/${book}/team`, { keys: ['pm', 'qc'] });
    const r = await call('POST', `/api/projects/${book}/design/start`);
    assert.equal(r.stage, 'plan');
    assert.equal((await call('GET', `/api/projects/${book}`)).stage, 'plan');
  });

  it("the PM's run in a general project gets no design or live tools, and no run-the-app instructions", async () => {
    const end = Date.now() + 10_000;
    let pmRun: any;
    while (Date.now() < end && !pmRun) {
      pmRun = runs().find((r) => /@PM the requirements for Night Ferry/.test(r.prompt));
      if (!pmRun) await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.ok(pmRun, 'the PM was asked to plan');
    for (const t of ['get_design', 'set_element', 'live_status', 'save_run_recipe']) assert.ok(pmRun.disabled.split(',').includes(t), t);
    assert.ok(!pmRun.system.includes('## Running the app on this Mac'));
  });

  it('a plugin can be switched on for any project, and off again', async () => {
    assert.deepEqual((await call('POST', `/api/projects/${book}/plugins`, { id: 'design', on: true })).plugins, ['design']);
    assert.deepEqual((await call('GET', '/api/projects')).find((p: any) => p.id === book).plugins, ['design']);
    assert.deepEqual((await call('POST', `/api/projects/${book}/plugins`, { id: 'design', on: false })).plugins, []);
    assert.equal((await raw('POST', `/api/projects/${book}/plugins`, { id: 'nope', on: true })).status, 400);
    const cat = await call('GET', '/api/plugins');
    assert.deepEqual(cat.types.map((t: any) => t.id), ['software', 'general']);
  });
});

describe('brain MCP server', () => {
  it('does not register the tools it is told are disabled', async () => {
    process.env.BRAIN_DISABLED_TOOLS = 'get_design,live_status';
    const { server } = await import('./mcp.js');
    const tools = Object.keys((server as any)._registeredTools);
    assert.ok(!tools.includes('get_design') && !tools.includes('live_status'));
    assert.ok(tools.includes('create_project') && tools.includes('set_element'));
    delete process.env.BRAIN_DISABLED_TOOLS;
  });
});
