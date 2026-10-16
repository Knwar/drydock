// Context and cost habits: a cache-stable system prompt, effort per role,
// lead-only replies in channels, usage per run, and fresh sessions with a
// handover note once a session grows long.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('context and cost', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-context-')));
  const log = join(tmp, 'claude.log');
  let d: TestDaemon;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}`);
    return data;
  };
  const runs = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const replies = async (conv: string, author: string) => (await call('GET', `/api/conversations/${encodeURIComponent(conv)}/messages`)).messages.filter((m: any) => m.author === author && m.kind === 'text');
  const waitReplies = async (conv: string, author: string, n: number) => {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const r = await replies(conv, author);
      if (r.length >= n) return r;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error(`waited for ${n} replies from ${author}`);
  };

  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log } });
    await call('POST', '/api/workspace', { path: join(tmp, 'ws') });
    for (const t of ['cto', 'qc', 'marketing']) await call('POST', '/api/roles', { template: t });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps the system prompt identical between turns (no clock in it) and passes the role effort', async () => {
    await call('POST', '/api/conversations/dm:cto/messages', { text: 'one' });
    await waitReplies('dm:cto', 'cto', 1);
    await call('POST', '/api/conversations/dm:cto/messages', { text: 'two' });
    await waitReplies('dm:cto', 'cto', 2);
    const [a, b] = runs().filter((r) => r.system?.includes('You are the CTO') || r.system?.includes('CTO'));
    assert.equal(a.system, b.system, 'same text every turn, so the cache holds');
    assert.ok(!/\b\d{1,2}:\d{2}:\d{2}\b/.test(a.system), 'no time of day in the system prompt');
    assert.match(b.prompt, /^\[.+\]\ntwo/, 'the time comes with the message instead');
    assert.equal(a.effort, 'high', 'the CTO thinks hard by default');
  });

  it('records tokens per run and reports the cache hit rate per role', async () => {
    const u = await call('GET', '/api/usage/agents?days=1');
    const cto = u.roles.find((r: any) => r.role_id === 'cto');
    assert.equal(cto.runs, 2);
    assert.equal(cto.cache_read, 5000);
    assert.ok(cto.cacheHit > 40 && cto.cacheHit < 60, `hit ${cto.cacheHit}%`);
  });

  it('in a channel with no @mention only the lead answers', async () => {
    await call('POST', '/api/channels', { name: 'Plans', members: ['marketing', 'qc'] });
    await call('POST', '/api/conversations/ch:plans/messages', { text: 'what next?' });
    await waitReplies('ch:plans', 'marketing', 1);
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal((await replies('ch:plans', 'qc')).length, 0);
  });

  it('starts a fresh session with a handover note once the session is long', async () => {
    await call('POST', '/api/settings/sessions', { maxTurns: 10 });
    for (let i = 3; i <= 10; i++) {
      await call('POST', '/api/conversations/dm:cto/messages', { text: `msg ${i}` });
      await waitReplies('dm:cto', 'cto', i);
    }
    await call('POST', '/api/conversations/dm:cto/messages', { text: 'after the limit' });
    await waitReplies('dm:cto', 'cto', 11);
    const last = runs().slice(-2);
    assert.match(last[0].prompt, /Your session is being refreshed/);
    assert.ok(last[0].resumed, 'the old session writes the note');
    assert.equal(last[1].resumed, null, 'the new turn starts a new session');
    assert.match(last[1].prompt, /^Handover from your previous session[\s\S]*HANDOVER NOTE[\s\S]*after the limit/);
    const msgs = (await call('GET', '/api/conversations/dm%3Acto/messages')).messages;
    assert.ok(msgs.some((m: any) => m.kind === 'tool' && /fresh session after 10 turns/.test(m.body)));
    // and the new session counts from zero
    await call('POST', '/api/conversations/dm:cto/messages', { text: 'next' });
    await waitReplies('dm:cto', 'cto', 12);
    assert.ok(runs().slice(-1)[0].resumed, 'resumes the new session, no second handover');
  });
});
