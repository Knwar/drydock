import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('team chat (fake claude)', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-chat-')));
  let d: TestDaemon;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}`);
    return data;
  };
  /** Poll until the conversation has a message matching `pred`. */
  const waitFor = async (conv: string, pred: (m: any) => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const { messages } = await call('GET', `/api/conversations/${encodeURIComponent(conv)}/messages`);
      const hit = messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting in ${conv}`);
  };

  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE } });
    await call('POST', '/api/workspace', { path: join(tmp, 'ws') });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('starts with only the Main agent; members are added from templates, each with a DM', async () => {
    assert.deepEqual((await call('GET', '/api/roles')).map((r: any) => r.id), ['main']);
    const templates = await call('GET', '/api/role-templates');
    assert.ok(templates.some((t: any) => t.id === 'architect' && !t.added));
    for (const template of ['cto', 'cfo', 'marketing', 'qc']) await call('POST', '/api/roles', { template });
    assert.deepEqual((await call('GET', '/api/roles')).map((r: any) => r.id), ['main', 'cto', 'cfo', 'marketing', 'qc']);
    const convs = await call('GET', '/api/conversations');
    assert.ok(convs.some((c: any) => c.id === 'dm:main') && convs.some((c: any) => c.id === 'dm:cto'));
  });

  it('a team proposal becomes a card; Add creates the member, Not now does not', async () => {
    const p1 = await call('POST', '/api/role-proposals', { role: 'main', conversation: 'dm:main', template: 'architect', reason: 'to design the system' });
    const p2 = await call('POST', '/api/role-proposals', { role: 'main', conversation: 'dm:main', name: 'Legal advisor', skill: 'legal', persona: 'Reviews contracts.', reason: 'contracts' });
    const { messages } = await call('GET', '/api/conversations/dm:main/messages');
    const card = messages.find((m: any) => m.id === p1.message_id);
    assert.equal(card.kind, 'proposal');
    assert.equal(card.body, 'Add Architect to your team?');
    await call('POST', `/api/role-proposals/${p1.message_id}`, { accept: true });
    await call('POST', `/api/role-proposals/${p2.message_id}`, { accept: false });
    const ids = (await call('GET', '/api/roles')).map((r: any) => r.id);
    assert.ok(ids.includes('architect') && !ids.includes('legal-advisor'));
    assert.equal((await call('POST', '/api/role-proposals', { conversation: 'dm:main', template: 'architect' })).status, 'exists');
    await assert.rejects(call('POST', `/api/role-proposals/${p1.message_id}`, { accept: true }), /already added/);
  });

  it('answers a DM and resumes the same session next time', async () => {
    await call('POST', '/api/conversations/dm:cto/messages', { text: 'hello cto' });
    const first = await waitFor('dm:cto', (m) => m.author === 'cto' && m.kind === 'text');
    assert.equal(first.body, 'echo: hello cto');
    assert.equal(first.meta.cost_usd, 0.001);
    await call('POST', '/api/conversations/dm:cto/messages', { text: 'again' });
    const second = await waitFor('dm:cto', (m) => m.author === 'cto' && m.body.includes('again'));
    assert.equal(second.body, 'echo: again (resumed)');
  });

  it('in a channel only @mentioned members answer, and PASS is not posted', async () => {
    await call('POST', '/api/channels', { name: 'Launch Plan', members: ['marketing', 'cto'] });
    await call('POST', '/api/conversations/ch:launch-plan/messages', { text: '@Marketing draft the teaser' });
    const reply = await waitFor('ch:launch-plan', (m) => m.author === 'marketing' && m.kind === 'text');
    assert.match(reply.body, /New messages in #launch-plan/);
    const { messages } = await call('GET', '/api/conversations/ch:launch-plan/messages');
    assert.ok(!messages.some((m: any) => m.author === 'cto'));
  });

  it('hands over to a teammate an agent @mentions, at most 4 extra turns', async () => {
    await call('POST', '/api/channels', { name: 'relay', members: ['cto', 'qc'] });
    await call('POST', '/api/conversations/ch:relay/messages', { text: '@QC start the HANDOFF' });
    const end = Date.now() + 20_000;
    let replies: any[] = [];
    while (Date.now() < end) {
      const r = await call('GET', '/api/conversations/ch:relay/messages');
      replies = r.messages.filter((m: any) => m.author !== 'user' && m.kind === 'text');
      if (replies.length >= 5 && !r.working) break;
      await new Promise((res) => setTimeout(res, 150));
    }
    await new Promise((res) => setTimeout(res, 500));
    const { messages } = await call('GET', '/api/conversations/ch:relay/messages');
    const authors = messages.filter((m: any) => m.author !== 'user' && m.kind === 'text').map((m: any) => m.author);
    assert.deepEqual(authors, ['qc', 'cto', 'qc', 'cto', 'qc']); // 1 asked + 4 handoffs, then it stops
  });

  it('routes a tool request to an approval card; "always" also creates a standing rule', async () => {
    await call('POST', '/api/conversations/dm:qc/messages', { text: 'NEEDS_APPROVAL please' });
    const card = await waitFor('dm:qc', (m) => m.kind === 'approval');
    assert.equal(card.meta.status, 'pending');
    assert.equal(card.meta.tool, 'Write');
    const pending = await call('GET', '/api/approvals');
    assert.equal(pending.length, 1);
    await call('POST', `/api/approvals/${card.meta.approval_id}`, { decision: 'always' });
    const done = await waitFor('dm:qc', (m) => m.author === 'qc' && m.kind === 'text');
    assert.equal(done.body, 'write allowed');
    const rules = await call('GET', '/api/permissions');
    assert.deepEqual(rules.map((r: any) => [r.role_id, r.tool, r.policy]), [['qc', 'Write', 'allow']]);
    // the standing rule answers the next request without asking
    const auto = await call('POST', '/api/approvals', { role: 'qc', conversation: 'dm:qc', tool: 'Write', input: {} });
    assert.equal(auto.status, 'allowed');
  });

  it('a denied approval tells the agent', async () => {
    await call('POST', '/api/conversations/dm:cfo/messages', { text: 'NEEDS_APPROVAL now' });
    const card = await waitFor('dm:cfo', (m) => m.kind === 'approval');
    await call('POST', `/api/approvals/${card.meta.approval_id}`, { decision: 'deny', note: 'not now' });
    const done = await waitFor('dm:cfo', (m) => m.author === 'cfo' && m.kind === 'text');
    assert.equal(done.body, 'write denied');
  });

  it('records a decision as a card and in the vault', async () => {
    const r = await call('POST', '/api/decisions', { role: 'cto', conversation: 'dm:cto', title: 'Use Redis for the queue', why: 'Sub-second updates.', follow_ups: ['CTO updates the design'] });
    assert.ok(existsSync(r.file));
    assert.match(readFileSync(r.file, 'utf8'), /Use Redis for the queue[\s\S]*CTO updates the design/);
    const card = await waitFor('dm:cto', (m) => m.kind === 'decision');
    assert.equal(card.body, 'Use Redis for the queue');
  });
});
