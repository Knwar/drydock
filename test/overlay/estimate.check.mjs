// Headless check of the card modal's "Est. human hours" field (card d2cdd2c2): Enter saves, an
// out-of-range value shows an inline error and saves nothing, clearing removes the estimate, and a
// live card update mid-typing keeps the draft and focus. Self-contained: starts its own daemon on a
// scratch DB + port (a fake `claude` first on PATH, terminal off), drives Chrome, then kills the
// daemon and removes the DB. Not part of `npm test` (needs Chrome + playwright-core). Run from the
// repo root:
//
//   node test/overlay/estimate.check.mjs
//
// Env: PORT (default 7989; never 7890), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else the
// npx cache: `npx playwright-core --version` fills it).
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7989);
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
const S = mkdtempSync(join(tmpdir(), 'kankan-estimate-'));
mkdirSync(join(S, 'data'));
mkdirSync(join(S, 'bin'));
mkdirSync(join(S, 'app'));
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
  const pid = (await j('GET', `/project?root=${encodeURIComponent(join(S, 'app'))}`)).project_id;
  const id = (await j('POST', '/task', { project_id: pid, title: 'Sized card', tag: 'api', work_type: 'feature' })).task_id;
  const estimate = async () => (await j('GET', `/task/${id}`)).estimate_hours;

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));

  await page.goto(`${base}/?project=${pid}&card=${id}`);
  await page.waitForFunction(() => !document.getElementById('card-modal').classList.contains('hidden'), null, { timeout: 15000 });
  await page.waitForSelector('#card-meta .cm-est-in', { timeout: 10000 });
  const input = '#card-meta .cm-est-in';
  const err = () => page.$eval('#card-meta .cm-est', (f) => f.parentElement.querySelector('.cm-wt-err').textContent);
  ok(
    (await page.$eval('#card-meta .cm-est .cm-wt-k', (e) => e.textContent)) === 'Est. human hours' &&
      (await page.$eval('#card-meta', (m) => [...m.children].findIndex((c) => c.querySelector('.cm-est')) === [...m.children].findIndex((c) => c.querySelector('.cm-wt-sel')) + 1)),
    'the field sits right after the work-type select',
  );

  // 1. 6 + Enter saves
  await page.fill(input, '6');
  await page.press(input, 'Enter');
  await page.waitForFunction(async (id) => (await (await fetch(`/task/${id}`)).json()).estimate_hours === 6, id, { timeout: 5000 }).catch(() => {});
  ok((await estimate()) === 6, 'Enter saves 6 (GET /task)', await estimate());
  await page.waitForFunction((sel) => document.querySelector(sel)?.value === '6', input, { timeout: 5000 }).catch(() => {});
  ok((await page.$eval(input, (e) => e.value)) === '6', 'the re-rendered field shows 6');

  // 2. 0 → inline error, nothing saved
  await page.fill(input, '0');
  await page.press(input, 'Enter');
  await page.waitForTimeout(400);
  ok(/> 0 and ≤ 1000/.test(await err()), 'an inline error for 0', await err());
  ok((await estimate()) === 6, 'nothing saved for 0', await estimate());

  // 3. clear → estimate removed
  await page.fill(input, '');
  await page.press(input, 'Enter');
  await page.waitForFunction(async (id) => (await (await fetch(`/task/${id}`)).json()).estimate_hours === null, id, { timeout: 5000 }).catch(() => {});
  ok((await estimate()) === null, 'clearing removes the estimate', await estimate());
  await page.waitForTimeout(300);
  ok((await err()) === '', 'the error is gone after a good save', await err());

  // 4. a live update mid-typing keeps the draft and the caret's focus. Titles aren't patchable, so
  //    the live update is a requirements patch: it broadcasts the card and re-renders the modal.
  await page.focus(input);
  await page.fill(input, '12.5');
  await page.evaluate(() => (window.__estMarker = document.querySelector('#card-meta .cm-est-in')));
  await j('PATCH', `/task/${id}`, { requirements: 'Live update while typing' });
  await page.waitForFunction(() => document.getElementById('card-desc').textContent.includes('Live update while typing'), null, { timeout: 5000 }).catch(() => {});
  const after = await page.evaluate(() => {
    const el = document.querySelector('#card-meta .cm-est-in');
    return { rerendered: el !== window.__estMarker, value: el.value, focused: document.activeElement === el };
  });
  ok(after.rerendered, 'the modal re-rendered on the live update', after);
  ok(after.value === '12.5' && after.focused, 'the draft and focus survive the live update', after);
  ok((await estimate()) === null, 'the draft is not saved by the re-render', await estimate());
  // and the draft still saves afterwards
  await page.press(input, 'Enter');
  await page.waitForFunction(async (id) => (await (await fetch(`/task/${id}`)).json()).estimate_hours === 12.5, id, { timeout: 5000 }).catch(() => {});
  ok((await estimate()) === 12.5, 'Enter then saves the kept draft', await estimate());

  ok(errors.length === 0, 'no page errors', errors);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
