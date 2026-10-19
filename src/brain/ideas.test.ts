import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
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
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('opens an idea an agent captures while you are talking to it, and only then', async () => {
    const sock = new WebSocket(d.base.replace(/^http/, 'ws') + '/ws');
    const opened: string[] = [];
    sock.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === 'idea_opened') opened.push(msg.idea_id);
    });
    await new Promise((r) => sock.once('open', r));
    const quiet = await call('POST', '/api/ideas', { title: 'Quiet one', type: 'general', source: 'dm:main' });
    await call('POST', '/api/conversations/dm:main/messages', { text: 'an idea: a tea podcast' });
    const told = await call('POST', '/api/ideas', { title: 'Tea podcast', type: 'general', source: 'dm:main' });
    await until(async () => opened.length > 0, 3000);
    sock.terminate();
    assert.deepEqual(opened, [told.id]);
    for (const i of [quiet, told]) await call('DELETE', `/api/ideas/${i.id}`);
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
    const twin = await call('POST', '/api/ideas', { title: 'Habit app', type: 'software', notes: '## Problem\nParents forget habits.\n\n## Open questions\n- Phone or watch?' });
    assert.equal(twin.slug, 'habit-app-2', 'same title, new slug');
    // the first thinking from the chat it came up in becomes its starting requirements
    const reqs = await call('GET', `/api/projects/${twin.id}/requirements`);
    assert.equal(reqs.length, 1);
    assert.match(reqs[0].markdown, /^# Habit app\n\n## Problem/);
    await call('DELETE', `/api/ideas/${twin.id}`);
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

  it('a pill runs an analysis: its card shows working, then the saved result (or that nothing came back)', async () => {
    const kinds = (await call('GET', '/api/idea-analyses')).map((a: any) => a.kind);
    assert.ok(['competitors', 'mvp', 'risks', 'pr-faq', 'features', 'decision'].every((k) => kinds.includes(k)));
    const r = await call('POST', `/api/ideas/${id}/sections/competitors/run`);
    assert.equal(r.conversation, conv);
    let card = (await call('GET', `/api/ideas/${id}`)).sections.find((x: any) => x.kind === 'competitors');
    assert.equal(card.status, 'running');
    assert.ok((await messages(conv)).some((m) => m.author === 'user' && /\*\*Competitors\*\*/.test(m.body) && /save_idea_section/.test(m.body)));
    // the stand-in agent never saves: once its run ends the card says so instead of spinning
    await until(async () => (await call('GET', `/api/ideas/${id}`)).sections.find((x: any) => x.kind === 'competitors').status !== 'running');
    card = (await call('GET', `/api/ideas/${id}`)).sections.find((x: any) => x.kind === 'competitors');
    assert.equal(card.status, 'stalled');
    await call('POST', `/api/ideas/${id}/sections`, { kind: 'competitors', summary: 'Two apps, both nag; the gap is calm.', markdown: '| App | Price |\n|---|---|\n| Streaks | $5 |' });
    card = (await call('GET', `/api/ideas/${id}`)).sections.find((x: any) => x.kind === 'competitors');
    assert.equal(card.status, 'done');
    assert.match(card.summary, /gap is calm/);
    assert.equal((await raw('POST', `/api/ideas/${id}/sections`, { kind: 'horoscope', summary: 'x', markdown: 'y' })).status, 400);
  });

  it('offers the next step on a card; nothing starts until the user presses its button', async () => {
    assert.equal((await raw('POST', `/api/ideas/${id}/offers`, { step: 'deploy', reason: 'x' })).status, 400);
    const first = await call('POST', `/api/ideas/${id}/offers`, { step: 'design', reason: 'The core features are clear.' });
    const again = await call('POST', `/api/ideas/${id}/offers`, { step: 'design', reason: 'Still clear.' });
    let ms = await messages(conv);
    assert.equal(ms.find((m) => m.id === first.message_id).meta.status, 'replaced', 'one open offer per step');
    const card = ms.find((m) => m.id === again.message_id);
    assert.equal(card.kind, 'offer');
    assert.equal(card.meta.status, 'pending');
    assert.equal(card.body, 'Build the system design');
    const mark = ms.length;
    await call('POST', `/api/ideas/${id}/offers/${again.message_id}`, { accept: true });
    ms = await messages(conv);
    assert.equal(ms.find((m) => m.id === again.message_id).meta.status, 'started');
    assert.ok(ms.slice(mark).some((m) => m.author === 'user' && /\*\*Build the system design\*\*/.test(m.body)), 'pressing it asks the lead');
    assert.equal((await raw('POST', `/api/ideas/${id}/offers/${again.message_id}`, { accept: true })).status, 409);
    await until(async () => !(await call('GET', `/api/ideas/${id}`)).working);
    const ui = await call('POST', `/api/ideas/${id}/offers`, { step: 'ui', reason: 'The MVP is agreed.' });
    await call('POST', `/api/ideas/${id}/offers/${ui.message_id}`, { accept: false });
    ms = await messages(conv);
    assert.equal(ms.find((m) => m.id === ui.message_id).meta.status, 'declined');
    assert.ok(!ms.some((m) => m.author === 'user' && /\*\*Build the UI mockups\*\*/.test(m.body)), 'not now starts nothing');
  });

  it('keeps what will be built as detailed features, and the MVP cut updates them in place', async () => {
    await call('POST', `/api/ideas/${id}/features`, {
      features: [
        { id: 'F1', module: 'Habits', title: 'Daily checklist', priority: 'must', summary: 'Tick habits off for today.', stories: ['As a parent, I want to tick a habit, so that I see progress'], acceptance: ['Given a habit, When I tick it, Then it shows done for today'], edge_cases: ['Midnight rollover'], data: ['habits', 'checkins'] },
        { id: 'F2', module: 'Habits', title: 'Streaks', priority: 'should' },
        { id: 'F3', module: 'Sharing', title: 'Share with partner', priority: 'could' },
      ],
    });
    const all = await call('POST', `/api/ideas/${id}/features`, { features: [{ id: 'F1', mvp: true }, { id: 'F2', mvp: true }] });
    const f1 = all.find((f: any) => f.id === 'F1');
    assert.equal(f1.mvp, true);
    assert.equal(f1.acceptance.length, 1, 'a partial update keeps the spec');
    assert.equal((await call('GET', `/api/ideas/${id}`)).mvpFeatures, 2);
    assert.match(readFileSync(join(ws, 'vault', 'ideas', slug, 'features.md'), 'utf8'), /### F1: Daily checklist[\s\S]*Given a habit/);
    assert.equal((await raw('POST', `/api/ideas/${id}/features`, { features: [{ id: 'F9' }] })).status, 400, 'a new feature needs a title and module');
  });

  it('features start as drafts with their source; the user confirms them, and changing what one says makes it a draft again', async () => {
    await until(async () => !(await call('GET', `/api/ideas/${id}`)).working);
    let f = (await call('POST', `/api/ideas/${id}/features`, { features: [{ id: 'F2', source: 'your message at 13:40' }] })).find((x: any) => x.id === 'F2');
    assert.equal(f.confirmed, false);
    assert.equal(f.source, 'your message at 13:40');
    const mark = (await messages(conv)).length;
    const r = await call('POST', `/api/ideas/${id}/features/review`, { items: [{ id: 'F1', verdict: 'ok' }, { id: 'F2', verdict: 'change', reason: 'it is for both parents' }, { id: 'F3', verdict: 'drop' }] });
    assert.deepEqual(r, { confirmed: 1, changed: 1, dropped: 1 });
    const d = await call('GET', `/api/ideas/${id}`);
    assert.equal(d.featureList.find((x: any) => x.id === 'F1').confirmed, true);
    // one message for the whole review: what to rewrite and what to remove
    const sent = (await messages(conv)).slice(mark).filter((m) => m.author === 'user');
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Change these[\s\S]*F2 Streaks: it is for both parents[\s\S]*Not wanted[\s\S]*F3 Share with partner/);
    // a priority change keeps the confirmation; a new story does not
    f = (await call('POST', `/api/ideas/${id}/features`, { features: [{ id: 'F1', priority: 'must' }] })).find((x: any) => x.id === 'F1');
    assert.equal(f.confirmed, true);
    f = (await call('POST', `/api/ideas/${id}/features`, { features: [{ id: 'F1', stories: ['As a parent, I want to tick a habit in one tap'] }] })).find((x: any) => x.id === 'F1');
    assert.equal(f.confirmed, false);
    assert.equal((await raw('POST', `/api/ideas/${id}/features/review`, { items: [{ id: 'nope', verdict: 'ok' }] })).status, 400);
    await until(async () => !(await call('GET', `/api/ideas/${id}`)).working);
  });

  it('open questions come with likely answers; a tap answers and tells the lead what to update', async () => {
    const q = await call('POST', `/api/ideas/${id}/questions`, { text: 'Phone or watch first?', options: ['Phone', 'Watch'], affects: ['F1'] });
    assert.equal(q.id, 'Q1');
    assert.equal((await call('POST', `/api/ideas/${id}/questions`, { text: 'phone or watch first?', options: ['Phone', 'Watch', 'Both'] })).id, 'Q1', 'the same question re-words it');
    assert.equal((await raw('POST', `/api/ideas/${id}/questions`, { text: 'Colour?', options: ['Blue'] })).status, 400, 'at least two options');
    const mark = (await messages(conv)).length;
    await call('POST', `/api/ideas/${id}/questions/Q1/answer`, { answer: 'Phone' });
    const d = await call('GET', `/api/ideas/${id}`);
    assert.equal(d.questions[0].status, 'answered');
    assert.equal(d.questions[0].answer, 'Phone');
    assert.ok((await messages(conv)).slice(mark).some((m) => m.author === 'user' && /^Answer to "phone or watch first\?": Phone\. Update F1/.test(m.body)));
    assert.equal((await raw('POST', `/api/ideas/${id}/questions/Q1/answer`, { answer: 'Watch' })).status, 400, 'once');
    // answered in the chat instead: the lead closes it quietly
    await call('POST', `/api/ideas/${id}/questions`, { text: 'Free or paid?', options: ['Free', 'Paid'] });
    const before = (await messages(conv)).length;
    await call('POST', `/api/ideas/${id}/questions/Q2/answer`, { answer: 'Paid', quiet: true });
    assert.equal((await messages(conv)).length, before, 'no message for a quiet close');
    assert.ok(Array.isArray(d.decisions));
    await until(async () => !(await call('GET', `/api/ideas/${id}`)).working);
  });

  it('a new idea opens with an intake: the basics are asked, and the last answer starts the first pass in one message', async () => {
    const i = await call('POST', '/api/ideas', { title: 'Recipe planner', type: 'software' });
    const c = (await call('POST', `/api/ideas/${i.id}/thread`)).conversation;
    const intake = (await messages(c)).find((m) => m.author === 'system');
    assert.match(intake.body, /Start with an intake[\s\S]*intake set to true[\s\S]*First pass/);
    await until(async () => (await messages(c)).some((m) => m.author === 'main'));
    // opening it again does not start another intake
    await call('POST', `/api/ideas/${i.id}/thread`);
    assert.equal((await messages(c)).filter((m) => m.author === 'system').length, 1);
    await call('POST', `/api/ideas/${i.id}/questions`, { text: 'Which platform?', options: ['iPhone', 'Web'], intake: true });
    await call('POST', `/api/ideas/${i.id}/questions`, { text: 'What is the goal?', options: ['Personal use', 'Side income'], intake: true });
    await until(async () => !(await call('GET', `/api/ideas/${i.id}`)).working);
    const mark = (await messages(c)).length;
    await call('POST', `/api/ideas/${i.id}/questions/Q1/answer`, { answer: 'iPhone' });
    assert.equal((await messages(c)).length, mark, 'the first basic is collected quietly');
    await call('POST', `/api/ideas/${i.id}/questions/Q2/answer`, { answer: 'Side income' });
    const sent = (await messages(c)).slice(mark).filter((m) => m.author === 'user');
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /^The basics:\n- Which platform\? iPhone\n- What is the goal\? Side income[\s\S]*First pass/);
    assert.equal((await raw('POST', `/api/ideas/${i.id}/intake/skip`)).status, 400, 'nothing left to skip');
    await until(async () => !(await call('GET', `/api/ideas/${i.id}`)).working);
    await call('DELETE', `/api/ideas/${i.id}`);
  });

  it('skipping the rest of the intake starts the first pass on best guesses', async () => {
    const i = await call('POST', '/api/ideas', { title: 'Garden journal', type: 'general' });
    const c = (await call('POST', `/api/ideas/${i.id}/thread`)).conversation;
    await until(async () => !(await call('GET', `/api/ideas/${i.id}`)).working);
    await call('POST', `/api/ideas/${i.id}/questions`, { text: 'Which format?', options: ['Book', 'Blog'], intake: true });
    assert.deepEqual(await call('POST', `/api/ideas/${i.id}/intake/skip`), { skipped: 1 });
    const d = await call('GET', `/api/ideas/${i.id}`);
    assert.match(d.questions[0].answer, /best guess/);
    assert.ok((await messages(c)).some((m) => m.author === 'user' && /^The basics:[\s\S]*best guess[\s\S]*First pass/.test(m.body)));
    await until(async () => !(await call('GET', `/api/ideas/${i.id}`)).working);
    await call('DELETE', `/api/ideas/${i.id}`);
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
    for (const f of ['docs/requirements.md', 'docs/brand.md', 'docs/brand-tokens.json', 'docs/ui/home.html', 'docs/ui/index.html', 'docs/features.md', 'docs/analysis/competitors.md', 'docs/system-design.md']) assert.ok(existsSync(join(r.root, f)), f);
    // the design file the PM's kickoff points to
    assert.match(readFileSync(join(p.vault, 'design', 'system-design.md'), 'utf8'), /System design/);
    assert.equal(p.idea_id, id, 'the project shows the idea’s brand and UI');
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
    assert.match(kickoff.body, /docs\/features\.md/);
    assert.match(kickoff.body, /docs\/system-design\.md/);
    assert.match(kickoff.body, /docs\/analysis\/competitors\.md/);
    assert.doesNotMatch(kickoff.body, /risks, MVP cut, estimate/, 'only the analyses that were run');
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
    const { conversation } = await call('POST', `/api/ideas/${i.id}/thread`);
    await call('DELETE', `/api/ideas/${i.id}`);
    assert.equal((await raw('GET', `/api/ideas/${i.id}`)).status, 404);
    assert.ok(!existsSync(join(ws, 'vault', 'ideas', 'podcast-about-tea')));
    assert.ok(existsSync(join(ws, 'vault', 'ideas', '.deleted')));
    assert.ok(!(await call('GET', '/api/conversations')).some((c: any) => c.id === conversation), 'its chat is no longer listed');
  });
});
