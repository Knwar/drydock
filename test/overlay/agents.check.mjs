// Headless checks of agent state on Home (cards cf569c28, 0ed5f540): Now building and Active agents derive
// it the same way (dwAgentState), a builder whose own card is in review is never "Reviewing" (Awaiting
// review, or Working with other live work), no card filter (Type, Tag, Scope, Phase, Agent) idles a busy
// agent, and Active agents' "Open in Kanban" / Up next's "View all" land on the right board with a labelled
// highlight (same board: setKanbanHighlight; another board: ?cards=…&hlfrom=…).
// Self-contained: starts its own daemon on a scratch DB + port (a fake `claude` first on PATH, terminals
// off), seeds a workspace over HTTP, drives Chrome, then kills the daemon and removes the scratch dir.
// Not part of `npm test` (needs Chrome + playwright-core). Run from the repo root:
//
//   node test/overlay/agents.check.mjs
//
// Env: PORT (default 7971; never 7890 or 7900), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else the npx cache).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7971);
if (PORT === 7890 || PORT === 7900) throw new Error('refusing a live daemon port (7890 kankanban, 7900 Drydock)');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, REPO];
  const npx = join(homedir(), '.npm/_npx');
  if (existsSync(npx)) for (const d of readdirSync(npx)) tries.push(join(npx, d, 'node_modules/playwright-core'));
  for (const t of tries.filter(Boolean)) {
    try {
      return createRequire(join(t, 'package.json'))(t === REPO ? 'playwright-core' : t);
    } catch {
      /* next */
    }
  }
  throw new Error('playwright-core not found: set PLAYWRIGHT_CORE (e.g. after `npx playwright-core --version`)');
}
const { chromium } = loadPlaywright();

const base = `http://127.0.0.1:${PORT}`;
if (await fetch(base + '/').then(() => true, () => false)) throw new Error(`something already answers on ${PORT}: pick another PORT`);
const S = mkdtempSync(join(tmpdir(), 'kankan-agents-'));
mkdirSync(join(S, 'data'));
mkdirSync(join(S, 'bin'));
writeFileSync(join(S, 'bin', 'claude'), '#!/bin/sh\nexit 0\n'); // never the real claude
chmodSync(join(S, 'bin', 'claude'), 0o755);
const daemon = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/server.ts'], {
  cwd: REPO,
  env: { ...process.env, PATH: `${join(S, 'bin')}:${process.env.PATH}`, PORT: String(PORT), DB_PATH: join(S, 'data', 'board.db'), KANKAN_TERMINAL: '0', KANKAN_AUTOPILOT: '0', KANKAN_DISPATCHER: '0' },
  stdio: 'ignore',
});
let exited = null;
daemon.on('exit', (code, signal) => (exited = { code, signal }));
let browser = null;
let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
};
try {
  for (let i = 0; ; i++) {
    if (exited) throw new Error(`daemon exited early: ${JSON.stringify(exited)}`);
    try {
      await fetch(base + '/');
      break;
    } catch {
      if (i > 80) throw new Error(`daemon did not start on ${PORT}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const j = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
    const t = await r.json();
    if (!r.ok) throw new Error(`${p} ${JSON.stringify(t)}`);
    return t;
  };

  // ---- seed: workspace "shop" + verticals "web", "api". Ada on a ui feature (and a done defect); Bob live
  // on a web defect with his own api card in review (the QA "Bram" case) and a done api card; Dee only has
  // an api card in review (Awaiting review); Cy free. Backlog: 2 api cards + 1 web card (Up next). ----
  mkdirSync(join(S, 'shop/apps/web'), { recursive: true });
  mkdirSync(join(S, 'shop/apps/api'), { recursive: true });
  const ws = (await j('GET', `/project?root=${encodeURIComponent(join(S, 'shop'))}&name=shop`)).project_id;
  const web = (await j('POST', '/vertical', { workspace_id: ws, name: 'web', root: join(S, 'shop/apps/web') })).project_id;
  const api = (await j('POST', '/vertical', { workspace_id: ws, name: 'api', root: join(S, 'shop/apps/api') })).project_id;
  const apiPhase = (await j('POST', '/phase', { project_id: api, title: 'Payments' })).phase_id;
  for (const name of ['Ada', 'Bob', 'Cy', 'Dee']) await j('POST', '/team', { name, skill: 'frontend-dev' });
  const card = async (title, work_type, agent, { board = web, tag, phase_id } = {}) => {
    const id = (await j('POST', '/task', { project_id: board, title, work_type, tag, phase_id })).task_id;
    await j('PATCH', `/task/${id}`, { assigned_agent: agent, worktree_path: `.trees/${id}`, branch: `card/${id}` });
    return id;
  };
  const a1 = await card('Ada feature', 'feature', 'Ada', { tag: 'ui' });
  const a2 = await card('Ada old defect', 'defect', 'Ada');
  await j('POST', `/task/${a2}/move`, { lane: 'done' });
  const b1 = await card('Bob defect', 'defect', 'Bob');
  const b2 = await card('Bob api fix', 'feature', 'Bob', { board: api, phase_id: apiPhase });
  await j('POST', `/task/${b2}/move`, { lane: 'in_review' });
  const b3 = await card('Bob api old', 'feature', 'Bob', { board: api, phase_id: apiPhase });
  await j('POST', `/task/${b3}/move`, { lane: 'done' });
  const d1 = await card('Dee api card', 'feature', 'Dee', { board: api, phase_id: apiPhase });
  await j('POST', `/task/${d1}/move`, { lane: 'in_review' });
  const backlog = [];
  for (const [board, title] of [[api, 'api next 1'], [api, 'api next 2'], [web, 'web next']]) backlog.push((await j('POST', '/task', { project_id: board, title })).task_id);
  // Bob is running tests on his web defect (live), while his api card waits in review
  await j('POST', '/status', { project_id: web, agent: 'builder', verb: 'Running', detail: 'npm test', task_id: b1 });
  // Ada's session went idle with her card still in flight (the QA case: "Ada · idle")
  const status = (verb, detail = '', agent = 'builder') => j('POST', '/status', { project_id: web, agent, verb, detail, task_id: a1 });
  await status('idle');

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
  const W = (t) => `.dw-widget[data-widget-type="${t}"]`;
  const ACT = `${W('now-building')} .wnb-action[data-card="${a1}"]`;
  const heroAction = () => page.$eval(`${ACT} .wnb-action-txt`, (e) => e.textContent);
  // the hero's action line: text, the pulsing dot (.wnb-who.on), the attention colour (.dw-attn)
  const hero = () =>
    page.$eval(ACT, (a) => ({ text: a.querySelector('.wnb-action-txt').textContent, on: a.parentElement.classList.contains('on'), attn: a.querySelector('.wnb-action-txt').classList.contains('dw-attn') }));
  const heroAfter = async (text) => {
    await page.waitForFunction(([sel, t]) => document.querySelector(sel)?.textContent === t, [`${ACT} .wnb-action-txt`, text], { timeout: 5000 }).catch(() => {});
    return hero();
  };
  const rowsOf = () =>
    page.$$eval(`${W('active-agents')} .aa-row`, (rs) =>
      Object.fromEntries(rs.map((r) => [r.querySelector('.aa-name').textContent, { pill: r.querySelector('.aa-pill-text').textContent, line: r.querySelector('.aa-line').textContent }])),
    );
  const summary = () => page.$eval(`${W('active-agents')} .aa-summary`, (e) => ({ text: e.textContent, title: e.title }));
  const homeReady = async () => {
    await page.waitForSelector(`${W('now-building')} .wnb-action[data-card="${a1}"]`, { timeout: 15000 });
    await page.waitForSelector(`${W('active-agents')} .aa-row`, { timeout: 15000 });
  };

  // ---- 1. one state rule in both widgets ----
  await page.goto(`${base}/?project=${web}&view=home`);
  await homeReady();
  const act0 = await heroAction();
  ok(act0 === 'Working · waiting for next action', 'Now building: idle session + card in flight reads "Working · waiting for next action"', act0);
  let rows = await rowsOf();
  ok(rows.Ada?.pill === 'Working' && act0.startsWith(`${rows.Ada.pill} ·`), 'Now building and Active agents agree on Ada (Working)', { act0, ada: rows.Ada });
  ok(rows.Cy?.pill === 'Idle' && rows.Cy.line === 'No current card', 'an agent with no card is Idle', rows.Cy);
  let h = await hero();
  ok(!h.on && !h.attn, 'idle session: the dot is not lit', h);
  await status('Edit', 'foo.js');
  h = await heroAfter('Working · Edit foo.js');
  ok(h.text === 'Working · Edit foo.js' && h.on, 'live status: "Working · Edit foo.js", dot lit', h);
  await status('idle');
  h = await heroAfter('Working · waiting for next action');
  ok(h.text === 'Working · waiting for next action' && !h.on, 'live idle ping: back to "Working · waiting for next action" (never "idle"), dot off', h);
  rows = await rowsOf();
  ok(rows.Ada?.pill === 'Working', 'Active agents keeps Ada Working after the idle ping', rows.Ada);
  await status('needs you', 'permission');
  h = await heroAfter('Working · Needs you');
  ok(h.text === 'Working · Needs you' && h.attn && !h.on, 'a "needs you" ping: "Working · Needs you" in the attention colour, dot off', h);
  await status('finished');
  h = await heroAfter('Working · waiting for next action');
  ok(h.text === 'Working · waiting for next action' && !h.attn && !h.on, 'a "finished" ping: "Working · waiting for next action" (never "Working · finished"), dot off', h);
  // a reviewer subagent on Ada's IN PROGRESS card: never "Reviewing" beside an In Progress card
  await status('Read', 'x.js', 'reviewer');
  h = await heroAfter('Working · Read x.js');
  rows = await rowsOf();
  ok(h.text === 'Working · Read x.js' && rows.Ada?.pill === 'Working', 'a reviewer ping on an in-progress card: both read Working, never "Reviewing · … In Progress"', { h, ada: rows.Ada });
  await status('finished', '', 'reviewer');
  await heroAfter('Working · waiting for next action');

  // ---- 1b. a builder whose own card is in review is not a reviewer (workspace Home: both boards) ----
  await page.goto(`${base}/?project=${ws}&view=home`);
  await page.waitForSelector(`${W('active-agents')} .aa-row`, { timeout: 15000 });
  await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((r) => r.textContent.includes('Dee')), `${W('active-agents')} .aa-row`, { timeout: 5000 }).catch(() => {});
  rows = await rowsOf();
  ok(rows.Bob?.pill === 'Working' && rows.Bob.line.startsWith('Bob defect') && rows.Bob.line.includes('In Progress'), 'Bob (live on a web defect, own api card in review): Working, row shows the live card', rows.Bob);
  ok(rows.Dee?.pill === 'Awaiting review' && rows.Dee.line.startsWith('Dee api card') && rows.Dee.line.includes('In Review'), 'Dee (only her own card, in review, nothing live): "Awaiting review", not Reviewing', rows.Dee);
  ok(!Object.values(rows).some((r) => r.pill === 'Reviewing' && r.line.includes('In Progress')), 'no row reads "Reviewing | <card> · In Progress"', rows);
  // a reviewer subagent on Dee's in-review card: Reviewing; it finishes → Awaiting review again
  const devStatus = (verb, detail = '') => j('POST', '/status', { project_id: api, agent: 'reviewer', verb, detail, task_id: d1 });
  const deeAfter = async (pill) => {
    await page.waitForFunction(([sel, p]) => [...document.querySelectorAll(sel)].some((r) => r.textContent.includes('Dee') && r.querySelector('.aa-pill-text')?.textContent === p), [`${W('active-agents')} .aa-row`, pill], { timeout: 5000 }).catch(() => {});
    return (await rowsOf()).Dee;
  };
  await devStatus('Read', 'y.js');
  let dee = await deeAfter('Reviewing');
  ok(dee?.pill === 'Reviewing', 'a reviewer subagent live on Dee’s in-review card: Reviewing', dee);
  await devStatus('finished');
  dee = await deeAfter('Awaiting review');
  ok(dee?.pill === 'Awaiting review', 'the reviewer finished: back to "Awaiting review"', dee);

  // ---- 2. the Type filter doesn't idle busy agents ----
  await page.goto(`${base}/?project=${web}&view=home&workType=defect`);
  await page.waitForSelector(`${W('active-agents')} .aa-row`, { timeout: 15000 });
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 4, `${W('active-agents')} .aa-row`, { timeout: 10000 }).catch(() => {});
  rows = await rowsOf();
  ok(rows.Ada?.pill === 'Working' && rows.Ada.line === 'Working outside this filter', 'Type = Defect: Ada (on a feature) stays Working, "Working outside this filter"', rows.Ada);
  ok(rows.Bob?.pill === 'Working' && rows.Bob.line.startsWith('Bob defect'), 'Type = Defect: Bob shows his defect card', rows.Bob);
  ok(rows.Cy?.pill === 'Idle', 'Type = Defect: Cy (no cards) stays listed, Idle', rows.Cy);
  const sum = await summary();
  ok(sum.text.replace(/\s+/g, ' ').includes('2 active') && sum.text.includes('2 idle'), 'Type = Defect: the summary counts every agent ("2 active · … · 2 idle"; Dee’s card is on api)', sum.text);
  ok(/whatever the filters/.test(sum.title), 'the summary tooltip says the counts ignore the filters', sum.title);

  // ---- 2b. Tag, Scope, Phase and Agent don't idle busy agents either (workspace Home) ----
  const filtered = async (q, n) => {
    await page.goto(`${base}/?project=${ws}&view=home&${q}`);
    await page.waitForSelector(`${W('active-agents')} .aa-row`, { timeout: 15000 });
    await page.waitForFunction(([sel, k]) => document.querySelectorAll(sel).length === k, [`${W('active-agents')} .aa-row`, n], { timeout: 10000 }).catch(() => {});
    return { rows: await rowsOf(), sum: (await summary()).text.replace(/\s+/g, ' ') };
  };
  let f = await filtered('tag=ui', 4);
  ok(f.rows.Ada?.pill === 'Working' && f.rows.Ada.line.startsWith('Ada feature'), 'Tag = ui: Ada shows her ui card', f.rows.Ada);
  ok(f.rows.Bob?.pill === 'Working' && f.rows.Bob.line === 'Working outside this filter', 'Tag = ui: Bob (busy on untagged cards) stays listed, Working, "Working outside this filter"', f.rows.Bob);
  ok(f.rows.Dee?.pill === 'Awaiting review' && f.rows.Dee.line === 'Awaiting review outside this filter', 'Tag = ui: Dee stays "Awaiting review"', f.rows.Dee);
  ok(f.sum.includes('3 active') && f.sum.includes('1 idle'), 'Tag = ui: the summary counts every agent', f.sum);
  f = await filtered(`scope=${api}`, 4);
  ok(f.rows.Ada?.pill === 'Working' && f.rows.Ada.line === 'Working outside this filter', 'Scope = api: Ada (on web) stays Working, outside this filter', f.rows.Ada);
  ok(f.rows.Bob?.pill === 'Working' && f.rows.Bob.line.startsWith('Bob api fix'), 'Scope = api: Bob stays Working (his live web card), the row shows his api card', f.rows.Bob);
  f = await filtered(`phase=${apiPhase}`, 4);
  ok(f.rows.Ada?.pill === 'Working' && f.rows.Ada.line === 'Working outside this filter', 'Phase = Payments: Ada stays Working, outside this filter', f.rows.Ada);
  ok(f.sum.includes('3 active'), 'Phase = Payments: the summary counts every agent', f.sum);
  f = await filtered('agent=Bob', 1);
  ok(Object.keys(f.rows).join() === 'Bob' && f.rows.Bob.pill === 'Working' && f.rows.Bob.line.startsWith('Bob defect'), 'Agent = Bob: just Bob, Working on his live card (not "Reviewing")', f.rows);
  const bobTip = (await summary()).title;
  ok(bobTip === 'Counts all of Bob’s work, whatever the other filters', 'Agent = Bob: the summary tooltip names Bob, not "every agent"', bobTip);

  // ---- 3. Open in Kanban labels its highlight ----
  const openKanban = async (name = 'Ada') => {
    await page.click(`${W('active-agents')} .aa-row[data-agent] >> text=${name}`);
    await page.waitForSelector('.aa-panel [data-k="kanban"]:not([disabled])', { timeout: 15000 });
    await page.click('.aa-panel [data-k="kanban"]');
    await page.waitForSelector('.mx-hl-chip', { timeout: 15000 });
    return page.$eval('.mx-hl-chip span', (e) => e.textContent);
  };
  // same board: Home on web, Ada's cards are on it
  await page.goto(`${base}/?project=${web}&view=home`);
  await homeReady();
  const same = await openKanban().catch((e) => `error: ${e.message}`);
  ok(/^\d+ cards? highlighted from Active agents$/.test(same), 'same board: banner "N cards highlighted from Active agents"', same);
  await page.evaluate(() => clearKanbanHighlight());
  // another board: Home on the workspace, Ada's cards are on web → ?project=web&cards=…&hlfrom=…
  await page.goto(`${base}/?project=${ws}&view=home`);
  await page.waitForSelector(`${W('active-agents')} .aa-row`, { timeout: 15000 });
  const cross = await openKanban().catch((e) => `error: ${e.message}`);
  const u = new URL(page.url());
  ok(/^\d+ cards? highlighted from Active agents$/.test(cross) && u.searchParams.get('project') === web, 'cross board: lands on web, banner "… highlighted from Active agents"', { cross, url: page.url() });

  // the board of the agent's current card wins over the board holding the most of its cards: Bob's
  // history is 1 web card (his current, live one) + 2 api cards → web
  await page.goto(`${base}/?project=${ws}&view=home`);
  await page.waitForSelector(`${W('active-agents')} .aa-row`, { timeout: 15000 });
  const bob = await openKanban('Bob').catch((e) => `error: ${e.message}`);
  const ub = new URL(page.url());
  ok(bob === '1 card highlighted from Active agents' && ub.searchParams.get('project') === web, 'Bob: Open in Kanban lands on web (his current card’s board), not api (most cards)', { bob, url: page.url() });

  // ---- 4. Up next "View all" from the workspace Home: the board holding most of the pending cards ----
  const UP = `${W('up-next')} .wl-foot`;
  await page.goto(`${base}/?project=${ws}&view=home`);
  await page.waitForSelector(UP, { timeout: 15000 });
  const upText = await page.$eval(UP, (e) => ({ text: e.textContent, title: e.title }));
  ok(upText.text === 'View 2 in api Kanban →' && /1 card on other boards isn’t shown there/.test(upText.title), 'workspace Home: Up next names the board it opens (2 of 3 pending are on api)', upText);
  await page.click(UP);
  await page.waitForSelector('.mx-hl-chip', { timeout: 15000 });
  const upBanner = await page.$eval('.mx-hl-chip span', (e) => e.textContent);
  const uu = new URL(page.url());
  const hl = await page.$$eval('.card.mx-hl', (cs) => cs.map((c) => c.dataset.id));
  ok(upBanner === '2 cards highlighted from Up next' && uu.searchParams.get('project') === api, 'Up next View all: lands on api with "2 cards highlighted from Up next"', { upBanner, url: page.url() });
  ok(hl.length === 2 && backlog.slice(0, 2).every((id) => hl.includes(id)), 'the two api backlog cards are the highlighted ones', hl);
  // one board (Home on web): "View all N in Kanban", highlighted in place
  await page.goto(`${base}/?project=${web}&view=home`);
  await page.waitForSelector(UP, { timeout: 15000 });
  const upWeb = await page.$eval(UP, (e) => e.textContent);
  await page.click(UP);
  await page.waitForSelector('.mx-hl-chip', { timeout: 15000 });
  const webBanner = await page.$eval('.mx-hl-chip span', (e) => e.textContent);
  ok(upWeb === 'View all 1 in Kanban →' && webBanner === '1 card highlighted from Up next' && new URL(page.url()).searchParams.get('project') === web, 'web Home: "View all 1 in Kanban" highlights in place, labelled', { upWeb, webBanner });

  ok(errors.length === 0, 'no page errors', errors);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
