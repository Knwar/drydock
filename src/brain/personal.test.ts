import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';
import { parseMcpList, prefixOf } from './integrations.js';

describe('integrations parsing', () => {
  it('parses `claude mcp list` output and derives tool prefixes', () => {
    const out = `Checking MCP server health…

claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:marketing:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication
plugin:marketing:hubspot: https://mcp.hubspot.com/anthropic (HTTP) - ✘ Failed to connect — no DCR
plugin:marketing:gmail:  (HTTP) - - Not configured
sentry: https://mcp.sentry.dev/mcp (HTTP) - ✔ Connected`;
    const s = parseMcpList(out);
    assert.deepEqual(s.map((x) => [x.name, x.status, x.source]), [
      ['claude.ai Gmail', 'connected', 'account'],
      ['plugin:marketing:slack', 'needs_auth', 'plugin'],
      ['plugin:marketing:hubspot', 'failed', 'plugin'],
      ['plugin:marketing:gmail', 'not_configured', 'plugin'],
      ['sentry', 'connected', 'added'],
    ]);
    assert.equal(prefixOf('claude.ai Gmail'), 'mcp__claude_ai_Gmail');
    assert.equal(prefixOf('claude.ai Claude Docs'), 'mcp__claude_ai_Claude_Docs');
    assert.equal(prefixOf('plugin:marketing:slack'), 'mcp__plugin_marketing_slack');
  });
});

describe('personal page and the Daily', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-personal-')));
  const ws = join(tmp, 'ws');
  let d: TestDaemon;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}`);
    return data;
  };
  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home') } });
    await call('POST', '/api/workspace', { path: ws });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps reminders and notes', async () => {
    const r = await call('POST', '/api/reminders', { text: 'Pay invoice', due: '2026-10-15' });
    await call('POST', '/api/reminders', { text: 'Call mum' });
    await call('POST', `/api/reminders/${r.id}`, { done: true });
    const note = await call('POST', '/api/notes', { title: 'Gift idea', text: 'Leather journal' });
    assert.ok(existsSync(join(ws, 'vault', 'personal', 'notes', note.file)));
    const p = await call('GET', '/api/personal');
    assert.deepEqual(p.reminders.map((x: any) => [x.text, x.done]), [['Call mum', 0], ['Pay invoice', 1]]);
    assert.equal(p.notes[0].title, 'Gift idea');
  });

  it('shows what the main agent records from email and calendar', async () => {
    await call('POST', '/api/personal/inbox', { items: [{ id: 't1', sender: 'Client', subject: 'Contract', tag: 'reply', action: 'Draft reply' }] });
    await call('POST', '/api/personal/inbox', { items: [{ id: 't1', sender: 'Client', subject: 'Contract v2', tag: 'reply' }] });
    const p0 = await call('GET', '/api/personal');
    await call('POST', '/api/personal/calendar', { from: p0.week.from, to: p0.week.to, events: [{ day: p0.today, time: '11:00', title: 'Call', category: 'work' }] });
    await call('POST', '/api/personal/money', { bills: [{ id: 'b1', name: 'Phone', amount: 65, due: '2026-10-18', autopay: true }], spending: { month: p0.today.slice(0, 7), rows: [{ category: 'Groceries', amount: 310 }] } });
    const p = await call('GET', '/api/personal');
    assert.deepEqual(p.inbox.map((x: any) => x.subject), ['Contract v2']);
    assert.equal(p.week.events[0].title, 'Call');
    assert.equal(p.bills[0].autopay, 1);
    assert.equal(p.spending.rows[0].amount, 310);
    await call('POST', '/api/inbox/t1', { status: 'done' });
    assert.equal((await call('GET', '/api/personal')).inbox.length, 0);
  });

  it('publishes the Daily to the app and the vault, and validates its settings', async () => {
    const e = await call('POST', '/api/daily/publish', { headline: 'Finalise the design', summary: 'Light day.', sections: [{ title: 'Your day', items: [{ text: '11:00 Call' }] }] });
    assert.equal(e.number, 1);
    assert.match(readFileSync(join(ws, 'vault', 'personal', 'daily', `${e.day}.md`), 'utf8'), /Finalise the design[\s\S]*## Your day/);
    const again = await call('POST', '/api/daily/publish', { headline: 'Updated', sections: [] });
    assert.equal(again.number, 1); // same day → same edition
    const s = await call('POST', '/api/daily/settings', { time: '06:30', email: true, days: [1, 2, 9] });
    assert.equal(s.time, '06:30');
    assert.deepEqual(s.days, [1, 2]);
    assert.equal(s.sections.inbox, true);
    await assert.rejects(call('POST', '/api/daily/settings', { time: '7am' }), /HH:MM/);
  });

  it('reports usage against the alert threshold', async () => {
    const u = await call('GET', '/api/usage');
    assert.equal(u.five_hour, null);
    assert.equal(u.threshold, 75);
    const set = await call('POST', '/api/usage/alert', { threshold: 60 });
    assert.equal(set.threshold, 60);
  });
});
