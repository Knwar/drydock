// Headless checks of the overlay's shared filters + drill-down on Home (its chip, Range control
// and widgets) and the OBS dashboard embed (URL filters) (cards dc4c1045, 978c61fa). Self-contained: starts its own daemon on a scratch DB + port, seeds ~8
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

// The overlay's data reads still on the wire: page.on('request') +1, finished / failed -1.
let inflight = 0;
page.on('request', () => inflight++);
page.on('requestfinished', () => inflight--);
page.on('requestfailed', () => inflight--);
async function quiet() {
  for (let i = 0, still = 0; i < 200; i++) {
    if (inflight <= 0) {
      if (++still >= 4) return;
    } else still = 0;
    await page.waitForTimeout(100);
  }
  throw new Error(`network never went quiet (${inflight} in flight)`);
}
// every request of the page (url strings) from now on, until stopped
function reqWatch(pg = page) {
  const list = [];
  const on = (r) => list.push(r.url());
  pg.on('request', on);
  list.stop = () => pg.off('request', on);
  return list;
}
const paths = (list) => list.map((u) => new URL(u).pathname);
const LIVE_READS = ['/home', '/workspace/summary', '/workspace/cards'];
// Monday of the week (n - 1) weeks back, local midnight: a rolling n-week range's start (mxWindow)
function weeksFrom(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 * (n - 1));
  return d.getTime();
}
const from2w = weeksFrom(2);
const from4w = weeksFrom(4);
const allBoards = BOARDS.map((k) => seed[k]);
const texts = (sel) => page.$$eval(sel, (es) => es.map((e) => e.textContent));
async function tileCounts(sel) {
  return page.$$eval(sel, (ts) =>
    Object.fromEntries(ts.map((t) => [t.dataset.id, Object.fromEntries([...t.querySelectorAll('.dt-lane')].map((l) => [l.dataset.lane, Number(l.querySelector('.dt-lane-n').textContent.split('/')[0])]))])),
  );
}
async function expectTiles(sel, f, boards, msg) {
  const got = await tileCounts(sel);
  const want = Object.fromEntries(boards.map((b) => [b, counts(f, b)]));
  ok(JSON.stringify(Object.keys(got).sort()) === JSON.stringify([...boards].sort()), `${msg}: tiles shown`, { got: Object.keys(got), want: boards });
  const bad = boards.filter((b) => JSON.stringify(got[b]) !== JSON.stringify(want[b]));
  ok(!bad.length, `${msg}: lane counts match the data`, bad.map((b) => ({ b, got: got[b], want: want[b] })));
}

// ================= DASHBOARD (embed / OBS: filters from the URL only) =================
// The interactive Dashboard view is gone (?view=dashboard without embed lands on Home, whose
// workspace-boards widget carries the tiles); the embed still renders the server-filtered summary.
const DT = '#dashboard-view .dash-tile';
const embedUrl = (q = '') => `${base}/?project=${seed.ws}&view=dashboard&embed=1${q ? `&${q}` : ''}`;
async function embed(q) {
  await page.goto(embedUrl(q));
  await page.waitForFunction(
    () => document.querySelector('#dashboard-view .dash-tile') && dash.summary && dash.summaryKey === fbParams(dctx, true) && ![...document.querySelectorAll('.dt-lane-n')].some((e) => e.textContent === '…'),
    null,
    { timeout: 15000 },
  );
  await quiet();
}
{
  const reqs = reqWatch();
  await embed();
  reqs.stop();
  await expectTiles(DT, {}, allBoards, 'embed unfiltered');
  ok(!(await page.$('.fb-chip')) && !(await page.$('button.dt-lane')), 'embed: no chip, no drill buttons');
  ok(!reqs.some((u) => u.includes('/workspace/cards?') || u.includes('/board?project=')), 'embed without filters: no filter data loaded', reqs.filter((u) => u.includes('/workspace/cards?') || u.includes('/board?')));
  await shot('dash-1-unfiltered');
}
await embed('tag=ui');
await expectTiles(DT, { tag: 'ui' }, allBoards, 'embed tag ui');
{
  const want = summary.attention.filter((i) => cards.find((c) => c.id === i.card_id)?.tag === 'ui').map((i) => i.title);
  const got = await texts('.dash-attn .att-title');
  ok(JSON.stringify(got) === JSON.stringify(want), 'embed tag ui: Needs you list filtered', { got, want });
  const inflight = (await texts(`${DT} .dt-card-title`)).sort();
  const wantIn = cards.filter((c) => ['in_progress', 'in_review'].includes(c.lane) && c.tag === 'ui').map((c) => c.title).sort();
  ok(JSON.stringify(inflight) === JSON.stringify(wantIn), 'embed tag ui: in-flight cards on tiles filtered', { inflight, wantIn });
  await shot('dash-2-tag-ui');
}
await embed('tag=ui&agent=Ada');
await expectTiles(DT, { tag: 'ui', agent: 'Ada' }, allBoards, 'embed tag ui + agent Ada');
await embed(`phase=${seed.phases.webCheckout}`);
await expectTiles(DT, { phase: seed.phases.webCheckout }, [seed.web], 'embed phase Web checkout → web tile only');
{
  const want = summary.attention.filter((i) => i.phase_id === seed.phases.webCheckout).map((i) => i.title);
  const got = await texts('.dash-attn .att-title');
  ok(JSON.stringify(got) === JSON.stringify(want), 'embed phase: Needs you filtered to the phase', { got, want });
  const inPhase = cards.filter((c) => c.phase_id === seed.phases.webCheckout);
  const bar = await page.$eval(`${DT}[data-id="${seed.web}"] .dt-phase-n`, (e) => e.textContent);
  ok(bar === `${inPhase.filter((c) => c.lane === 'done').length}/${inPhase.length}`, "embed phase: the tile's phase bar is that phase", bar);
}
await embed(`scope=${seed.api}`);
await expectTiles(DT, { scope: seed.api }, [seed.api], 'embed scope api → api tile only');
{
  const want = summary.attention.filter((i) => i.project_id === seed.api).map((i) => i.title);
  const got = await texts('.dash-attn .att-title');
  ok(JSON.stringify(got) === JSON.stringify(want), 'embed scope api: Needs you = api items', { got, want });
  ok((await page.$eval('.dash-attn .da-count', (e) => e.textContent)) === String(want.length), 'embed scope api: needs-you count', want.length);
  ok((await page.$eval('.dash-head-stats', (e) => e.textContent)).startsWith('1 board'), 'embed head: 1 board');
}
await embed('range=2w');
await expectTiles(DT, { from: from2w }, allBoards, 'embed range 2w (done counts only)');
ok((await page.$eval(`${DT}[data-id="${seed.web}"] .dt-lane[data-lane="done"] .dt-lane-l`, (e) => e.textContent)) === 'done 2w', 'embed: done lane labelled "done 2w"');
{
  const day = (n) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d;
  };
  await embed(`range=custom&from=${localDay(day(10))}&to=${localDay(day(3))}`);
  await expectTiles(DT, { from: day(10).getTime(), to: day(2).getTime() }, allBoards, 'embed custom range (done counts)');
  ok((await page.$eval(`${DT}[data-id="${seed.web}"] .dt-lane[data-lane="done"] .dt-lane-l`, (e) => e.textContent)) === `done ${shortDay(day(10))}–${shortDay(day(3))}`, 'embed custom: done lane names the range');
  await shot('dash-3-custom-range');
}
await embed('tag=api&range=2w');
await expectTiles(DT, { tag: 'api', from: from2w }, allBoards, 'embed tag api + 2w');

// ================= HOME =================
const H = '#home-filters';
const W = (t) => `.dw-widget[data-widget-type="${t}"]`;
const HT = `${W('workspace-boards')} .dash-tile`;
const hsel = (label) => `${H} label.mx-field:has(> span:text-is("${label}")) select`;
// /home for the current filters landed, the widgets painted (no skeletons), the reads done
async function settledHome() {
  await page.waitForFunction(
    () => typeof hctx !== 'undefined' && hctx.meta && home.data && home.key === fbParams(hctx, true, false) && document.querySelector('.dw-widget') && !document.querySelector('.dw-skel') && !document.querySelector(`${'#home-filters'} .fb-bar .mx-dim`),
    null,
    { timeout: 15000 },
  );
  await quiet();
}
const homeAll = await api(`/home?project=${seed.ws}`);
// what the live widgets show: Now building (hero + rows), Up next, the agent rows, the board tiles
const liveSnap = async () => ({
  now: await texts(`${W('now-building')} :is(.wnb-title, .wnb-row-title)`),
  up: await texts(`${W('up-next')} .home-uptitle`),
  agents: await texts(`${W('active-agents')} .aa-row .aa-name`),
  tiles: await tileCounts(HT),
});
const prefixOf = (shown, all) => shown.length > 0 && JSON.stringify(shown) === JSON.stringify(all.slice(0, shown.length));
// expand the chip's bar unless it's open already (a Clear leaves it open; the chip toggles)
async function openBar() {
  if (!(await page.$(`${H} .fb-bar`))) await page.click(`${H} .fb-chip`);
  await page.waitForSelector(`${H} .fb-bar`);
}
const chipText = () => page.$eval(`${H} .fb-chip`, (e) => e.textContent);
const chipV = async () => (await page.$(`${H} .fb-chip-v`)) && page.$eval(`${H} .fb-chip-v`, (e) => e.textContent);
// the chip names the range and counts the other filters; its tooltip names them all
const chipTitle = () => page.$eval(`${H} .fb-chip`, (e) => e.title);

// ---- a fresh Home: 4 weeks, unfiltered ----
let homeReqs = reqWatch();
await page.goto(`${base}/?project=${seed.ws}&view=dashboard`); // the old Dashboard link lands on Home
await settledHome();
homeReqs.stop();
const kd0 = await docKeydownListeners();
{
  ok(param('view') === 'home' || param('view') === 'dashboard', 'view=dashboard (not embedded) opens Home', page.url());
  ok(!(await page.$('#home-view.hidden')) && (await page.$eval('#rail-home', (e) => e.classList.contains('active'))), 'Home is the active view');
  const s = await liveSnap();
  ok(prefixOf(s.now, homeAll.now_building.map((x) => x.title)), 'Home unfiltered: Now building = /home', { got: s.now });
  ok(prefixOf(s.up, homeAll.up_next.items.map((x) => x.title)), 'Home unfiltered: Up next = /home', { got: s.up });
  await expectTiles(HT, {}, allBoards, 'Home unfiltered: board tiles');
  ok((await page.evaluate(() => hctx.f.range)) === '4w', 'fresh Home: range is 4 weeks');
  ok(!keysIn().length, 'fresh Home: the default 4w writes no range key to the URL', page.url());
  ok((await chipText()) === 'Filterslast 4 weeks▾' && !(await page.$(`${H} .fb-clear`)), 'fresh Home: the chip names the range ("last 4 weeks"), no Clear', await chipText());
  ok(!(await page.$(`${H} .fb-chip.on`)), 'fresh Home: chip not marked filtered');
  // the range reaches the range-aware reads: the KPI budget's /metrics/cost and (below) the agent history
  const cost = homeReqs.filter((u) => new URL(u).pathname === '/metrics/cost').map((u) => new URL(u).searchParams.get('from'));
  ok(cost.length > 0 && cost.every((f) => Number(f) === from4w), 'KPI read (/metrics/cost) carries the 4w from', { cost, from4w });
  const live = homeReqs.filter((u) => ['/home', '/workspace/summary'].includes(new URL(u).pathname));
  ok(live.length > 0 && live.every((u) => !/[?&](from|to|range)=/.test(u)), 'live reads (/home, /workspace/summary) carry no range', live);
  await shot('home-1-fresh');
}
// expand: fields + the shared range control
await openBar();
await page.waitForSelector(`${H} .fb-bar`);
ok((await texts(`${H} .fb-bar label.mx-field > span`)).join('|') === 'Scope|Phase|Tag|Agent|Type', 'Home bar: Scope, Phase, Tag, Agent, Type', await texts(`${H} .fb-bar label.mx-field > span`));
{
  const seg = await page.$$eval(`${H} .fb-bar .mx-seg-btn`, (bs) => bs.map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')));
  ok(seg.join('|') === '2w|4w*|8w|All', 'Home bar: the shared Range control, 4w pressed, All time available', seg);
  ok(!!(await page.$(`${H} .fb-bar .mx-range .mx-chip`)) && !(await page.$(`${H} .fb-bar .mx-tz`)), 'Home bar: custom range chip, no time zone');
}

// ---- the agent panel's history carries the range ----
{
  const reqs = reqWatch();
  await page.click(`${W('active-agents')} .aa-row`);
  await page.waitForSelector('.aa-delta');
  await quiet();
  reqs.stop();
  const hist = reqs.filter((u) => /\/agents\/[^/]+\/history/.test(new URL(u).pathname)).map((u) => new URL(u).searchParams);
  ok(hist.length === 1 && Number(hist[0].get('from')) === from4w && hist[0].get('compare') === 'previous', 'agent history read carries the 4w from (compare=previous)', hist.map((q) => q.toString()));
  ok(!!(await page.$('.aa-delta:is(.aa-d-good, .aa-d-bad)')), 'agent panel at 4w: coloured deltas');
  ok((await texts('.aa-delta .aa-d-vs')).some((t) => /^vs prev \d+ d$/.test(t)), 'agent panel: "vs prev N d"', await texts('.aa-delta .aa-d-vs'));
  await shot('home-2-agent-panel-4w');
}

// the agent panel is modal (its backdrop takes the clicks): the range buttons are pressed directly,
// as if the range changed under the open panel
const pickRange = (id) => page.$eval(`${H} .mx-seg-btn[data-fb="range-${id}"]`, (b) => b.click());
// ---- range All: live widgets unchanged, no live refetch, range-aware reads re-read ----
{
  const before = await liveSnap();
  const reqs = reqWatch();
  await pickRange('all');
  const skel = await page.evaluate(() => [...document.querySelectorAll('.dw-widget .dw-skel')].map((e) => e.closest('.dw-widget').dataset.widgetType).concat(document.querySelector('#home-sub').textContent === 'Loading…' ? ['home-sub'] : []));
  await page.waitForFunction(() => [...document.querySelectorAll('.aa-delta')].every((c) => c.textContent === 'No previous period'), null, { timeout: 10000 });
  await quiet();
  reqs.stop();
  ok(!skel.length, 'range change: no skeleton / "Loading…" flash', skel);
  ok(!paths(reqs).some((p) => LIVE_READS.includes(p)), 'range change: no /home, /workspace/summary or /workspace/cards refetch', paths(reqs));
  const hist = reqs.filter((u) => /\/history$/.test(new URL(u).pathname)).map((u) => new URL(u).searchParams);
  ok(hist.length === 1 && !hist[0].has('from') && !hist[0].has('to'), 'All: the agent history re-read without from / to', hist.map((q) => q.toString()));
  const cost = reqs.filter((u) => new URL(u).pathname === '/metrics/cost').map((u) => new URL(u).searchParams);
  ok(cost.length > 0 && cost.every((q) => !q.has('from')), 'All: the KPI read re-read without from', cost.map((q) => q.toString()));
  const after = await liveSnap();
  ok(JSON.stringify(after) === JSON.stringify(before), 'All: now-building, up-next, agent rows and board tiles unchanged', { before, after });
  ok((await texts('.aa-delta')).every((t) => t === 'No previous period') && !(await page.$('.aa-delta:is(.aa-d-good, .aa-d-bad)')), 'All: the agent panel deltas grey ("No previous period")');
  ok(param('range') === 'all' && keysIn().join() === 'range', 'All: range=all in the URL', page.url());
  ok((await chipV()) === 'all time' && !!(await page.$(`${H} .fb-chip.on`)), 'All: chip reads "all time"', await chipV());
  await shot('home-3-all-time');
  // 2w: the live widgets still unchanged
  await pickRange('2w');
  await page.waitForFunction(() => [...document.querySelectorAll('.aa-delta .aa-d-vs')].some((e) => /vs prev/.test(e.textContent)), null, { timeout: 10000 });
  await quiet();
  ok(JSON.stringify(await liveSnap()) === JSON.stringify(before), '2w: live widgets unchanged', await liveSnap());
  await pickRange('all');
  await quiet();
  await page.click('.aa-p-close');
}
// range=all round-trips through the URL
{
  const before = page.url();
  await page.reload();
  await settledHome();
  ok(page.url() === before && (await page.evaluate(() => hctx.f.range)) === 'all', 'reload: range=all comes back from the URL', page.url());
  ok((await chipV()) === 'all time', 'reload: chip reads "all time"');
  await openBar();
  const pressed = await page.$$eval(`${H} .fb-bar .mx-seg-btn[aria-pressed="true"]`, (bs) => bs.map((b) => b.textContent));
  ok(pressed.join() === 'All', 'reload: All pressed', pressed);
  // Clear → 4w with a clean URL
  await page.click(`${H} .fb-clear`);
  await quiet();
  ok((await page.evaluate(() => hctx.f.range)) === '4w' && !keysIn().length && param('view') === 'home', 'Clear: back to 4w, URL clean', page.url());
  ok((await chipText()).startsWith('Filters') && (await chipV()) === 'last 4 weeks' && !(await page.$(`${H} .fb-clear`)), 'Clear: chip back to "Filters · last 4 weeks"', await chipV());
}
// a range-only widget override shares Home's (range-free) live read; another filter doesn't
{
  const r = await page.evaluate(async () => {
    const probe = async (vars) => {
      const inst = dwWidget({ id: `probe-${Math.random()}`, type: 'now-building', size: 'M', params: { vars } });
      inst.ctx._cache = dw.cache;
      const got = await inst.ctx.shared('home', async () => 'fetched');
      return got === 'fetched' ? 'own' : 'shared';
    };
    const out = { range: await probe({ range: 'all' }), tag: await probe({ tag: 'ui' }) };
    dwPrune();
    // the override still wins for range-aware reads
    out.filters = dwFilters({ params: { vars: { range: 'all' } } });
    out.home = fbParams(hctx);
    return out;
  });
  ok(r.range === 'shared' && r.tag === 'own', "range-only override reuses Home's /home entry; a tag override reads its own", r);
  ok(r.filters === '' && /from=/.test(r.home), "a widget's range override still wins over Home's range", r);
}

// ---- Home filters: tag / agent / phase / scope over the board tiles + live widgets ----
await openBar();
await page.selectOption(hsel('Tag'), 'ui');
await settledHome();
await expectTiles(HT, { tag: 'ui' }, allBoards, 'Home tag ui');
ok(param('view') === 'home' && param('tag') === 'ui' && keysIn().join() === 'tag', 'tag ui: URL-backed (view=home&tag=ui)', page.url());
ok((await chipV()) === 'last 4 weeks · 1 filter' && (await chipTitle()) === 'last 4 weeks · ui' && !!(await page.$(`${H} .fb-clear`)), 'chip: "last 4 weeks · 1 filter" (tooltip names "ui"), Clear shown', [await chipV(), await chipTitle()]);
{
  const inflight = (await texts(`${HT} .dt-card-title`)).sort();
  const wantIn = cards.filter((c) => ['in_progress', 'in_review'].includes(c.lane) && c.tag === 'ui').map((c) => c.title);
  ok(inflight.every((t) => wantIn.includes(t)), 'tag ui: in-flight cards on tiles filtered', { inflight, wantIn });
  await shot('home-4-tag-ui');
}
await page.selectOption(hsel('Agent'), 'Ada');
await settledHome();
await expectTiles(HT, { tag: 'ui', agent: 'Ada' }, allBoards, 'Home tag ui + agent Ada');
ok((await chipV()) === 'last 4 weeks · 2 filters' && (await chipTitle()) === 'last 4 weeks · ui · Ada', 'chip: "last 4 weeks · 2 filters" (tooltip: ui · Ada)', [await chipV(), await chipTitle()]);
await page.selectOption(hsel('Tag'), '');
await page.selectOption(hsel('Agent'), '');
await page.selectOption(hsel('Phase'), seed.phases.webCheckout);
await settledHome();
await expectTiles(HT, { phase: seed.phases.webCheckout }, [seed.web], 'Home phase Web checkout → web tile only');
ok(param('phase') === seed.phases.webCheckout, 'phase in the URL');
// scope api: cross-check with the server's own /home for the api vertical (phase dropped: not on api)
await page.selectOption(hsel('Scope'), seed.api);
await settledHome();
{
  await expectTiles(HT, { scope: seed.api }, [seed.api], 'Home scope api → api tile only');
  ok(param('scope') === seed.api && !param('phase'), "scope in the URL; the other board's phase dropped", page.url());
  const homeApi = await api(`/home?project=${seed.api}`);
  const s = await liveSnap();
  ok(prefixOf(s.now, homeApi.now_building.map((x) => x.title)), "scope api: Now building = the server's api Home", { got: s.now, want: homeApi.now_building.map((x) => x.title) });
  ok(prefixOf(s.up, homeApi.up_next.items.map((x) => x.title)), "scope api: Up next = the server's api Home (same pick order)", { got: s.up, want: homeApi.up_next.items.map((x) => x.title) });
  ok((await page.$eval(`${W('up-next')} .home-link`, (e) => e.textContent)) === `View all ${homeApi.up_next.total_pending} in Kanban →`, "scope api: total pending = the server's", homeApi.up_next.total_pending);
  ok((await chipV()) === 'last 4 weeks · 1 filter' && (await chipTitle()) === 'last 4 weeks · api', 'chip: 1 filter (tooltip: api)', [await chipV(), await chipTitle()]);
  await shot('home-5-scope-api');
}
// tag db within api: queued db cards first, then the backlog (the waiter waits on an in-progress card)
await page.selectOption(hsel('Tag'), 'db');
await settledHome();
{
  const f = { scope: seed.api, tag: 'db' };
  const q = cards.filter((c) => c.board === seed.api && c.lane === 'queued' && match(f, c)).map((c) => c.title);
  const bl = cards.filter((c) => c.board === seed.api && c.lane === 'backlog' && c.phase_id === seed.phases.apiV1 && match(f, c)).map((c) => c.title);
  const want = [...q, ...bl];
  const up = await texts(`${W('up-next')} .home-uptitle`);
  ok(prefixOf(up, want), 'scope api + tag db: Up next', { up, want });
  const homeDb = await api(`/home?project=${seed.ws}&scope=${seed.api}&tag=db`);
  const w = homeDb.up_next.items.find((x) => x.id === (waiter.task_id ?? waiter.id));
  ok(!!w && !w.ready && w.waiting_on.some((x) => x.title === blocker.title), "the waiter is Up next's, waiting on the in-progress card", { w, items: homeDb.up_next.items.map((x) => [x.title, x.ready]), total: homeDb.up_next.total_pending, waiter });
  const nb = cards.filter((c) => ['in_progress', 'in_review'].includes(c.lane) && match(f, c)).map((c) => c.title).sort();
  const s = await liveSnap();
  ok(s.now.every((t) => nb.includes(t)) && (nb.length === 0) === (s.now.length === 0), 'scope api + tag db: Now building', { got: s.now, nb });
  ok((await chipV()) === 'last 4 weeks · 2 filters' && (await chipTitle()) === 'last 4 weeks · api · db', 'Home chip: 2 filters (tooltip: api · db)', [await chipV(), await chipTitle()]);
}
// agent filter: just them
await page.selectOption(hsel('Tag'), '');
await page.selectOption(hsel('Scope'), seed.ws);
await page.selectOption(hsel('Agent'), 'Knwar');
await settledHome();
{
  const want = homeAll.now_building.filter((x) => x.agent === 'Knwar').map((x) => x.title);
  const s = await liveSnap();
  ok(prefixOf(s.now, want), 'agent Knwar: Now building', { got: s.now, want });
  ok(JSON.stringify(s.agents) === JSON.stringify(['Knwar']), 'agent Knwar: agent rows = Knwar', s.agents);
  ok(s.up.every((t) => cards.find((c) => c.title === t)?.agent === 'Knwar'), "agent Knwar: Up next only Knwar's", s.up);
  const before = page.url();
  await page.reload();
  await settledHome();
  ok(page.url() === before && JSON.stringify(await texts(`${W('active-agents')} .aa-row .aa-name`)) === JSON.stringify(['Knwar']), 'Home reload keeps the filters', { before, after: page.url() });
  // drill: Now building's "+N more" → the cards in flight
  if (await page.$(`${W('now-building')} .wnb-more`)) {
    await page.click(`${W('now-building')} .wnb-more`);
    await page.waitForSelector('#home-view .mx-drill');
    const rows = await texts('.mx-drill-row .mx-drill-title');
    ok(JSON.stringify(rows.sort()) === JSON.stringify([...want].sort()), 'Now building "+N more" → drill of those cards', { rows, want });
    const metas = await texts('.mx-drill-row .mx-drill-meta');
    ok(metas.every((m) => m.includes('Knwar') && /In Progress|In Review/.test(m)), 'rows carry board · agent · lane', metas);
    ok((await page.$eval('.mx-drill-foot .mx-btn.primary', (e) => e.textContent)) === `Open all ${want.length} in Kanban`, '"Open all N in Kanban"');
    await shot('home-6-drill-now');
    await page.keyboard.press('Escape');
    ok(!(await page.$('.mx-drill')), 'Esc closes the drill');
  } else ok(JSON.stringify((await liveSnap()).now) === JSON.stringify(want), 'agent Knwar: everything in flight shown (no "+N more")', want);
}
// Clear, leave
await page.click(`${H} .fb-clear`);
await settledHome();
ok(!keysIn().length && prefixOf((await liveSnap()).now, homeAll.now_building.map((x) => x.title)), 'Home Clear: URL clean, back to /home', page.url());
{
  // unfiltered: Now building's "+N more" → a drill of every card in flight
  const want = homeAll.now_building.map((x) => x.title);
  await page.click(`${W('now-building')} .wnb-more`);
  await page.waitForSelector('#home-view .mx-drill');
  const rows = await texts('.mx-drill-row .mx-drill-title');
  ok(JSON.stringify(rows.sort()) === JSON.stringify([...want].sort()), 'Now building "+N more" → drill of every card in flight', { rows, want });
  ok(rows.length === want.length && (await page.$eval('#mx-drill-title', (e) => e.textContent)) === `${want.length} cards in flight`, 'drill title: N cards in flight');
  await shot('home-6b-drill-now-all');
  await page.click('.mx-drill-close');
}
await openBar();
await page.selectOption(hsel('Tag'), 'ui');
await settledHome();
await page.click(`${W('now-building')} .wnb-more`).catch(() => {});
await page.click('#rail-kanban');
ok(!(await page.$('.mx-drill')), 'switching views closes an open drill');
ok(!keysIn().length && param('view') !== 'home', 'leaving Home clears its filters from the URL', page.url());
await page.click('#rail-home');
await settledHome();
ok((await chipV()) === 'last 4 weeks' && (await page.evaluate(() => hctx.f.range)) === '4w', 'back on Home: no filters, 4w', await chipV());
// Metrics starts clean after Home had filters
await openBar();
await page.selectOption(hsel('Tag'), 'ui');
await settledHome();
await page.click('#rail-metrics');
await page.waitForTimeout(500);
ok(param('view') === 'metrics' && !param('tag'), "Home → Metrics: Home's tag does not leak into Metrics", page.url());
await page.click('#rail-home');
await settledHome();
ok(!param('tag') && (await chipV()) === 'last 4 weeks', 'Metrics → Home: clean', await chipV());
const kd1 = await docKeydownListeners();
ok(kd1 === kd0, 'no keydown listeners leaked (panels / drills opened and closed, views switched)', { kd0, kd1 });

// ---- Home on a vertical: scope locked, no Scope field ----
await page.goto(`${base}/?project=${seed.web}&view=home`);
await settledHome();
await openBar();
ok((await texts(`${H} .fb-bar label.mx-field > span`)).join('|') === 'Phase|Tag|Agent|Type', 'Home on a vertical: no Scope field');
await page.selectOption(hsel('Agent'), 'Inder');
await settledHome();
{
  const homeWeb = await api(`/home?project=${seed.web}`);
  const want = homeWeb.now_building.filter((x) => x.agent === 'Inder').map((x) => x.title);
  const now = (await liveSnap()).now;
  ok(want.length ? prefixOf(now, want) : now.length === 0, 'vertical Home + agent: Now building', { now, want });
  ok(keysIn().join() === 'agent', 'vertical Home: the locked scope stays out of the URL', page.url());
  ok((await chipV()) === 'last 4 weeks · 1 filter' && (await chipTitle()) === 'last 4 weeks · Inder', 'chip: 1 filter (tooltip: Inder)', [await chipV(), await chipTitle()]);
  await shot('home-7-vertical');
}

// ================= live refetches never touch the filter controls =================
const moveCard = async (board, from, to) => {
  const c = (await api(`/board?project=${board}`)).find((x) => x.lane === from);
  await post(`/task/${c.id}/move`, { lane: to });
  return c;
};
// Home's data reads by path: the filters' per-board fan-out (/board, /phases, /task/<id>) must be gone
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
await page.goto(`${base}/?project=${seed.ws}&view=home&tag=api`);
await settledHome();
await openBar();
await page.waitForSelector(`${H} .fb-bar select[data-fb="agent"]`);
await page.focus(`${H} select[data-fb="agent"]`);
await page.evaluate(() => (document.activeElement.__mark = 'agent'));
{
  // tile counts are under tag=api: move an api-tagged backlog card so they visibly move
  const t0 = JSON.stringify(await tileCounts(HT));
  const mv = (await api(`/board?project=${seed.api}`)).find((x) => x.lane === 'backlog' && x.tag === 'api') ?? (await api(`/board?project=${seed.api}`)).find((x) => x.lane === 'backlog');
  reqLog.length = 0;
  await post(`/task/${mv.id}/move`, { lane: 'queued' });
  await page.waitForFunction((v) => JSON.stringify(Object.fromEntries([...document.querySelectorAll('.dw-widget[data-widget-type="workspace-boards"] .dash-tile')].map((t) => [t.dataset.id, t.querySelector('.dt-lanes').textContent]))) !== v, JSON.stringify(Object.fromEntries((await page.$$eval(HT, (ts) => ts.map((t) => [t.dataset.id, t.querySelector('.dt-lanes').textContent]))))), { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const t1 = JSON.stringify(await tileCounts(HT));
  ok(t1 !== t0, 'Home: the refetch did happen (tile lane counts moved)', { t0, t1, tag: mv.tag });
  const s = await page.evaluate(() => ({ mark: document.activeElement.__mark, fb: document.activeElement.dataset?.fb }));
  ok(s.mark === 'agent', 'Home: a refetch keeps the focused Agent select', s);
  console.log(`     Home refetch while filtered: ${reqLog.length} requests (${reqLog.join(', ')})`);
  ok(reqLog.filter((u) => u === '/home').length === 1 && reqLog.filter((u) => u === '/workspace/cards').length <= 1 && reqLog.filter((u) => u === '/workspace/summary').length <= 1, 'Home: one /home (+ ≤ 1 cards, ≤ 1 board summary) per refetch while filtered', reqLog);
  // (one /phases read is the KPI budget's active-phase lookup for this board, not a fan-out)
  ok(!reqLog.some((u) => /^\/(board|task\/)/.test(u)) && reqLog.filter((u) => u === '/phases').length <= 1, 'Home: no per-board fan-out (no /board or Up-next /task reads; ≤ 1 /phases)', reqLog);
}
// custom range popover: a half-typed range survives a refetch
await page.click(`${H} .mx-range .mx-chip`);
await page.fill(`${H} input[data-fb="from"]`, '2026-01-05');
await page.focus(`${H} input[data-fb="to"]`);
await page.evaluate(() => (document.activeElement.__mark = 'to'));
await moveCard(seed.ws, 'backlog', 'queued');
await page.waitForTimeout(2500);
{
  const s = await page.evaluate(() => ({ mark: document.activeElement.__mark, from: document.querySelector('#home-filters input[data-fb="from"]')?.value, pop: !!document.querySelector('#home-filters .mx-pop') }));
  ok(s.mark === 'to' && s.from === '2026-01-05' && s.pop, 'Home: the custom-range popover, its typed From and the focused To survive a refetch', s);
}
await page.keyboard.press('Escape');

// ---- keyboard: the chip and Clear keep focus; aria ----
await page.goto(`${base}/?project=${seed.ws}&view=home&tag=ui`);
await settledHome();
await page.focus(`${H} .fb-chip`);
await page.keyboard.press('Enter');
await page.waitForSelector('#home-fb-bar');
ok((await page.evaluate(() => document.activeElement.dataset.fb)) === 'chip', 'Enter on the chip expands the bar, focus stays on the chip');
ok((await page.$eval(`${H} .fb-chip`, (e) => [e.getAttribute('aria-controls'), e.getAttribute('aria-expanded'), e.querySelector('.fb-caret').getAttribute('aria-hidden')].join())) === 'home-fb-bar,true,true', 'chip: aria-controls the bar, aria-expanded, caret aria-hidden');
await page.keyboard.press('Enter');
ok(!(await page.$('#home-fb-bar')) && (await page.evaluate(() => document.activeElement.dataset.fb)) === 'chip', 'Enter again collapses it, focus stays');
await page.focus(`${H} .fb-clear`);
await page.keyboard.press('Enter');
await settledHome();
ok((await page.evaluate(() => document.activeElement.dataset.fb)) === 'chip' && !param('tag'), 'Clear by keyboard: filters gone, focus on the chip');
await openBar();
await page.focus(hsel('Tag'));
await page.selectOption(hsel('Tag'), 'db');
ok((await page.evaluate(() => document.activeElement.dataset.fb)) === 'tag', 'choosing a Tag keeps focus on the Tag select');

// ---- one load per open ----
{
  // a fresh tab: meta loads (one /workspace/cards read each) never outnumber /home loads
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const reqs = [];
  tab.on('request', (r) => reqs.push(r.url()));
  await tab.goto(`${base}/?project=${seed.ws}&view=home&tag=ui`);
  await tab.waitForFunction(() => hctx.meta && home.data && document.querySelector('.dw-widget'), null, { timeout: 15000 });
  await tab.waitForTimeout(1500);
  const metaLoads = reqs.filter((u) => u.includes('/workspace/cards?')).length;
  const homes = reqs.filter((u) => new URL(u).pathname === '/home').length;
  ok(metaLoads >= 1 && metaLoads <= homes, 'Home open with filters: no double load (meta loads ≤ /home loads)', { metaLoads, homes });
  // /phases?project=<this board> is the KPI budget's active-phase lookup; the fan-out would hit the verticals
  const fan = reqs.filter((u) => /\/board\?project=/.test(u) || (/\/phases\?project=/.test(u) && new URL(u).searchParams.get('project') !== seed.ws));
  ok(!fan.length, "Home open with filters: no per-board /board or other boards' /phases reads", fan);
  await tab.close();
}

// ---- a slow /home: a filter change re-reads it, a range change doesn't ----
const slow = async (r) => {
  await new Promise((res) => setTimeout(res, 2500));
  await r.continue().catch(() => {});
};
await page.goto(`${base}/?project=${seed.ws}&view=home&tag=ui`);
await settledHome();
await page.route('**/home?*', slow);
{
  const reqs = reqWatch();
  await openBar();
  await page.click(`${H} .mx-seg-btn:text-is("8w")`);
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => ({ skel: !!document.querySelector('.dw-skel'), sub: document.querySelector('#home-sub').textContent }));
  ok(!s.skel && s.sub !== 'Loading…' && !paths(reqs).includes('/home'), 'range change: no /home read, no "Loading…" or skeletons', { ...s, reqs: paths(reqs) });
  await page.selectOption(hsel('Tag'), 'db');
  await page.waitForTimeout(300);
  ok(paths(reqs).includes('/home'), 'tag change: /home re-read', paths(reqs));
  reqs.stop();
}
await quiet();
await page.unroute('**/home?*', slow);

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
  await page.goto(`${base}/?project=${seed.ws}&view=home`);
  await page.waitForSelector(`${H} .fb-chip`);
  await openBar();
  await page.waitForSelector(`${H} .fb-bar .mx-dim`);
  await page.focus(`${H} .mx-seg-btn[data-fb="range-2w"]`);
  release();
  await page.waitForFunction(() => hctx.meta, null, { timeout: 10000 });
  await page.waitForTimeout(200);
  ok(!!(await page.$(`${H} .fb-bar .mx-dim`)), 'options landed while focus was in the bar: its redraw waits');
  await page.click('#home-name'); // focus leaves the bar
  await page.waitForTimeout(200);
  ok((await texts(`${H} .fb-bar label.mx-field > span`)).join('|') === 'Scope|Phase|Tag|Agent|Type', 'focus left the bar: the deferred redraw ran (selects shown)', { fields: await texts(`${H} .fb-bar label.mx-field > span`), bar: await page.$eval(`${H}`, (e) => e.textContent.slice(0, 120)), active: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)) });
  await page.unroute('**/workspace/cards?*', held);
}

// ---- a relative range crossing midnight: an idle OBS embed never drops to "Loading…" ----
// (the data's key is the range as chosen, not its epoch ms: those move when the day rolls over)
{
  const at = (() => {
    const d = new Date();
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    d.setHours(23, 59, 0, 0);
    return d;
  })();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await tab.clock.install({ time: at });
  await tab.goto(embedUrl('range=2w'));
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
  ok(!attn.includes('Loading') && !grid.startsWith('Loading') && tiles === 4 && day !== at.getDate(), 'midnight (2w across Sunday → Monday, embed): tiles + Needs you stay, no "Loading…"', { attn: attn.slice(0, 40), grid: grid.slice(0, 40), tiles, day });
  await tab.close();
}

ok(errors.length === 0, 'no page errors', errors);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
