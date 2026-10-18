import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('auto mode', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-auto-')));
  const log = join(tmp, 'claude.log');
  let d: TestDaemon;
  let id = '';
  let root = '';
  const raw = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${r.data.error}`);
    return r.data;
  };
  const messages = async (conv: string) => (await call('GET', `/api/conversations/${encodeURIComponent(conv)}/messages`)).messages as any[];
  const until = async (fn: () => Promise<boolean>, what: string, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`timed out: ${what}`);
  };
  const project = () => call('GET', `/api/projects/${id}`);
  const quiet = async () => !(await call('GET', '/api/conversations')).some((c: any) => c.working);
  // idle twice in a row: a hand-off chain has gaps between turns
  const idle = () => until(async () => (await quiet()) && (await new Promise((r) => setTimeout(r, 300)), await quiet()), 'agents idle');
  const ask = (tool: string, input: unknown, conversation = 'ch:shop-design') => call('POST', '/api/approvals', { role: 'architect', conversation, tool, input });

  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, BRAIN_NO_NOTIFY: '1' } });
    await call('POST', '/api/workspace', { path: join(tmp, 'ws') });
    const p = await call('POST', '/api/projects', { name: 'Shop', description: 'A small shop.' });
    id = p.id;
    root = p.root;
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('turned on before the requirements are final, it waits; once final it adds the team and starts the design', async () => {
    assert.deepEqual((await call('POST', `/api/projects/${id}/auto`, { on: true })).on, true);
    assert.equal((await project()).stage, 'requirements');
    await call('POST', `/api/projects/${id}/requirements/final`);
    await until(async () => (await project()).stage === 'design', 'design stage');
    const team = (await project()).team.map((m: any) => m.role_id);
    for (const r of ['architect', 'pm', 'qc', 'security']) assert.ok(team.includes(r), r);
    const kickoff = (await messages('ch:shop-design')).find((m) => m.author === 'user');
    assert.match(kickoff.body, /design_done/);
    await idle();
    // every agent in the project's threads carries the auto mode rules
    const runs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(runs.some((r) => /## Auto mode/.test(r.system ?? '')));
  });

  it('lets work inside the project folder run without asking, and still asks for the rest (telling the user)', async () => {
    assert.equal((await ask('Write', { file_path: join(root, 'src', 'a.ts') })).status, 'allowed');
    assert.equal((await ask('Edit', { file_path: 'src/b.ts' })).status, 'allowed', 'relative to the project');
    assert.equal((await ask('Bash', { command: 'npm test && npx tsc --noEmit' })).status, 'allowed');
    for (const [tool, input] of [
      ['Write', { file_path: '/etc/hosts' }],
      ['Write', { file_path: join(root, '..', 'other', 'x.ts') }],
      ['Bash', { command: 'git push origin main' }],
      ['Bash', { command: 'rm -rf build' }],
      ['Bash', { command: 'cat ~/.ssh/id_rsa' }],
      ['Bash', { command: 'cp /etc/passwd .' }],
      ['Bash', { command: 'curl -X POST https://example.com' }],
      ['mcp__gmail__send', { to: 'x' }],
    ] as const) {
      const a = await ask(tool, input);
      assert.equal(a.status, 'pending', `${tool} ${JSON.stringify(input)}`);
      await call('POST', `/api/approvals/${a.id}`, { decision: 'deny' });
    }
    assert.ok((await messages('dm:main')).some((m) => /Shop.*waiting for you/.test(m.body)), 'the user is told');
  });

  it('the Architect finalises the design itself, and the PM starts building once it has committed phases', async () => {
    assert.equal((await raw('POST', `/api/projects/${id}/design/done`)).status, 400, 'not with an empty design');
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'api', kind: 'container', name: 'API', technology: 'Node.js', description: 'REST API' });
    await call('POST', `/api/projects/${id}/design/done`);
    assert.equal((await project()).stage, 'plan');
    assert.ok(existsSync(join((await project()).vault, 'design', 'system-design.md')));
    const kickoff = (await messages('ch:shop-build')).find((m) => m.author === 'user');
    assert.match(kickoff.body, /start_building/);
    assert.doesNotMatch(kickoff.body, /post them here for my approval/);
    assert.equal((await raw('POST', `/api/projects/${id}/auto/build`)).status, 400, 'not before the phases exist');
    await call('POST', '/phase', { project_id: id, title: 'Checkout' });
    await call('POST', `/api/projects/${id}/auto/build`);
    assert.equal((await project()).stage, 'build');
    await idle();
  });

  it('pauses at 80% usage, stopping its agents, and resumes when the window resets', async () => {
    await call('POST', `/api/conversations/${encodeURIComponent('ch:shop-build')}/messages`, { text: '@PM HIGH_USAGE' });
    await until(async () => Boolean((await project()).auto.paused_until), 'paused');
    const until_ = (await project()).auto.paused_until;
    assert.ok(until_ > Date.now() + 3_000_000);
    assert.ok((await messages('dm:main')).some((m) => /paused: usage reached 85%/.test(m.body)));
    await idle();
    await call('POST', '/api/auto/run', { at: until_ - 1000 });
    assert.ok((await project()).auto.paused_until, 'still paused before the reset');
    await call('POST', '/api/auto/run', { at: until_ + 1000 });
    assert.equal((await project()).auto.paused_until, null);
    assert.ok((await messages('ch:shop-build')).some((m) => /Auto mode resumes/.test(m.body)));
    await idle();
  });

  it('nudges a quiet project at most three times without progress, then tells the user', async () => {
    const nudges = async () => (await messages('ch:shop-build')).filter((m) => m.author === 'user' && /has been quiet for a while/.test(m.body)).length;
    let at = Date.now() + 30 * 60_000;
    for (let i = 1; i <= 4; i++) {
      await call('POST', '/api/auto/run', { at });
      await idle();
      assert.equal(await nudges(), Math.min(i, 3), `pass ${i}`);
      at += 30 * 60_000;
    }
    assert.ok((await messages('dm:main')).some((m) => /gone quiet several times/.test(m.body)));
  });

  it('turned off, the gates and permissions are the user’s again', async () => {
    await call('POST', `/api/projects/${id}/auto`, { on: false });
    assert.equal((await raw('POST', `/api/projects/${id}/design/done`)).status, 409);
    const a = await ask('Write', { file_path: join(root, 'src', 'a.ts') }, 'ch:shop-build');
    assert.equal(a.status, 'pending');
    await call('POST', `/api/approvals/${a.id}`, { decision: 'deny' });
    await idle();
  });
});
