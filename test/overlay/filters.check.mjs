// Headless checks of the overlay's shared filters + drill-down on the dashboard and Home
// (card dc4c1045). Self-contained: starts its own daemon on a scratch DB + port, seeds ~8
// weeks of data (metrics-seed.mjs), drives Chrome, then kills the daemon and removes the DB.
// Not part of `npm test` (needs Chrome + playwright-core). Run from the repo root:
//
//   node test/overlay/filters.check.mjs
//
// Env: PORT (default 7968; never 7890), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else
// the npx cache: `npx playwright-core --version` fills it), OUT (screenshot dir; none by default).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7968);
if (PORT === 7890) throw new Error('refusing port 7890 (the live daemon)');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.OUT ?? null;
if (OUT) mkdirSync(OUT, { recursive: true });

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

// ---- scratch daemon + seed ----
const base = `http://127.0.0.1:${PORT}`;
// the port must be free: never drive (or seed) a daemon this script didn't start
if (await fetch(base + '/').then(() => true, () => false)) throw new Error(`something already answers on ${PORT}: pick another PORT`);
const S = mkdtempSync(join(tmpdir(), 'kankan-filters-'));
mkdirSync(join(S, 'data')); // metrics-seed.mjs writes its backdated history to <S>/data/board.db
const daemon = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/server.ts'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(S, 'data', 'board.db'), KANKAN_TERMINAL: '0', KANKAN_AUTOPILOT: '0', KANKAN_DISPATCHER: '0' },
  stdio: 'ignore',
});
let exited = null; // the daemon's exit code/signal, if it dies before we kill it
daemon.on('exit', (code, signal) => (exited = { code, signal }));
let browser = null;
let fails = 0;
try {
  for (let i = 0; ; i++) {
    if (exited) throw new Error(`daemon exited early: ${JSON.stringify(exited)}`);
    try {
      await fetch(base + '/');
      if (exited) throw new Error(`daemon exited early: ${JSON.stringify(exited)}`); // someone else answered
      break;
    } catch (err) {
      if (exited) throw err;
      if (i > 80) throw new Error(`daemon did not start on ${PORT}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const seed = JSON.parse(execFileSync(process.execPath, [join(REPO, 'test/overlay/metrics-seed.mjs'), S, String(PORT), REPO], { encoding: 'utf8' }));

const ok = (cond, msg, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
};
const api = async (p, init) => {
  const r = await fetch(base + p, init);
  return r.json();
};
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const LANES = ['backlog', 'queued', 'in_progress', 'in_review', 'done'];
const BOARDS = ['ws', 'web', 'api', 'mobile'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (d) => `${d.getDate()} ${MON[d.getMonth()]}`;

// a backlog card on api (tag db, phase API v1) waiting on an unfinished card: Up next readiness
const apiCards0 = await api(`/board?project=${seed.api}`);
const blocker = apiCards0.find((c) => c.lane === 'in_progress');
const waiter = await api('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: seed.api, title: 'Waiter card', tag: 'db', phase_id: seed.phases.apiV1, depends_on: [blocker.id] }) });

// ---- the data, independently ----
const cards = [];
const phases = {};
for (const k of BOARDS) {
  for (const c of await api(`/board?project=${seed[k]}`)) cards.push({ ...c, board: seed[k] });
  phases[seed[k]] = await api(`/phases?project=${seed[k]}`);
}
const summary = await api(`/workspace/summary?project=${seed.ws}`);
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function twoWeeksFrom() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7); // Monday of last week
  return d.getTime();
}
const match = (f, c) =>
  (!f.scope || f.scope === seed.ws || c.board === f.scope) &&
  (!f.phase || c.phase_id === f.phase) &&
  (!f.tag || c.tag === f.tag) &&
  (!f.agent || c.agent === f.agent) &&
  (c.lane !== 'done' || ((!f.from || (c.lane_since ?? c.updated_at) >= f.from) && (!f.to || (c.lane_since ?? c.updated_at) < f.to)));
const counts = (f, board) => Object.fromEntries(LANES.map((l) => [l, cards.filter((c) => c.board === board && c.lane === l && match(f, c)).length]));

browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
const shot = (n) => (OUT ? page.screenshot({ path: `${OUT}/${n}.png` }) : null);
const param = (k) => new URL(page.url()).searchParams.get(k);
const keysIn = () => ['scope', 'phase', 'tag', 'agent', 'range', 'from', 'to', 'tz'].filter((k) => new URL(page.url()).searchParams.has(k));
const cdp = await page.context().newCDPSession(page);
async function docKeydownListeners() {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  return listeners.filter((l) => l.type === 'keydown').length;
}

// ================= DASHBOARD =================
const D = '.dash-filters';
const dsel = (label) => `${D} label.mx-field:has(> span:text-is("${label}")) select`;
const settledDash = () =>
  page.waitForFunction(
    () => document.querySelector('.dash-tile') && ![...document.querySelectorAll('.dt-lane-n')].some((e) => e.textContent === '…') && typeof dctx !== 'undefined' && dctx.meta && !document.querySelector('.fb-bar .mx-dim'),
    null,
    { timeout: 15000 },
  );
async function tileCounts() {
  return page.$$eval('.dash-tile', (ts) =>
    Object.fromEntries(ts.map((t) => [t.dataset.id, Object.fromEntries([...t.querySelectorAll('.dt-lane')].map((l) => [l.dataset.lane, Number(l.querySelector('.dt-lane-n').textContent.split('/')[0])]))])),
  );
}
async function expectTiles(f, boards, msg) {
  await settledDash();
  await page.waitForTimeout(150);
  const got = await tileCounts();
  const want = Object.fromEntries(boards.map((b) => [b, counts(f, b)]));
  ok(JSON.stringify(Object.keys(got).sort()) === JSON.stringify([...boards].sort()), `${msg}: tiles shown`, { got: Object.keys(got), want: boards });
  const bad = boards.filter((b) => JSON.stringify(got[b]) !== JSON.stringify(want[b]));
  ok(!bad.length, `${msg}: lane counts match the data`, bad.map((b) => ({ b, got: got[b], want: want[b] })));
}
const allBoards = BOARDS.map((k) => seed[k]);

await page.goto(`${base}/?project=${seed.ws}&view=dashboard`);
await settledDash();
{
  const got = await tileCounts();
  const want = Object.fromEntries(summary.boards.map((b) => [b.project.id, b.lanes]));
  // unfiltered: the summary's counts (+1 backlog on api from the waiter card)
  ok(allBoards.every((b) => JSON.stringify(got[b]) === JSON.stringify(counts({}, b))), 'unfiltered: tiles = the board data', { got, want });
  ok((await page.$eval(`${D} .fb-chip`, (e) => e.textContent)) === 'Filters▾' && !(await page.$(`${D} .fb-clear`)), 'unfiltered: plain "Filters" chip, no Clear');
  ok(!(await page.$(`${D} .fb-bar`)), 'chip collapsed by default');
  await shot('dash-1-unfiltered');
}
const kd0 = await docKeydownListeners();

// expand, tag = ui
await page.click(`${D} .fb-chip`);
await page.waitForSelector(`${D} .fb-bar`);
ok((await page.$$eval(`${D} .fb-bar label.mx-field > span`, (es) => es.map((e) => e.textContent))).join('|') === 'Scope|Phase|Tag|Agent', 'expanded bar: Scope, Phase, Tag, Agent (+ range), no tz');
ok(!!(await page.$(`${D} .fb-bar .mx-seg`)) && !(await page.$(`${D} .fb-bar .mx-tz`)), 'range shown, time zone hidden');
await page.selectOption(dsel('Tag'), 'ui');
await expectTiles({ tag: 'ui' }, allBoards, 'tag ui');
ok(param('view') === 'dashboard' && param('tag') === 'ui' && keysIn().join() === 'tag', 'tag ui: URL-backed (view=dashboard&tag=ui)', page.url());
ok((await page.$eval(`${D} .fb-chip-v`, (e) => e.textContent)) === 'ui' && !!(await page.$(`${D} .fb-clear`)), 'chip names "ui", Clear shown');
{
  // Needs you: attention items whose card has tag ui; no waiting sessions under a tag filter
  const want = summary.attention.filter((i) => cards.find((c) => c.id === i.card_id)?.tag === 'ui').map((i) => i.title);
  const got = await page.$$eval('.dash-attn .att-title', (es) => es.map((e) => e.textContent));
  ok(JSON.stringify(got) === JSON.stringify(want), 'tag ui: Needs you list filtered', { got, want });
}
{
  // active cards on tiles: only ui ones
  const got = await page.$$eval('.dash-tile .dt-card-title', (es) => es.map((e) => e.textContent).sort());
  const want = cards.filter((c) => ['in_progress', 'in_review'].includes(c.lane) && c.tag === 'ui').map((c) => c.title).sort();
  ok(JSON.stringify(got) === JSON.stringify(want), 'tag ui: in-flight cards on tiles filtered', { got, want });
}
await shot('dash-2-tag-ui');

// + agent Ada
await page.selectOption(dsel('Agent'), 'Ada');
await expectTiles({ tag: 'ui', agent: 'Ada' }, allBoards, 'tag ui + agent Ada');
ok((await page.$eval(`${D} .fb-chip-v`, (e) => e.textContent)) === 'ui · Ada', 'chip: "ui · Ada"');

// phase Web checkout (tag / agent cleared first)
await page.selectOption(dsel('Tag'), '');
await page.selectOption(dsel('Agent'), '');
await page.selectOption(dsel('Phase'), seed.phases.webCheckout);
await expectTiles({ phase: seed.phases.webCheckout }, [seed.web], 'phase Web checkout → web tile only');
{
  const want = summary.attention.filter((i) => i.phase_id === seed.phases.webCheckout).map((i) => i.title);
  const got = await page.$$eval('.dash-attn .att-title', (es) => es.map((e) => e.textContent));
  ok(JSON.stringify(got) === JSON.stringify(want), 'phase: Needs you filtered to the phase', { got, want });
  const inPhase = cards.filter((c) => c.phase_id === seed.phases.webCheckout);
  const bar = await page.$eval(`.dash-tile[data-id="${seed.web}"] .dt-phase-n`, (e) => e.textContent);
  ok(bar === `${inPhase.filter((c) => c.lane === 'done').length}/${inPhase.length}`, 'phase: the tile\'s phase bar is that phase', bar);
}
ok(param('phase') === seed.phases.webCheckout, 'phase in the URL');

// scope api (phase dropped: not on api)
await page.selectOption(dsel('Scope'), seed.api);
await expectTiles({ scope: seed.api }, [seed.api], 'scope api → api tile only');
ok(param('scope') === seed.api && !param('phase'), 'scope in the URL; the other board\'s phase dropped');
{
  const want = summary.attention.filter((i) => i.project_id === seed.api).map((i) => i.title);
  const got = await page.$$eval('.dash-attn .att-title', (es) => es.map((e) => e.textContent));
  ok(JSON.stringify(got) === JSON.stringify(want), 'scope api: Needs you = api items', { got, want });
  ok((await page.$eval('.dash-attn .da-count', (e) => e.textContent)) === String(want.length), 'scope api: needs-you count', want.length);
  ok((await page.$eval('.dash-head-stats', (e) => e.textContent)).startsWith('1 board'), 'head: 1 board');
  ok((await page.$eval(`${D} .fb-chip-v`, (e) => e.textContent)) === 'api', 'chip: "api"');
}
await shot('dash-3-scope-api');

// range 2w: done counts only
await page.selectOption(dsel('Scope'), seed.ws);
await page.click(`${D} .mx-seg-btn:text-is("2w")`);
const from2w = twoWeeksFrom();
await expectTiles({ from: from2w }, allBoards, 'range 2w (done counts only)');
ok(param('range') === '2w' && keysIn().join() === 'range', 'range in the URL (scope back to default: omitted)', page.url());
ok((await page.$eval(`.dash-tile[data-id="${seed.web}"] .dt-lane[data-lane="done"] .dt-lane-l`, (e) => e.textContent)) === 'done 2w', 'done lane labelled "done 2w"');
ok((await page.$eval(`${D} .fb-chip-v`, (e) => e.textContent)) === 'done in 2w', 'chip: "done in 2w"');
{
  // custom range: 10 days ago … 3 days ago (inclusive local days)
  const day = (n) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d;
  };
  await page.click(`${D} .mx-range .mx-chip`);
  await page.fill(`${D} .mx-pop-field:has-text("From") input`, localDay(day(10)));
  await page.fill(`${D} .mx-pop-field:has-text("To") input`, localDay(day(3)));
  await page.click(`${D} .mx-pop .mx-btn.primary`);
  await expectTiles({ from: day(10).getTime(), to: day(2).getTime() }, allBoards, 'custom range (done counts)');
  ok(param('range') === 'custom' && param('from') === localDay(day(10)) && param('to') === localDay(day(3)), 'custom range in the URL', page.url());
  ok((await page.$eval(`.dash-tile[data-id="${seed.web}"] .dt-lane[data-lane="done"] .dt-lane-l`, (e) => e.textContent)) === `done ${shortDay(day(10))}–${shortDay(day(3))}`, 'custom: done lane names the range');
  await shot('dash-3b-custom-range');
  await page.click(`${D} .mx-seg-btn:text-is("2w")`);
}

// URL round trip: tag + range, reload
await page.click(`${D} .fb-chip`); // collapse
await page.click(`${D} .fb-chip`); // expand again
await page.selectOption(dsel('Tag'), 'api');
await settledDash();
const before = page.url();
await page.reload();
await settledDash();
ok(page.url() === before, 'reload keeps the URL', { before, after: page.url() });
await expectTiles({ tag: 'api', from: from2w }, allBoards, 'after reload: tag api + 2w');
ok((await page.$eval(`${D} .fb-chip-v`, (e) => e.textContent)) === 'api · done in 2w', 'after reload: chip "api · done in 2w"');

// ---- drill-down: a lane count ----
{
  const f = { tag: 'api', from: from2w };
  await page.click(`.dash-tile[data-id="${seed.api}"] .dt-lane[data-lane="queued"]`);
  await page.waitForSelector('#dashboard-view .mx-drill');
  const want = cards.filter((c) => c.board === seed.api && c.lane === 'queued' && match(f, c));
  const rows = await page.$$eval('.mx-drill-row', (rs) => rs.map((r) => ({ t: r.querySelector('.mx-drill-title').textContent, m: r.querySelector('.mx-drill-meta').textContent, open: !!r.querySelector('.mx-btn') })));
  ok(JSON.stringify(rows.map((r) => r.t).sort()) === JSON.stringify(want.map((c) => c.title).sort()), 'drill api queued: the matching cards', { rows, want: want.map((c) => c.title) });
  ok(rows.every((r, i) => r.m.startsWith('api · ') && r.m.includes('Queued') && r.open), 'drill rows: board · agent · lane, with Open', rows);
  const agentsOk = rows.every((r) => want.some((c) => r.m.includes(c.agent ?? 'unassigned')));
  ok(agentsOk, 'drill rows name the agent');
  ok((await page.$eval('#mx-drill-title', (e) => e.textContent)) === `${want.length} cards in Queued` || (await page.$eval('#mx-drill-title', (e) => e.textContent)) === `${want.length} card in Queued`, 'drill title: N cards in Queued');
  ok((await page.$eval('.mx-drill-foot .mx-btn.primary', (e) => e.textContent)) === `Open all ${want.length} in Kanban`, '"Open all N in Kanban"');
  ok((await page.$eval('.mx-drill-sub', (e) => e.textContent)).includes('tag api'), 'drill sub names the filters');
  await shot('dash-4-drill-queued');
  await page.keyboard.press('Escape');
  ok(!(await page.$('.mx-drill')), 'Esc closes the drill');
}
{
  // done count under the range
  const f = { tag: 'api', from: from2w };
  await page.click(`.dash-tile[data-id="${seed.api}"] .dt-lane[data-lane="done"]`);
  await page.waitForSelector('#dashboard-view .mx-drill');
  const want = cards.filter((c) => c.board === seed.api && c.lane === 'done' && match(f, c));
  const n = await page.$$eval('.mx-drill-row', (rs) => rs.length);
  ok(n === want.length, 'drill api done (2w, tag api): count', { n, want: want.length });
  ok((await page.$eval('.mx-drill-sub', (e) => e.textContent)).startsWith('done in 2w'), 'done drill names the range');
  await shot('dash-5-drill-done');
  await page.click('.mx-drill-close');
}
// needs-you count
await page.click(`${D} .fb-clear`);
await settledDash();
ok(keysIn().length === 0 && param('view') === 'dashboard', 'Clear: filter keys gone from the URL', page.url());
ok((await page.$eval(`${D} .fb-chip`, (e) => e.textContent)).startsWith('Filters') && !(await page.$(`${D} .fb-chip-v`)), 'Clear: chip back to "Filters"');
await expectTiles({}, allBoards, 'after Clear');
{
  await page.click('.dash-attn .da-count');
  await page.waitForSelector('#dashboard-view .mx-drill');
  const titles = await page.$$eval('.mx-drill-row .mx-drill-title', (es) => es.map((e) => e.textContent).sort());
  const want = summary.attention.map((i) => i.title).sort();
  ok(JSON.stringify(titles) === JSON.stringify(want), 'needs-you count → drill of the items', { titles, want });
  const groups = await page.$$eval('.mx-drill-alls .mx-btn', (es) => es.map((e) => e.textContent));
  ok(groups.length >= 2, 'several boards → one "Open N in <board>" per board', groups);
  await shot('dash-6-drill-needs-you');
  // Open all in Kanban (Main board = this project) → Kanban highlight
  const mainBtn = groups.find((g) => g.endsWith('in Main'));
  await page.click(`.mx-drill-alls .mx-btn:text-is("${mainBtn}")`);
  await page.waitForTimeout(400);
  const nMain = summary.attention.filter((i) => i.project_id === seed.ws).length;
  ok((await page.$eval('#rail-kanban', (e) => e.classList.contains('active'))) && (await page.$$('.card.mx-hl')).length === nMain, 'Open all → Kanban with the cards highlighted', nMain);
  ok(param('view') !== 'dashboard' && keysIn().length === 0, 'left the dashboard: view + keys gone from the URL', page.url());
}
// leave with filters on → cleared
await page.click('#rail-dashboard');
await settledDash();
await page.click(`${D} .fb-chip`);
await page.selectOption(dsel('Tag'), 'db');
await settledDash();
ok(param('tag') === 'db', 'tag db set');
await page.click(`.dash-tile[data-id="${seed.ws}"] .dt-lane[data-lane="backlog"]`);
await page.waitForSelector('#dashboard-view .mx-drill');
await page.click('#rail-kanban');
ok(!(await page.$('.mx-drill')), 'switching views closes an open drill');
ok(keysIn().length === 0 && param('view') !== 'dashboard', 'leaving the dashboard clears its filters from the URL', page.url());
await page.click('#rail-dashboard');
await settledDash();
ok((await page.$eval(`${D} .fb-chip`, (e) => e.textContent)).startsWith('Filters') && !(await page.$(`${D} .fb-chip-v`)), 'coming back: no filters');
// Metrics still starts clean after the dashboard had filters
await page.click(`${D} .fb-chip`);
await page.selectOption(dsel('Tag'), 'ui');
await settledDash();
await page.click('#rail-metrics');
await page.waitForTimeout(500);
ok(param('view') === 'metrics' && !param('tag'), 'dashboard → Metrics: the dashboard\'s tag does not leak into Metrics', page.url());
await page.click('#rail-dashboard');
await settledDash();
ok(!param('tag') && !(await page.$(`${D} .fb-chip-v`)), 'Metrics → dashboard: clean');
const kd1 = await docKeydownListeners();
ok(kd1 === kd0, 'no keydown listeners leaked (drills opened / closed, views switched)', { kd0, kd1 });

// ================= HOME =================
const H = '#home-filters';
const hsel = (label) => `${H} label.mx-field:has(> span:text-is("${label}")) select`;
const settledHome = () =>
  page.waitForFunction(() => typeof hctx !== 'undefined' && hctx.meta && home.data && !document.querySelector('#home-upnext .home-empty')?.textContent.startsWith('Loading') && ![...document.querySelectorAll('.home-vlane')].some((e) => e.textContent.startsWith('…')), null, { timeout: 15000 });
const homeAll = await api(`/home?project=${seed.ws}`);
const texts = (sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent));
async function homeNow() {
  const hero = await page.$eval('#home-now .home-hero-title', (e) => e.textContent);
  const rest = await texts('#home-now .home-other-title');
  return hero === 'Nothing in flight' || hero === 'Nothing matching in flight' ? [] : [hero, ...rest];
}
await page.click('#rail-home');
await settledHome();
ok(JSON.stringify(await homeNow()) === JSON.stringify(homeAll.now_building.map((x) => x.title)), 'Home unfiltered: Now building = /home');
ok(JSON.stringify(await texts('#home-upnext .home-uptitle')) === JSON.stringify(homeAll.up_next.items.map((x) => x.title)), 'Home unfiltered: Up next = /home');
ok((await page.$eval(`${H} .fb-chip`, (e) => e.textContent)) === 'Filters▾', 'Home: compact Filters chip');
await shot('home-1-unfiltered');

// scope api: cross-check with the server's own /home for the api vertical
await page.click(`${H} .fb-chip`);
ok((await page.$$eval(`${H} .fb-bar label.mx-field > span`, (es) => es.map((e) => e.textContent))).join('|') === 'Scope|Phase|Tag|Agent' && !(await page.$(`${H} .fb-bar .mx-seg`)), 'Home bar: Scope, Phase, Tag, Agent; no range');
await page.selectOption(hsel('Scope'), seed.api);
await settledHome();
{
  const homeApi = await api(`/home?project=${seed.api}`);
  ok(JSON.stringify(await homeNow()) === JSON.stringify(homeApi.now_building.map((x) => x.title)), 'scope api: Now building = the server\'s api Home', { got: await homeNow(), want: homeApi.now_building.map((x) => x.title) });
  ok(JSON.stringify(await texts('#home-upnext .home-uptitle')) === JSON.stringify(homeApi.up_next.items.map((x) => x.title)), 'scope api: Up next = the server\'s api Home (same pick order)', { got: await texts('#home-upnext .home-uptitle'), want: homeApi.up_next.items.map((x) => x.title) });
  ok((await page.$eval('#home-upnext .home-link', (e) => e.textContent)) === `View all ${homeApi.up_next.total_pending} in Kanban →`, 'scope api: total pending = the server\'s', homeApi.up_next.total_pending);
  ok(JSON.stringify(await texts('.home-vname')) === JSON.stringify(['api']), 'scope api: verticals list = api');
  ok(param('view') === 'home' && param('scope') === seed.api, 'Home filters URL-backed (view=home&scope=…)', page.url());
}
await shot('home-2-scope-api');

// tag db within api: queued db card, then the waiter (waiting on the in-progress card)
await page.selectOption(hsel('Tag'), 'db');
await settledHome();
{
  const f = { scope: seed.api, tag: 'db' };
  const q = cards.filter((c) => c.board === seed.api && c.lane === 'queued' && match(f, c)).map((c) => c.title);
  const bl = cards.filter((c) => c.board === seed.api && c.lane === 'backlog' && c.phase_id === seed.phases.apiV1 && match(f, c)).map((c) => c.title);
  const want = [...q, ...bl].slice(0, 3);
  ok(JSON.stringify(await texts('#home-upnext .home-uptitle')) === JSON.stringify(want), 'scope api + tag db: Up next', { got: await texts('#home-upnext .home-uptitle'), want });
  const st = await texts('#home-upnext .home-status');
  ok(st[st.length - 1] === `Waiting on: ${blocker.title} (api)`, 'the waiter shows "Waiting on: … (api)" and no Queue it', st);
  const nb = cards.filter((c) => ['in_progress', 'in_review'].includes(c.lane) && match(f, c)).map((c) => c.title);
  ok(JSON.stringify((await homeNow()).sort()) === JSON.stringify(nb.sort()), 'scope api + tag db: Now building', { got: await homeNow(), nb });
  const lanes = await page.$eval('.home-vrow .home-vlanes', (e) => e.textContent);
  const n = counts(f, seed.api);
  const wantLanes = [['backlog', 'backlog'], ['queued', 'queued'], ['in_progress', 'in prog'], ['in_review', 'review'], ['done', 'done']].map(([l, t]) => `${n[l]} ${t}`).join(' · ');
  ok(lanes === wantLanes, 'vertical lane counts filtered', { lanes, wantLanes });
  // agents: those with a matching card
  const names = [...new Set(cards.filter((c) => c.agent && match(f, c)).map((c) => c.agent))].sort();
  ok(JSON.stringify((await texts('.home-agent-name')).sort()) === JSON.stringify(names), 'agents strip: members with a matching card', { got: await texts('.home-agent-name'), names });
  ok((await page.$eval(`${H} .fb-chip-v`, (e) => e.textContent)) === 'api · db', 'Home chip: "api · db"');
}
await shot('home-3-api-db');

// agent filter: just them
await page.selectOption(hsel('Tag'), '');
await page.selectOption(hsel('Scope'), seed.ws);
await page.selectOption(hsel('Agent'), 'Knwar');
await settledHome();
{
  ok(JSON.stringify(await texts('.home-agent-name')) === JSON.stringify(['Knwar']), 'agent Knwar: agents strip = Knwar');
  const want = homeAll.now_building.filter((x) => x.agent === 'Knwar').map((x) => x.title);
  ok(JSON.stringify(await homeNow()) === JSON.stringify(want), 'agent Knwar: Now building', { got: await homeNow(), want });
  // Up next: nothing in queued/backlog is Knwar's except queued ones
  const f = { agent: 'Knwar' };
  const up = await texts('#home-upnext .home-uptitle');
  ok(up.every((t) => cards.find((c) => c.title === t)?.agent === 'Knwar'), 'agent Knwar: Up next only Knwar\'s', up);
  // reload keeps it
  const before = page.url();
  await page.reload();
  await settledHome();
  ok(page.url() === before && JSON.stringify(await texts('.home-agent-name')) === JSON.stringify(['Knwar']), 'Home reload keeps the filters', { before, after: page.url() });
  // drill: Now building count
  await page.click('#home-now .home-count');
  await page.waitForSelector('#home-view .mx-drill');
  const rows = await texts('.mx-drill-row .mx-drill-title');
  ok(JSON.stringify(rows.sort()) === JSON.stringify(want.sort()), 'Now building count → drill of those cards', { rows, want });
  const metas = await texts('.mx-drill-row .mx-drill-meta');
  ok(metas.every((m) => m.includes('Knwar') && /In Progress|In Review/.test(m)), 'rows carry board · agent · lane', metas);
  await shot('home-4-drill-now');
  await page.click('.mx-drill-close');
  // drill: a vertical's lane count (agent filter applies)
  await page.click(`.home-vrow:has(.home-vname:text-is("api")) .home-vlane:has-text("done")`);
  await page.waitForSelector('#home-view .mx-drill');
  const n = await page.$$eval('.mx-drill-row', (rs) => rs.length);
  const wantN = cards.filter((c) => c.board === seed.api && c.lane === 'done' && match(f, c)).length;
  ok(n === wantN, 'vertical done count → drill (agent Knwar)', { n, wantN });
  ok((await page.$eval('.mx-drill-foot .mx-btn.primary', (e) => e.textContent)) === `Open all ${wantN} in Kanban`, 'Open all N in Kanban');
  await shot('home-5-drill-lane');
  await page.keyboard.press('Escape');
}
// Clear, leave
await page.click(`${H} .fb-clear`);
await settledHome();
ok(keysIn().length === 0 && JSON.stringify(await homeNow()) === JSON.stringify(homeAll.now_building.map((x) => x.title)), 'Home Clear: URL clean, back to /home', page.url());
await page.click(`${H} .fb-chip`);
await page.selectOption(hsel('Tag'), 'ui');
await settledHome();
await page.click('#rail-kanban');
ok(keysIn().length === 0 && param('view') !== 'home', 'leaving Home clears its filters from the URL', page.url());
// Home → Dashboard link keeps nothing
await page.click('#rail-home');
await settledHome();
ok(!(await page.$(`${H} .fb-chip-v`)), 'back on Home: no filters');

// ---- Home on a vertical: scope locked, no Scope field ----
await page.goto(`${base}/?project=${seed.web}&view=home`);
await settledHome();
await page.click(`${H} .fb-chip`);
ok((await page.$$eval(`${H} .fb-bar label.mx-field > span`, (es) => es.map((e) => e.textContent))).join('|') === 'Phase|Tag|Agent', 'Home on a vertical: no Scope field');
await page.selectOption(hsel('Agent'), 'Inder');
await settledHome();
{
  const homeWeb = await api(`/home?project=${seed.web}`);
  const want = homeWeb.now_building.filter((x) => x.agent === 'Inder').map((x) => x.title);
  ok(JSON.stringify(await homeNow()) === JSON.stringify(want), 'vertical Home + agent: Now building', { got: await homeNow(), want });
  ok(keysIn().join() === 'agent', 'vertical Home: the locked scope stays out of the URL', page.url());
  ok((await page.$eval(`${H} .fb-chip-v`, (e) => e.textContent)) === 'Inder', 'chip: "Inder"');
}
await shot('home-6-vertical');

// ---- embed dashboard: no chip, counts not buttons ----
await page.goto(`${base}/?project=${seed.ws}&view=dashboard&embed=1&tag=ui`);
await page.waitForFunction(() => document.querySelector('.dash-tile') && dctx.meta && ![...document.querySelectorAll('.dt-lane-n')].some((e) => e.textContent === '…'), null, { timeout: 15000 });
ok(!(await page.$('.fb-chip')) && !(await page.$('button.dt-lane')), 'embed: no chip, no drill buttons');
{
  const got = await tileCounts();
  ok(allBoards.every((b) => JSON.stringify(got[b]) === JSON.stringify(counts({ tag: 'ui' }, b))), 'embed: URL filters still apply');
}


// ================= ROUND 2: live refetches never touch the filter controls =================
// (a WS-triggered refetch used to rebuild the bar: closed selects, lost focus, wiped dates)
const moveCard = async (board, from, to) => {
  const c = (await api(`/board?project=${board}`)).find((x) => x.lane === from);
  await post(`/task/${c.id}/move`, { lane: to });
  return c;
};
// The dashboard's / Home's data reads (fetch GETs), by path: the filters' per-board fan-out
// (/board, /phases, /task/<id>) must be gone. (The current board's own live reads — /attention,
// /git/status — ride its board socket, not the view's refetch.)
const VIEW_READS = ['/workspace/summary', '/workspace/cards', '/home', '/session', '/workspace', '/board', '/phases'];
const dataReqs = (pg) => {
  const list = [];
  pg.on('request', (r) => {
    const u = new URL(r.url());
    if (r.resourceType() === 'fetch' && r.method() === 'GET' && (VIEW_READS.includes(u.pathname) || u.pathname.startsWith('/task/'))) list.push(u.pathname);
  });
  return list;
};
const reqLog = dataReqs(page);
await page.goto(`${base}/?project=${seed.ws}&view=dashboard&tag=api`);
await settledDash();
await page.click(`${D} .fb-chip`);
await page.waitForSelector(`${D} .fb-bar select[data-fb="tag"]`);
await page.focus(`${D} select[data-fb="tag"]`);
await page.evaluate(() => (document.activeElement.__mark = 'tag'));
{
  // tile counts are under tag=api: check the refetch against the unfiltered queued total instead
  const q0 = (await api(`/workspace/summary?project=${seed.ws}`)).boards[0].lanes.queued;
  await page.evaluate(() => (window.__sum0 = dash.summary));
  reqLog.length = 0;
  await moveCard(seed.ws, 'backlog', 'queued'); // a live 'card' message → refetch (+ a filtered meta reload)
  await page.waitForFunction(() => dash.summary !== window.__sum0, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500); // the meta reload lands too
  ok((await page.evaluate(() => dash.summary !== window.__sum0)) && (await api(`/workspace/summary?project=${seed.ws}`)).boards[0].lanes.queued === q0 + 1, 'the refetch did happen (summary updated)');
  const s = await page.evaluate(() => ({ mark: document.activeElement.__mark, value: document.activeElement.value }));
  ok(s.mark === 'tag' && s.value === 'api', 'dashboard: a refetch keeps the focused Tag select (same element, same value)', s);
  console.log(`     dashboard refetch while filtered: ${reqLog.length} requests (${reqLog.join(', ')})`);
  ok(reqLog.length <= 2 && reqLog.filter((u) => u === '/workspace/summary').length === 1, 'dashboard: ≤ 2 requests per refetch while filtered (summary + cards)', reqLog);
  ok(!reqLog.some((u) => /^\/(board|phases|task\/)/.test(u)), 'dashboard: no per-board fan-out', reqLog);
}
// custom range popover: a half-typed range survives a refetch
await page.click(`${D} .mx-range .mx-chip`);
await page.fill(`${D} input[data-fb="from"]`, '2026-01-05');
await page.focus(`${D} input[data-fb="to"]`);
await page.evaluate(() => (document.activeElement.__mark = 'to'));
await moveCard(seed.ws, 'backlog', 'queued');
await page.waitForTimeout(2500);
{
  const s = await page.evaluate(() => ({ mark: document.activeElement.__mark, from: document.querySelector('.dash-filters input[data-fb="from"]')?.value, pop: !!document.querySelector('.dash-filters .mx-pop') }));
  ok(s.mark === 'to' && s.from === '2026-01-05' && s.pop, 'dashboard: the custom-range popover, its typed From and the focused To survive a refetch', s);
}
await page.keyboard.press('Escape');
// Home: the focused Agent select survives
await page.goto(`${base}/?project=${seed.ws}&view=home&tag=api`);
await settledHome();
await page.click(`${H} .fb-chip`);
await page.waitForSelector(`${H} .fb-bar select[data-fb="agent"]`);
await page.focus(`${H} select[data-fb="agent"]`);
await page.evaluate(() => (document.activeElement.__mark = 'agent'));
{
  // lane counts are under tag=api: move an api-tagged backlog card so they visibly move
  const v0 = await page.$$eval('.home-vlanes', (es) => es.map((e) => e.textContent).join('|'));
  const mv = (await api(`/board?project=${seed.api}`)).find((x) => x.lane === 'backlog' && x.tag === 'api') ?? (await api(`/board?project=${seed.api}`)).find((x) => x.lane === 'backlog');
  reqLog.length = 0;
  await post(`/task/${mv.id}/move`, { lane: 'queued' });
  await page.waitForFunction((v) => [...document.querySelectorAll('.home-vlanes')].map((e) => e.textContent).join('|') !== v, v0, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const v1 = await page.$$eval('.home-vlanes', (es) => es.map((e) => e.textContent).join('|'));
  ok(v1 !== v0, 'Home: the refetch did happen (lane counts moved)', { v0, v1, tag: mv.tag });
  const s = await page.evaluate(() => ({ mark: document.activeElement.__mark, fb: document.activeElement.dataset?.fb }));
  ok(s.mark === 'agent', 'Home: a refetch keeps the focused Agent select', s);
  console.log(`     Home refetch while filtered: ${reqLog.length} requests (${reqLog.join(', ')})`);
  ok(reqLog.length <= 2 && reqLog.filter((u) => u === '/home').length === 1, 'Home: ≤ 2 requests per refetch while filtered (/home + cards)', reqLog);
  ok(!reqLog.some((u) => /^\/(board|phases|task\/)/.test(u)), 'Home: no per-board fan-out (no Up-next /task reads)', reqLog);
}

// ---- keyboard: the chip and Clear keep focus; aria ----
await page.goto(`${base}/?project=${seed.ws}&view=dashboard&tag=ui`);
await settledDash();
await page.focus(`${D} .fb-chip`);
await page.keyboard.press('Enter');
await page.waitForSelector('#dash-fb-bar');
ok((await page.evaluate(() => document.activeElement.dataset.fb)) === 'chip', 'Enter on the chip expands the bar, focus stays on the chip');
ok((await page.$eval(`${D} .fb-chip`, (e) => [e.getAttribute('aria-controls'), e.getAttribute('aria-expanded'), e.querySelector('.fb-caret').getAttribute('aria-hidden')].join())) === 'dash-fb-bar,true,true', 'chip: aria-controls the bar, aria-expanded, caret aria-hidden');
await page.keyboard.press('Enter');
ok(!(await page.$('#dash-fb-bar')) && (await page.evaluate(() => document.activeElement.dataset.fb)) === 'chip', 'Enter again collapses it, focus stays');
await page.focus(`${D} .fb-clear`);
await page.keyboard.press('Enter');
await settledDash();
ok((await page.evaluate(() => document.activeElement.dataset.fb)) === 'chip' && !param('tag'), 'Clear by keyboard: filters gone, focus on the chip');
await page.click(`${D} .fb-chip`);
await page.focus(dsel('Tag'));
await page.selectOption(dsel('Tag'), 'db');
ok((await page.evaluate(() => document.activeElement.dataset.fb)) === 'tag', 'choosing a Tag keeps focus on the Tag select');

// ---- one load per open; none in embed without filters ----
{
  // a fresh tab: meta loads (one /workspace/cards read each) never outnumber summary loads
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const reqs = [];
  tab.on('request', (r) => reqs.push(r.url()));
  await tab.goto(`${base}/?project=${seed.ws}&view=dashboard&tag=ui`);
  await tab.waitForFunction(() => dctx.meta && document.querySelector('.dash-tile'), null, { timeout: 15000 });
  await tab.waitForTimeout(1500);
  const metaLoads = reqs.filter((u) => u.includes('/workspace/cards?')).length;
  const summaries = reqs.filter((u) => u.includes('/workspace/summary')).length;
  ok(metaLoads >= 1 && metaLoads <= summaries, 'dashboard open with filters: no double load (meta loads ≤ summary loads)', { metaLoads, summaries });
  ok(!reqs.some((u) => /\/(board|phases)\?project=/.test(u)), 'dashboard open with filters: no per-board /board or /phases reads', reqs.filter((u) => /\/(board|phases)\?/.test(u)));
  reqs.length = 0;
  await tab.goto(`${base}/?project=${seed.ws}&view=dashboard&embed=1`);
  await tab.waitForSelector('.dash-tile');
  await tab.waitForTimeout(1500);
  ok(!reqs.some((u) => u.includes('/workspace/cards?') || u.includes('/board?project=')), 'embed without filters: no filter data loaded', reqs.filter((u) => u.includes('/workspace/cards?') || u.includes('/board?')));
  await tab.close();
}

// ---- loading states while a filter change's read is on its way (never "Nothing matching…") ----
const slow = async (r) => {
  await new Promise((res) => setTimeout(res, 2500));
  await r.continue().catch(() => {});
};
await page.goto(`${base}/?project=${seed.ws}&view=home&tag=ui`);
await settledHome();
await page.route('**/home?*', slow);
await page.click(`${H} .fb-chip`);
await page.selectOption(hsel('Tag'), 'db');
await page.waitForTimeout(200);
ok((await page.$eval('#home-now .home-hero-title', (e) => e.textContent)) === 'Loading…' && (await page.$eval('#home-upnext .home-empty', (e) => e.textContent)) === 'Loading…', 'Home: "Loading…" (not the previous filters\' data, not "Nothing matching") before /home lands');
await page.unroute('**/home?*', slow);
await page.goto(`${base}/?project=${seed.ws}&view=dashboard&tag=ui`);
await settledDash();
await page.route('**/workspace/summary?*', slow);
await page.click(`${D} .fb-chip`);
await page.selectOption(dsel('Tag'), 'db');
await page.waitForTimeout(200);
ok((await page.$eval('.dash-grid', (e) => e.textContent)).startsWith('Loading') && (await page.$eval('.dash-attn', (e) => e.textContent)).includes('Loading'), 'dashboard: loading state before the summary for the new filters lands');
await page.unroute('**/workspace/summary?*', slow);

// ---- carry-over: filter options landing while the user is in the bar ("Loading boards…") ----
// the deferred redraw runs once focus leaves the bar, so the Scope / Phase / Tag / Agent selects appear
{
  let release;
  const gate = new Promise((r) => (release = r));
  const held = async (r) => {
    await gate;
    await r.continue().catch(() => {});
  };
  await page.route('**/workspace/cards?*', held);
  await page.goto(`${base}/?project=${seed.ws}&view=dashboard`);
  await page.waitForSelector('.dash-tile');
  await page.click(`${D} .fb-chip`);
  await page.waitForSelector(`${D} .fb-bar .mx-dim`);
  await page.focus(`${D} .mx-seg-btn[data-fb="range-2w"]`);
  release();
  await page.waitForFunction(() => dctx.meta, null, { timeout: 10000 });
  await page.waitForTimeout(200);
  ok(!!(await page.$(`${D} .fb-bar .mx-dim`)), 'options landed while focus was in the bar: its redraw waits');
  await page.click('.dash-head-name'); // focus leaves the bar
  await page.waitForTimeout(200);
  ok((await page.$$eval(`${D} .fb-bar label.mx-field > span`, (es) => es.map((e) => e.textContent))).join('|') === 'Scope|Phase|Tag|Agent', 'focus left the bar: the deferred redraw ran (selects shown)');
  await page.unroute('**/workspace/cards?*', held);
}

// ---- the needs-you drill counts "items" once a session waits ----
await post('/status', { project_id: seed.web, agent: 'orchestrator', verb: 'needs you', detail: 'permission prompt' });
await page.goto(`${base}/?project=${seed.ws}&view=dashboard`);
await settledDash();
await page.waitForSelector('.dash-attn .da-waiting');
await page.click('.dash-attn .da-count');
await page.waitForSelector('#dashboard-view .mx-drill');
{
  const n = await page.$$eval('.mx-drill-row', (rs) => rs.length);
  ok((await page.$eval('.mx-drill-count', (e) => e.textContent)) === `${n} items`, 'needs-you drill with a waiting session: "N items"', n);
  await shot('dash-8-needs-you-items');
}

// ---- a relative range crossing midnight: an idle dashboard / OBS embed never drops to "Loading…" ----
// (the data's key is the range as chosen, not its epoch ms: those move when the day rolls over)
for (const [what, at, q] of [
  ['2w across Sunday → Monday (the window moves)', (() => { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); d.setHours(23, 59, 0, 0); return d; })(), 'range=2w'],
]) {
  for (const embed of [false, true]) {
    const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await tab.clock.install({ time: at });
    await tab.goto(`${base}/?project=${seed.ws}&view=dashboard&${q}${embed ? '&embed=1' : ''}`);
    await tab.waitForFunction(() => document.querySelector('.dash-tile') && dctx.meta, null, { timeout: 15000 });
    await tab.clock.fastForward('02:00'); // past midnight, no refetch
    // a status ping redraws Needs you in place (no refetch); then a full redraw of the same data
    await post('/status', { project_id: seed.api, agent: 'orchestrator', verb: 'Edit', detail: 'x.ts' });
    await tab.waitForTimeout(400);
    const attn = await tab.$eval('.dash-attn', (e) => e.textContent);
    await tab.evaluate(() => renderDashboard());
    const grid = await tab.$eval('.dash-grid', (e) => e.textContent);
    const tiles = (await tab.$$('.dash-tile')).length;
    const day = await tab.evaluate(() => new Date().getDate());
    ok(!attn.includes('Loading') && !grid.startsWith('Loading') && tiles === 4 && day !== at.getDate(), `midnight (${what}${embed ? ', embed' : ''}): tiles + Needs you stay, no "Loading…"`, { attn: attn.slice(0, 40), grid: grid.slice(0, 40), tiles, day });
    await tab.close();
  }
}

ok(errors.length === 0, 'no page errors', errors);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
