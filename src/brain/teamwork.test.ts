import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';
import { similar } from './teamwork.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('similar()', () => {
  it('treats rephrasings as the same rule and different rules as different', () => {
    assert.ok(similar('Validate every request body with zod', 'Always validate the request body with zod'));
    assert.ok(!similar('Validate every request body with zod', 'Write a migration for each schema change'));
  });
});

describe('team, learning and close-out', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-team-')));
  let d: TestDaemon;
  let id = '';
  let root = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}`);
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
    await call('POST', '/api/workspace', { path: join(tmp, 'ws') });
    const p = await call('POST', '/api/projects', { name: 'Shop', description: 'A small shop with Stripe checkout.' });
    id = p.id;
    root = p.root;
    await call('POST', `/api/projects/${id}/requirements/final`);
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps the core in the Main agent's recommendation, adds specialists, caps at 8", async () => {
    const r = await call('POST', `/api/projects/${id}/team/recommendation`, {
      members: [
        { template: 'pm', reason: 'Runs the checkout build' },
        { name: 'Flutter developer', skill: 'flutter-dev', reason: 'Mobile app in Flutter' },
        { name: 'Node API developer', skill: 'node-api', reason: 'Checkout API' },
        { template: 'cfo', reason: 'Pricing and Stripe fees' },
        { name: 'A', reason: 'x' },
        { name: 'B', reason: 'x' },
      ],
    });
    assert.equal(r.items.length, 8);
    assert.deepEqual(r.items.slice(0, 4).map((i: any) => i.key), ['architect', 'pm', 'qc', 'security']);
    assert.equal(r.items[1].reason, 'Runs the checkout build');
    assert.equal(r.items.find((i: any) => i.key === 'flutter-developer').kind, 'specialist');
  });

  it('adding members creates custom specialists with their skill and puts them on the board roster', async () => {
    const r = await call('POST', `/api/projects/${id}/team`, { keys: ['architect', 'pm', 'qc', 'security', 'flutter-developer'] });
    assert.deepEqual(r.added.sort(), ['architect', 'flutter-developer', 'pm', 'qc', 'security']);
    const role = (await call('GET', '/api/roles')).find((x: any) => x.id === 'flutter-developer');
    assert.equal(role.skill, 'flutter-dev');
    assert.equal(role.scope, 'project');
    const roster = await call('GET', '/team');
    assert.ok(roster.some((t: any) => t.name === 'Flutter developer' && t.skill === 'flutter-dev'));
    const team = await call('GET', `/api/projects/${id}/team`);
    assert.ok(team.recommendation.items.find((i: any) => i.key === 'flutter-developer').added);
  });

  it('a member the PM proposes in a project thread joins that project (and its roster), and the PM carries on', async () => {
    const ch = (await call('POST', '/api/channels', { name: 'pm', members: ['pm'], project_id: id })).id;
    const p = await call('POST', '/api/role-proposals', { role: 'pm', conversation: ch, name: 'Python developer', skill: 'python-dev', persona: 'Builds the Python core.', reason: 'the core is Python' });
    await call('POST', `/api/role-proposals/${p.message_id}`, { accept: true });
    const team = await call('GET', `/api/projects/${id}/team`);
    assert.ok(team.members.some((m: any) => m.role_id === 'python-developer' && m.kind === 'specialist'), 'on the project team');
    assert.ok((await call('GET', '/team')).some((t: any) => t.name === 'Python developer' && t.skill === 'python-dev'), 'on the board roster');
    await waitFor(ch, (m) => m.author === 'system' && /Python developer is now on this project's team/.test(m.body));
    await waitFor(ch, (m) => m.author === 'pm' && m.kind === 'text');
    // already on the user's team but not this project: offered for the project, not "already on the team"
    await call('DELETE', `/api/projects/${id}/team/python-developer`);
    const again = await call('POST', '/api/role-proposals', { role: 'pm', conversation: ch, name: 'Python developer', reason: 'still Python' });
    assert.equal(again.status, 'proposed');
    const card = (await call('GET', `/api/conversations/${encodeURIComponent(ch)}/messages`)).messages.find((m: any) => m.id === again.message_id);
    assert.equal(card.body, 'Add Python developer to this project?');
    await call('POST', `/api/role-proposals/${again.message_id}`, { accept: true });
    assert.ok((await call('GET', `/api/projects/${id}/team`)).members.some((m: any) => m.role_id === 'python-developer'));
    assert.equal((await call('POST', '/api/role-proposals', { role: 'pm', conversation: ch, name: 'Python developer', reason: 'x' })).status, 'exists');
  });

  it('routes lessons blamelessly: process causes to project memory, repeated behaviour to the member', async () => {
    const a = await call('POST', `/api/projects/${id}/lessons`, { cause: 'missing-check', lesson: 'Add a test for every webhook signature check', mechanism: 'webhook test in CI', card_id: 'c1', member: 'Flutter developer' });
    assert.equal(a.learning, null);
    const once = await call('POST', `/api/projects/${id}/lessons`, { cause: 'agent-behavior', lesson: 'Run flutter analyze before marking criteria done', card_id: 'c2', member: 'Flutter developer' });
    assert.deepEqual(once.learning, { role: 'flutter-developer', active: false });
    const twice = await call('POST', `/api/projects/${id}/lessons`, { cause: 'agent-behavior', lesson: 'Always run flutter analyze before you mark criteria done', card_id: 'c3', member: 'flutter-developer' });
    assert.deepEqual(twice.learning, { role: 'flutter-developer', active: true });
    const mem = await call('GET', `/api/projects/${id}/memory`);
    assert.equal(mem.lessons.length, 2); // the repeat merged into one lesson
    assert.equal(mem.lessons.find((l: any) => l.cause === 'agent-behavior').count, 2);
    const learned = await call('GET', '/api/learnings?member=Flutter%20developer');
    assert.equal(learned.rules.length, 1);
    await assert.rejects(call('POST', `/api/projects/${id}/lessons`, { cause: 'bad-luck', lesson: 'x' }), /cause must be/);
  });

  it('caps active learnings at 15, keeping the most frequent', async () => {
    const topics = ['migrations', 'logging', 'pagination', 'timezones', 'caching', 'retries', 'uploads', 'webhooks', 'sessions', 'emails', 'payments', 'search', 'images', 'exports', 'imports', 'locales', 'queues', 'metrics'];
    for (const [i, t] of topics.entries()) {
      for (let k = 0; k < (i < 3 ? 3 : 2); k++) await call('POST', `/api/projects/${id}/lessons`, { cause: 'agent-behavior', lesson: `Check ${t} carefully`, member: 'qc' });
    }
    const { active } = await call('GET', '/api/roles/qc/learnings');
    assert.equal(active.length, 15);
    assert.ok(['migrations', 'logging', 'pagination'].every((t) => active.some((l: any) => l.rule.includes(t)))); // the most frequent survive
  });

  it('writes a compact memory digest into the project (imported by CLAUDE.md) and the full register into the vault', async () => {
    const digest = readFileSync(join(root, '.ai-brain', 'memory.md'), 'utf8');
    assert.match(digest, /Add a test for every webhook signature check — check: webhook test in CI/);
    assert.ok(digest.length <= 6200);
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /^<!-- ai-brain:memory -->\n@\.ai-brain\/memory\.md/);
    assert.ok(existsSync(join(tmp, 'ws', 'vault', 'projects', 'shop', 'memory', 'lessons.md')));
  });

  it('close-out: the PM report opens a review with the Main agent and tells the user; sign-off closes', async () => {
    const r = await call('POST', `/api/projects/${id}/complete`, { summary: 'Checkout and catalogue shipped.' });
    assert.equal(r.channel, 'ch:shop-close-out');
    await waitFor('ch:shop-close-out', (m) => m.author === 'main' && m.kind === 'text');
    await waitFor('dm:main', (m) => m.author === 'main' && /every phase is complete/.test(m.body));
    assert.equal((await call('GET', `/api/projects/${id}`)).status, 'review');
    await call('POST', `/api/projects/${id}/enhancements`, { items: [{ title: 'Apple Pay', why: 'Faster checkout' }] });
    await call('POST', `/api/projects/${id}/status`, { status: 'closed', reason: 'completed' });
    const p = await call('GET', `/api/projects/${id}`);
    assert.equal(p.status, 'closed');
    assert.equal(p.closed_reason, 'completed');
  });

  it('check-ins escalate by idle hours and skip paused or closed projects', async () => {
    const p2 = await call('POST', '/api/projects', { name: 'Idle', description: 'x' });
    // put it in the build stage with a build thread, as the gates would
    await call('POST', `/api/projects/${p2.id}/requirements/final`);
    await call('POST', '/api/roles', { template: 'pm' });
    await call('POST', '/api/channels', { name: 'build', members: ['pm'], project_id: p2.id });
    const db = await import('better-sqlite3');
    const conn = new db.default(join(tmp, 'ws', '.ai-brain', 'board.db'));
    conn.prepare(`UPDATE brain_projects SET stage = 'build', updated_at = ? WHERE project_id = ?`).run(Date.now() - 3 * 3600_000, p2.id);
    conn.prepare(`UPDATE messages SET created_at = ? WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)`).run(Date.now() - 3 * 3600_000, p2.id);
    conn.close();
    const r1 = await call('POST', '/api/checkins/run');
    assert.deepEqual(r1.done, [{ project: p2.id, tier: 1 }]);
    await waitFor('ch:idle-build', (m) => m.author === 'main' && /status check/.test(m.body));
    const r2 = await call('POST', '/api/checkins/run');
    // the PM (fake) replied, which is activity: the clock reset, nothing new to do
    assert.deepEqual(r2.done, []);
    await call('POST', `/api/projects/${p2.id}/status`, { status: 'paused' });
    assert.deepEqual((await call('POST', '/api/checkins/run')).done, []);
    await assert.rejects(call('POST', '/api/settings/checkins', { pm: 6, members: 2, user: 24 }), /later than/);
  });
});
