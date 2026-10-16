// Headless checks of the Phase E widgets' delta chips + range flags (card e53db713): a quality chip
// whose previous period predates the board's first activity is grey ("No full previous period"), a
// custom range's chip names the previous period's dates, speed-stability gives no verdict from a
// pre-history period, cycle-breakdown's stage chips go a muted "—", and an unranged widget (wip) hides Range in
// its config drawer. Self-contained: starts its own daemon on a scratch DB + port, seeds ~8 weeks of
// data (metrics-seed.mjs), drives Chrome, then kills the daemon and removes the DB.
// Not part of `npm test` (needs Chrome + playwright-core). Run from the repo root:
//
//   node test/overlay/deltas.check.mjs
//
// Env: PORT (default 7969; never 7890 or 7900), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else
// the npx cache: `npx playwright-core --version` fills it), OUT (screenshot dir; none by default).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7969);
if (PORT === 7890 || PORT === 7900) throw new Error('refusing a live daemon port (7890 kankanban, 7900 AI Brain)');
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
const S = mkdtempSync(join(tmpdir(), 'kankan-deltas-'));
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
  const pad = (n) => String(n).padStart(2, '0');
  const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return localDay(d);
  };

  // the layout under test: two quality widgets (Home's range; a custom 14-day override) and wip
  const w = (id, type, size, params = {}) => ({ id, type, size, params });
  const slot = (id, span, widget) => ({ id, span, widgets: [widget] });
  const layout = {
    version: 1,
    sections: [
      {
        id: 'sec1',
        title: 'Deltas',
        rows: [
          {
            id: 'row1',
            height: 4,
            slots: [
              slot('s1', 4, w('q-home', 'quality', 'M')),
              slot('s2', 4, w('q-custom', 'quality', 'M', { vars: { range: 'custom', from: daysAgo(13), to: daysAgo(0) } })),
              slot('s3', 4, w('wip', 'wip', 'M')),
            ],
          },
          {
            id: 'row2',
            height: 5,
            slots: [slot('s4', 6, w('ss', 'speed-stability', 'L')), slot('s5', 6, w('cb', 'cycle-breakdown', 'L'))],
          },
        ],
      },
    ],
  };
  const put = await fetch(`${base}/project/${seed.ws}/layout`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout }) });
  if (!put.ok) throw new Error(`layout PUT ${put.status} ${await put.text()}`);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
  const shot = (n) => (OUT ? page.screenshot({ path: `${OUT}/${n}.png` }) : null);
  const chips = (wid) => page.$$eval(`.dw-widget[data-widget-id="${wid}"] .dw-delta`, (els) => els.map((e) => ({ text: e.textContent, flat: e.classList.contains('dw-d-flat'), vs: e.querySelector('.dw-d-vs')?.textContent ?? null })));
  const waitChips = (wid) => page.waitForFunction((id) => document.querySelectorAll(`.dw-widget[data-widget-id="${id}"] .dw-delta`).length > 0, wid, { timeout: 15000 });

  // ---- 8 weeks: the previous 8 weeks start before the seeded history → pre-history, grey ----
  await page.goto(`${base}/?project=${seed.ws}&view=home&range=8w`);
  await waitChips('q-home');
  await shot('deltas-8w');
  const pre = await chips('q-home');
  ok(pre.length > 0 && pre.every((c) => c.flat && c.text === 'No full previous period' && c.vs === null), 'quality (8 weeks): pre-history chips are grey "No full previous period", no label', pre);

  // speed-stability: no "speed up / stability held" verdict from a partial previous period
  await waitChips('ss');
  const verdict = await page.$eval('.dw-widget[data-widget-id="ss"] .wq-status', (e) => ({ text: e.textContent, none: e.classList.contains('wq-none') }));
  ok(verdict.none && verdict.text.endsWith('No full previous period'), 'speed-stability (8 weeks): the verdict is grey "No full previous period"', verdict);

  // cycle-breakdown L: the stage chips are a short muted "—" (tooltip), the column head says why
  await waitChips('cb');
  const stage = await page.$$eval('.dw-widget[data-widget-id="cb"] .fw-legend-l .dw-delta', (els) => els.map((e) => ({ text: e.textContent, flat: e.classList.contains('dw-d-flat'), title: e.title })));
  const head = await page.$$eval('.dw-widget[data-widget-id="cb"] .fw-legend-l > .fw-k', (els) => els.map((e) => e.textContent));
  ok(stage.length === 3 && stage.every((c) => c.text === '—' && c.flat && c.title === 'No full previous period'), 'cycle-breakdown L (8 weeks): stage chips are a muted "—" titled "No full previous period"', stage);
  ok(head[3] === 'No full previous period', 'cycle-breakdown L (8 weeks): the stage delta column head reads "No full previous period"', head);

  // ---- custom range override: the short label names the previous period's dates ----
  await waitChips('q-custom');
  const custom = await chips('q-custom');
  const dated = /^vs [A-Z][a-z]{2} \d{1,2}( – (\d{1,2}|[A-Z][a-z]{2} \d{1,2}))?$/;
  ok(custom.length > 0 && custom.every((c) => c.vs !== null && dated.test(c.vs)), 'quality (custom 14 days): the chip label names the previous dates ("vs Sep 1 – 14")', custom);

  // ---- 2 weeks: a full previous period → a named label, first-pass in points (no %) ----
  await page.goto(`${base}/?project=${seed.ws}&view=home&range=2w`);
  await waitChips('q-home');
  const two = await chips('q-home');
  ok(two.length > 0 && two.every((c) => c.vs === 'vs previous 2 weeks'), 'quality (2 weeks): "vs previous 2 weeks"', two);
  ok(!two[0].text.includes('%'), 'quality: the first-pass chip is in points, never a %', two[0]);

  // ---- config drawer: wip (unranged) hides Range; quality (ranged) keeps it ----
  const field = (wid) =>
    page.evaluate((id) => {
      if (!deState.active) deEnter();
      decOpen(id);
      return !!document.querySelector('[data-dec-field="v-range"]');
    }, wid);
  ok((await field('q-home')) === true, 'config drawer: quality (ranged) shows Range');
  const wipRange = await field('wip');
  await shot('deltas-wip-drawer');
  ok(wipRange === false, 'config drawer: wip (unranged) hides Range');

  ok(errors.length === 0, 'no page errors', errors);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
