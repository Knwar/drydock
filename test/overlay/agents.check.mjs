// Headless checks of agent state on Home (card cf569c28): Now building and Active agents derive it the
// same way (dwAgentState), the Type filter never idles a busy agent, and Active agents' "Open in Kanban"
// labels its highlight (same board: setKanbanHighlight; another board: ?cards=…&from=…).
// Self-contained: starts its own daemon on a scratch DB + port (a fake `claude` first on PATH, terminals
// off), seeds a workspace over HTTP, drives Chrome, then kills the daemon and removes the scratch dir.
// Not part of `npm test` (needs Chrome + playwright-core). Run from the repo root:
//
//   node test/overlay/agents.check.mjs
//
// Env: PORT (default 7971; never 7890), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else the npx cache).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7971);
if (PORT === 7890) throw new Error('refusing port 7890 (the live daemon)');
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

  // ---- seed: workspace "shop" + vertical "web"; Ada on a feature (and a done defect), Bob on a defect, Cy free ----
  mkdirSync(join(S, 'shop/apps/web'), { recursive: true });
  const ws = (await j('GET', `/project?root=${encodeURIComponent(join(S, 'shop'))}&name=shop`)).project_id;
  const web = (await j('POST', '/vertical', { workspace_id: ws, name: 'web', root: join(S, 'shop/apps/web') })).project_id;
  for (const name of ['Ada', 'Bob', 'Cy']) await j('POST', '/team', { name, skill: 'frontend-dev' });
  const card = async (title, work_type, agent) => {
    const id = (await j('POST', '/task', { project_id: web, title, work_type })).task_id;
    await j('PATCH', `/task/${id}`, { assigned_agent: agent, worktree_path: `.trees/${id}`, branch: `card/${id}` });
    return id;
  };
  const a1 = await card('Ada feature', 'feature', 'Ada');
  const a2 = await card('Ada old defect', 'defect', 'Ada');
  await j('POST', `/task/${a2}/move`, { lane: 'done' });
  await card('Bob defect', 'defect', 'Bob');
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
  // a reviewer subagent on Ada's card: both widgets read Reviewing (the same reviewer signal)
  await status('Read', 'x.js', 'reviewer');
  h = await heroAfter('Reviewing · Read x.js');
  await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((r) => r.textContent.includes('Ada') && r.textContent.includes('Reviewing')), `${W('active-agents')} .aa-row`, { timeout: 5000 }).catch(() => {});
  rows = await rowsOf();
  ok(h.text === 'Reviewing · Read x.js' && h.on && rows.Ada?.pill === 'Reviewing', 'a reviewer subagent: Now building and Active agents both read Reviewing', { h, ada: rows.Ada });
  await status('finished', '', 'reviewer');
  h = await heroAfter('Working · waiting for next action');
  rows = await rowsOf();
  ok(h.text === 'Working · waiting for next action' && rows.Ada?.pill === 'Working', 'the reviewer finished: both back to Working', { h, ada: rows.Ada });

  // ---- 2. the Type filter doesn't idle busy agents ----
  await page.goto(`${base}/?project=${web}&view=home&workType=defect`);
  await page.waitForSelector(`${W('active-agents')} .aa-row`, { timeout: 15000 });
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 3, `${W('active-agents')} .aa-row`, { timeout: 10000 }).catch(() => {});
  rows = await rowsOf();
  ok(rows.Ada?.pill === 'Working' && rows.Ada.line === 'Working on other types', 'Type = Defect: Ada (on a feature) stays Working, "Working on other types"', rows.Ada);
  ok(rows.Bob?.pill === 'Working' && rows.Bob.line.startsWith('Bob defect'), 'Type = Defect: Bob shows his defect card', rows.Bob);
  ok(rows.Cy?.pill === 'Idle', 'Type = Defect: Cy (no cards) stays listed, Idle', rows.Cy);
  const sum = await summary();
  ok(sum.text.replace(/\s+/g, ' ').includes('2 active') && sum.text.includes('1 idle'), 'Type = Defect: the summary counts every agent ("2 active · … · 1 idle")', sum.text);
  ok(/Type filter/.test(sum.title), 'the summary tooltip says the counts ignore the Type filter', sum.title);

  // ---- 3. Open in Kanban labels its highlight ----
  const openKanban = async () => {
    await page.click(`${W('active-agents')} .aa-row[data-agent] >> text=Ada`);
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
  // another board: Home on the workspace, Ada's cards are on web → ?project=web&cards=…&from=…
  await page.goto(`${base}/?project=${ws}&view=home`);
  await page.waitForSelector(`${W('active-agents')} .aa-row`, { timeout: 15000 });
  const cross = await openKanban().catch((e) => `error: ${e.message}`);
  const u = new URL(page.url());
  ok(/^\d+ cards? highlighted from Active agents$/.test(cross) && u.searchParams.get('project') === web, 'cross board: lands on web, banner "… highlighted from Active agents"', { cross, url: page.url() });

  ok(errors.length === 0, 'no page errors', errors);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
