import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('the Idea board', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-ideas-')));
  const ws = join(tmp, 'ws');
  const log = join(tmp, 'claude.log');
  let d: TestDaemon;
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    const data = JSON.parse(r.text);
    if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${data.error}`);
    return data;
  };
  const messages = async (conv: string) => (await call('GET', `/api/conversations/${encodeURIComponent(conv)}/messages`)).messages as any[];
  const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!(await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 120));
  };
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log } });
    await call('POST', '/api/workspace', { path: ws });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  let id = '';
  let slug = '';
  it('captures an idea without creating a project, folder or team', async () => {
    const i = await call('POST', '/api/ideas', { title: 'Habit app', pitch: 'A calm habit tracker for busy parents.', type: 'software' });
    id = i.id;
    slug = i.slug;
    assert.match(id, /^idea-/);
    assert.equal(i.status, 'raw');
    assert.deepEqual(i.missing, ['requirements', 'system design', 'brand', 'UI']);
    assert.equal((await call('GET', '/api/projects')).length, 0);
    assert.ok(existsSync(join(ws, 'vault', 'ideas', 'habit-app')));
    assert.equal((await call('POST', '/api/ideas', { title: 'Habit app', type: 'software' })).slug, 'habit-app-2', 'same title, new slug');
  });

  it('keeps requirements, design, brand and UI on the idea, in its vault folder', async () => {
    await call('POST', `/api/projects/${id}/requirements`, { markdown: '# Habit app\n\n## Problem\nParents forget.\n', author: 'main' });
    assert.match(readFileSync(join(ws, 'vault', 'ideas', slug, 'requirements', 'current.md'), 'utf8'), /Parents forget/);
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'app', kind: 'container', name: 'Mobile app', technology: 'Flutter' });
    await call('POST', `/api/projects/${id}/design/elements`, { id: 'api', kind: 'container', name: 'API', technology: 'Node' });
    await call('POST', `/api/projects/${id}/design/relations`, { source: 'app', target: 'api', label: 'Syncs habits', technology: 'HTTPS' });
    assert.ok(existsSync(join(ws, 'vault', 'ideas', slug, 'design', 'system-design.md')));
    await call('POST', `/api/ideas/${id}/brand`, { name: 'Calm', guidelines: '# Calm\nQuiet and kind.', tokens: { color: { primary: '#3355ff' } } });
    const home = '<!doctype html><style>:root{--primary:#3355ff}</style><h1>Today</h1><a href="settings.html">Settings</a>';
    await call('POST', `/api/ideas/${id}/screens`, { id: 'home', title: 'Home', html: home });
    await call('POST', `/api/ideas/${id}/screens`, { id: 'settings', title: 'Settings', html: '<h1>Settings</h1><a href="home.html">Back</a>' });
    const i = await call('GET', `/api/ideas/${id}`);
    assert.equal(i.status, 'shaping');
    assert.deepEqual(i.missing, []);
    assert.equal(i.requirements.version, 1);
    assert.deepEqual(i.screenList.map((s: any) => s.id), ['home', 'settings']);
  });

  it('serves mockups so they can only be looked at, and refuses scripts or anything remote', async () => {
    for (const html of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<img src="https://evil.example/p.png">', '<style>@import url(//x.example/a.css)</style>'])
      assert.equal((await raw('POST', `/api/ideas/${id}/screens`, { id: 'bad', title: 'Bad', html })).status, 400, html);
    const r = await raw('GET', `/api/ideas/${id}/ui/settings.html`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(r.text, /Settings/);
    assert.equal((await raw('GET', `/api/ideas/${id}/ui/..%2Fbrand.md`)).status, 404);
  });

  let conv = '';
  it('has one chat led by the Main agent, with the idea’s rules and skills', async () => {
    conv = (await call('POST', `/api/ideas/${id}/thread`)).conversation;
    assert.equal(conv, `ch:idea-${slug}`);
    assert.equal((await call('POST', `/api/ideas/${id}/thread`)).conversation, conv, 'one chat per idea');
    await call('POST', `/api/conversations/${encodeURIComponent(conv)}/messages`, { text: 'Add streaks' });
    await until(async () => (await messages(conv)).some((m) => m.author === 'main' && m.kind === 'text'));
    const run = runs().find((r) => r.system?.includes('This chat shapes an idea'));
    assert.ok(run, 'the Main agent ran with the idea rules');
    assert.match(run.system, /You lead it, and you do the shaping yourself/);
    for (const skill of ['ai-brain:c4-system-design', 'ai-brain:ui-mockups', 'ai-brain:brand-guidelines']) assert.ok(run.system.includes(skill), `the lead carries ${skill}`);
    assert.ok(existsSync(join(run.plugin, 'skills', 'ui-mockups', 'SKILL.md')), 'and can load it');
    assert.match(run.system, new RegExp(id));
  });

  it('brings a member into the chat only when the user says yes, and the lead briefs them', async () => {
    const p = await call('POST', '/api/role-proposals', { template: 'designer', conversation: conv, join: true, reason: 'brand and UI' });
    assert.equal(p.status, 'proposed');
    const card = (await messages(conv)).find((m) => m.kind === 'proposal');
    assert.match(card.body, /team and this chat/);
    await call('POST', `/api/role-proposals/${card.id}`, { accept: true });
    const chat = (await call('GET', '/api/conversations')).find((c: any) => c.id === conv);
    assert.ok(chat.members.includes('designer'));
    await until(async () => (await messages(conv)).filter((m) => m.author === 'main' && m.kind === 'text').length >= 2);
    assert.ok((await messages(conv)).some((m) => m.author === 'system' && /Product designer joined/.test(m.body)));
    // someone already on the team can be invited too
    await call('POST', '/api/roles', { template: 'architect' });
    assert.equal((await call('POST', '/api/role-proposals', { template: 'architect', conversation: conv, join: true, reason: 'design' })).status, 'proposed');
    assert.equal((await call('POST', '/api/role-proposals', { template: 'designer', conversation: conv, join: true, reason: 'again' })).status, 'exists');
  });

  it('sends an un-mentioned answer to the member who asked the question', async () => {
    const before_ = (await messages(conv)).length;
    await call('POST', `/api/conversations/${encodeURIComponent(conv)}/messages`, { text: '@Product designer ASKME' });
    await until(async () => (await messages(conv)).slice(before_).some((m) => m.author === 'designer' && /\?$/.test(m.body)));
    const mark = (await messages(conv)).length;
    await call('POST', `/api/conversations/${encodeURIComponent(conv)}/messages`, { text: 'Postgres' });
    await until(async () => (await messages(conv)).slice(mark).some((m) => m.author !== 'user' && m.kind === 'text'));
    const reply = (await messages(conv)).slice(mark).find((m) => m.author !== 'user' && m.kind === 'text');
    assert.equal(reply.author, 'designer');
  });

  let project = '';
  it('promotes the idea: the project starts with everything shaped, at the team step', async () => {
    await until(async () => !(await call('GET', `/api/ideas/${id}`)).working);
    const r = await call('POST', `/api/ideas/${id}/promote`);
    project = r.project_id;
    const p = await call('GET', `/api/projects/${project}`);
    assert.equal(p.origin, 'idea');
    assert.equal(p.stage, 'requirements');
    const req = await call('GET', `/api/projects/${project}/requirements`);
    assert.equal(req.length, 1, 'the idea’s requirements, not a placeholder');
    assert.equal(req[0].final, 1);
    assert.match(req[0].markdown, /Parents forget/);
    assert.equal((await call('GET', `/api/projects/${project}/design`)).elements.length, 2);
    for (const f of ['docs/requirements.md', 'docs/brand.md', 'docs/brand-tokens.json', 'docs/ui/home.html', 'docs/ui/index.html']) assert.ok(existsSync(join(r.root, f)), f);
    assert.match(execFileSync('git', ['-C', r.root, 'log', '--oneline']).toString(), /Idea board/);
    const idea = await call('GET', `/api/ideas/${id}`);
    assert.equal(idea.status, 'promoted');
    assert.ok(!(await call('GET', '/api/ideas')).some((i: any) => i.id === id), 'off the board');
    assert.equal((await raw('POST', `/api/ideas/${id}/promote`)).status, 400, 'not twice');
  });

  it('after the team step it skips the design stage and goes to the PM with the shaped work', async () => {
    await call('POST', '/api/roles', { template: 'pm' });
    const r = await call('POST', `/api/projects/${project}/design/start`);
    assert.equal(r.stage, 'plan');
    const kickoff = (await messages(r.channel)).find((m) => m.author === 'user');
    assert.match(kickoff.body, /shaped on the Idea board/);
    assert.match(kickoff.body, /docs\/ui\//);
    assert.match(kickoff.body, /propose_change/);
  });

  it('changes to settled requirements go through the user, without moving the stage', async () => {
    const stage = (await call('GET', `/api/projects/${project}`)).stage;
    const build = `ch:habit-app-build`;
    await call('POST', '/api/change-requests', { project_id: project, conversation: build, area: 'requirements', summary: 'Add weekly reports', why: 'User asked', requirements_markdown: '# Habit app\n\nWeekly reports.\n', role: 'pm' });
    const card = (await messages(build)).find((m) => m.kind === 'change_request');
    assert.equal(card.meta.status, 'pending');
    await call('POST', `/api/change-requests/${card.id}`, { accept: true });
    const req = await call('GET', `/api/projects/${project}/requirements`);
    assert.equal(req[0].version, 2);
    assert.equal(req[0].final, 1);
    assert.equal((await call('GET', `/api/projects/${project}`)).stage, stage);
    assert.ok((await call('GET', `/api/decisions?project=${project}`)).some((x: any) => /weekly reports/i.test(x.title)));
    // a design change goes to the Architect to apply
    await call('POST', '/api/change-requests', { project_id: project, conversation: build, area: 'design', summary: 'Add a reports worker', why: 'Weekly reports', role: 'pm' });
    const c2 = (await messages(build)).filter((m) => m.kind === 'change_request').at(-1);
    await call('POST', `/api/change-requests/${c2.id}`, { accept: true });
    assert.ok((await messages(build)).some((m) => m.author === 'system' && /@Architect: apply it/.test(m.body)));
  });

  it('parks and deletes ideas, keeping the files', async () => {
    const i = await call('POST', '/api/ideas', { title: 'Podcast about tea', type: 'general' });
    assert.equal((await call('POST', `/api/ideas/${i.id}`, { status: 'parked' })).status, 'parked');
    assert.equal((await call('POST', `/api/ideas/${i.id}`, { status: 'raw' })).status, 'raw');
    await call('DELETE', `/api/ideas/${i.id}`);
    assert.equal((await raw('GET', `/api/ideas/${i.id}`)).status, 404);
    assert.ok(!existsSync(join(ws, 'vault', 'ideas', 'podcast-about-tea')));
    assert.ok(existsSync(join(ws, 'vault', 'ideas', '.deleted')));
  });
});
