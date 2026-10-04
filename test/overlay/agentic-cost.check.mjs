// Headless checks of the agentic cost widgets (rework-cost, decision-latency-cost, cost-anomaly, usage-runway;
// card 9089abb9): each renders at S / M / L with no NaN / undefined / null and the "Experimental" head note;
// rework's status follows its written thresholds and L lists the top cards; decision latency names an
// approximation when the API flags one and its queue opens the Needs-you drill; cost-anomaly's count, flagged
// sparkline dots, text list and L table match the API, and a board with < 5 days of spend says "Needs ≥ 5 days
// of history"; usage-runway shows "No usage samples yet" (with the reason) before any push and red with the
// gap in days when the weekly limit runs out before the p85 finish. Money uses one format per widget.
// Self-contained: starts its own daemon on a scratch DB + port, seeds ~8 weeks of data (metrics-seed.mjs)
// plus a steady daily spend with a spike yesterday and two days of spend on the young board, drives Chrome,
// then kills the daemon and removes the DB.
// Not part of `npm test` (needs Chrome + playwright-core). Run from the repo root:
//
//   node test/overlay/agentic-cost.check.mjs
//
// Env: PORT (default 7974; never 7890), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else
// the npx cache: `npx playwright-core --version` fills it), OUT (screenshot dir; none by default).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7974);
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

const TYPES = ['rework-cost', 'decision-latency-cost', 'cost-anomaly', 'usage-runway'];
const SIZES = ['S', 'M', 'L'];

// ---- scratch daemon ----
const base = `http://127.0.0.1:${PORT}`;
// the port must be free: never drive (or seed) a daemon this script didn't start
if (await fetch(base + '/').then(() => true, () => false)) throw new Error(`something already answers on ${PORT}: pick another PORT`);
const S = mkdtempSync(join(tmpdir(), 'kankan-agentic-cost-'));
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
  const ok = (cond, msg, extra) => {
    if (!cond) fails++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  };
  const SPAN = { S: 3, M: 6, L: 8 };
  const HEIGHT = { S: 3, M: 4, L: 5 };
  const putLayout = async (project, types = TYPES) => {
    const rows = types.flatMap((t) => SIZES.map((s) => ({ id: `r-${t}-${s}`, height: HEIGHT[s], slots: [{ id: `s-${t}-${s}`, span: SPAN[s], widgets: [{ id: `${t}-${s}`, type: t, size: s, params: {} }] }] })));
    const put = await fetch(`${base}/project/${project}/layout`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: { version: 1, sections: [{ id: 'sec1', title: 'Agentic cost', rows }] } }) });
    if (!put.ok) throw new Error(`layout PUT ${put.status} ${await put.text()}`);
    return types.length * SIZES.length;
  };

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
  // the widgets' own reads: the ranged one (compare=previous) and the live one (usage-runway)
  const reads = { ranged: null, live: null };
  page.on('response', async (r) => {
    if (!r.url().includes('/metrics/agentic-cost?') || !r.ok()) return;
    const body = await r.json().catch(() => null);
    reads[r.url().includes('compare=previous') ? 'ranged' : 'live'] = body;
  });
  const shot = async (n, types = TYPES) => {
    if (!OUT) return;
    for (const t of types)
      for (const s of SIZES) {
        const el = await page.$(`.dw-widget[data-widget-id="${t}-${s}"]`);
        await el.scrollIntoViewIfNeeded();
        await el.screenshot({ path: `${OUT}/${n}-${t}-${s}.png` });
      }
  };
  const settle = (n) =>
    page.waitForFunction(
      (k) => document.querySelectorAll('.dw-widget').length === k && !document.querySelector('.dw-widget.is-loading') && [...document.querySelectorAll('.dw-widget')].every((f) => f.querySelector('.dw-body').children.length),
      n,
      { timeout: 20000 },
    );
  const widgets = () =>
    page.$$eval('.dw-widget', (els) =>
      els.map((f) => {
        const body = f.querySelector('.dw-body');
        return {
          id: f.dataset.widgetId,
          state: ['error', 'empty', 'stale'].find((s) => f.classList.contains(`is-${s}`)) ?? null,
          text: body.innerText,
          exp: f.querySelector(':scope > .dw-head .ag-exp')?.textContent ?? null,
          status: [...body.querySelectorAll('.ac-status')].map((s) => ({ text: s.textContent, kind: ['ok', 'warn', 'bad', 'none'].find((k) => s.classList.contains(`ac-${k}`)), title: s.title })),
          chips: [...body.querySelectorAll('.dw-delta')].map((c) => ({ text: c.textContent, flat: c.classList.contains('dw-d-flat'), vs: c.querySelector('.dw-d-vs')?.textContent ?? null })),
          list: body.querySelectorAll('.ac-list li').length,
          flags: body.querySelectorAll('.ac-spark-flag').length,
          spark: !!body.querySelector('.ac-spark-svg'),
          sr: [...body.querySelectorAll('.ac-sr li')].map((li) => li.textContent),
          table: body.querySelectorAll('.ac-table tbody tr').length,
          approx: !!body.querySelector('.ac-approx'),
          limits: body.querySelectorAll('.ac-limit').length,
          notes: [...body.querySelectorAll('.ac-note')].map((n) => n.textContent),
          money: (body.innerText.match(/\$[\d,]+(?:\.\d+)?/g) ?? []).concat([...body.querySelectorAll('.ac-sr li')].flatMap((li) => li.textContent.match(/\$[\d,]+(?:\.\d+)?/g) ?? [])),
        };
      }),
    );
  const BAD = /\bNaN\b|\bundefined\b|\bnull\b|Infinity|\[object|Invalid Date/;
  const by = (ws, t, s) => ws.find((w) => w.id === `${t}-${s}`);
  // one money format per widget: every figure with cents, or none
  const oneFormat = (money) => money.every((m) => m.includes('.')) || money.every((m) => !m.includes('.'));

  // ---- before any usage push: usage-runway says "No usage samples yet", with the reason ----
  mkdirSync(join(S, 'nousage'));
  const bare = (await (await fetch(`${base}/project?root=${encodeURIComponent(join(S, 'nousage'))}&name=nousage`)).json()).project_id;
  await putLayout(bare, ['usage-runway']);
  await page.goto(`${base}/?project=${bare}&view=home&range=4w`);
  await settle(3);
  await shot('nousage', ['usage-runway']);
  const nu = await widgets();
  for (const s of SIZES) {
    const w = by(nu, 'usage-runway', s);
    ok(w.state === null && w.status[0]?.kind === 'none' && w.status[0].text.endsWith('No usage samples yet'), `usage-runway ${s} (no samples): grey "No usage samples yet"`, w);
    ok(w.exp === 'Experimental', `usage-runway ${s}: the head says "Experimental"`, w.exp);
  }
  ok(/statusline script has not pushed/.test(by(nu, 'usage-runway', 'M').notes.join(' ')), 'usage-runway M (no samples): shows the unavailable reason', by(nu, 'usage-runway', 'M').notes);

  // ---- seed: ~8 weeks (with a /usage push) + a steady daily spend, a spike yesterday, a young board's 2 days ----
  const seed = JSON.parse(execFileSync(process.execPath, [join(REPO, 'test/overlay/metrics-seed.mjs'), S, String(PORT), REPO], { encoding: 'utf8' }));
  const Database = createRequire(join(REPO, 'package.json'))('better-sqlite3');
  const db = new Database(join(S, 'data', 'board.db'));
  db.pragma('busy_timeout = 5000');
  const now = Date.now();
  const H = 3_600_000;
  const D = 24 * H;
  const act = db.prepare(`INSERT INTO card_activity (project_id, task_id, agent, role, tokens, tokens_out, ms, usage, cost_estimated, created_at) VALUES (?, ?, ?, 'builder', ?, ?, ?, ?, 0, ?)`);
  const run = (board, id, k, at) => {
    const u = { input: Math.round(2e4 * k), output: Math.round(1.5e4 * k), cache_read: Math.round(4e5 * k), cache_creation: Math.round(3e4 * k) };
    act.run(board, id, 'Ada', u.input + u.output + u.cache_read + u.cache_creation, u.output, Math.round(20 * 60_000 * k), JSON.stringify({ 'claude-opus-5-5': u }), Math.round(at));
  };
  db.transaction(() => {
    // a checkout card never reviewed (its runs are never rework): a steady spend for 3 weeks, then a spike
    const steady = db.prepare(`SELECT t.id FROM tasks t WHERE t.project_id = ? AND t.phase_id = ? AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.task_id = t.id) LIMIT 1`).get(seed.ws, seed.phases.checkout);
    for (let d = 22; d >= 2; d--) run(seed.ws, steady.id, 0.3 + ((d * 7) % 5) / 25, now - d * D);
    run(seed.ws, steady.id, 6, now - D);
    // the young board (mobile): spend on two days only
    const m = db.prepare('SELECT id FROM tasks WHERE project_id = ? LIMIT 1').get(seed.mobile);
    run(seed.mobile, m.id, 0.5, now - 2 * D);
    run(seed.mobile, m.id, 0.6, now - D);
  })();
  db.close();

  // ---- workspace, 4 weeks: every widget, every size ----
  reads.ranged = reads.live = null;
  const n = await putLayout(seed.ws);
  await page.goto(`${base}/?project=${seed.ws}&view=home&range=4w`);
  await settle(n);
  await shot('4w');
  const w4 = await widgets();
  const R = reads.ranged;
  const L = reads.live;
  ok(!!R && !!L, 'the widgets read /metrics/agentic-cost (ranged with compare=previous, and live)');
  for (const t of TYPES)
    for (const s of SIZES) {
      const w = by(w4, t, s);
      ok(!!w && w.state === null, `${t} ${s}: renders (no error / empty / stale state)`, w && { state: w.state, text: w.text.slice(0, 120) });
      if (!w) continue;
      ok(!BAD.test(w.text), `${t} ${s}: no NaN / undefined / null in its text`, w.text.match(BAD)?.[0]);
      ok(w.exp === 'Experimental', `${t} ${s}: the head says "Experimental"`, w.exp);
      ok(w.status.length > 0 && w.status.every((x) => x.kind && x.text.length > 1), `${t} ${s}: status is an icon + text`, w.status);
      ok(oneFormat(w.money), `${t} ${s}: one money format across the widget`, w.money);
      if (t !== 'usage-runway') ok(w.chips.length > 0 && w.chips.every((c) => c.flat || c.vs === 'vs previous 4 weeks'), `${t} ${s}: delta chip(s) "vs previous 4 weeks"`, w.chips);
      else ok(w.chips.length === 0, 'usage-runway: live, no delta chip');
    }

  // rework-cost: the written thresholds; L lists the top cards
  const pct = R.reworkCost.pct;
  const want = pct > 0.25 ? ['bad', 'Red: over 25% of spend'] : pct >= 0.1 ? ['warn', 'Amber: 10–25% of spend'] : ['ok', 'Green: under 10% of spend'];
  const rs = by(w4, 'rework-cost', 'M').status[0];
  ok(rs.kind === want[0] && rs.text.endsWith(want[1]) && /green under 10%, amber 10–25%, red over 25%/.test(rs.title), `rework-cost: ${Math.round(pct * 100)}% of spend → ${want[1]}, thresholds in the tooltip`, rs);
  ok(by(w4, 'rework-cost', 'L').list === Math.min(5, R.reworkCost.top.length) && R.reworkCost.top.length > 0 && by(w4, 'rework-cost', 'M').list === 0, 'rework-cost: L lists the top (≤ 5) cards by rework $, M does not', by(w4, 'rework-cost', 'L').list);
  ok(by(w4, 'rework-cost', 'M').chips.some((c) => /pts/.test(c.text) || c.flat), 'rework-cost M: the share chip moves in points');

  // decision-latency-cost: $ of idle agent time, slip (approximation named), the queue oldest first
  const dl = R.decisionLatencyCost;
  ok(/of idle agent time waiting on you/.test(by(w4, 'decision-latency-cost', 'M').text), 'decision-latency-cost: "$ of idle agent time waiting on you"');
  ok(by(w4, 'decision-latency-cost', 'M').approx === !!dl.slip?.approximation, 'decision-latency-cost: labelled an approximation exactly when the API says so', { approx: by(w4, 'decision-latency-cost', 'M').approx, api: dl.slip?.approximation });
  ok(by(w4, 'decision-latency-cost', 'S').list === 0 && by(w4, 'decision-latency-cost', 'M').list === Math.min(2, dl.queue.length) && by(w4, 'decision-latency-cost', 'L').list === Math.min(5, dl.queue.length), 'decision-latency-cost: the waiting queue at M and up, not S', dl.queue.length);
  const firstRow = await page.$eval('.dw-widget[data-widget-id="decision-latency-cost-L"] .ac-list .ac-item-title', (e) => e.textContent);
  const oldest = dl.queue[0];
  ok(firstRow === (oldest.title ?? oldest.reason), 'decision-latency-cost: the queue is oldest first', { firstRow, oldest });
  // a needs-you row with no card opens the Needs-you drill
  const idx = dl.queue.findIndex((q) => !q.task_id);
  ok(idx >= 0 && idx < 5, 'seed: a waiting session with no card is in the L queue', idx);
  if (idx >= 0 && idx < 5) {
    await page.click(`.dw-widget[data-widget-id="decision-latency-cost-L"] .ac-list li:nth-child(${idx + 1}) .ac-item`);
    await page.waitForFunction(() => document.querySelector('.mx-drill .mx-kicker')?.textContent === 'WHAT NEEDS A HUMAN', null, { timeout: 10000 }).catch(() => {});
    const drill = await page.$eval('.mx-drill', (p) => ({ kicker: p.querySelector('.mx-kicker')?.textContent, rows: p.querySelectorAll('.mx-drill-row').length })).catch(() => null);
    if (OUT) await page.screenshot({ path: `${OUT}/drill-needs-you.png` });
    ok(drill?.kicker === 'WHAT NEEDS A HUMAN' && drill.rows === dl.queue.length, 'decision-latency-cost: a session row opens the Needs-you drill with the whole queue', drill);
    await page.keyboard.press('Escape');
  }

  // cost-anomaly: the count, the flagged dots + text list (M), the L table
  const fl = R.costAnomaly.flagged;
  const flagDates = new Set(fl.map((f) => f.date));
  ok(fl.length > 0, 'seed: the spike day is flagged', fl);
  ok(by(w4, 'cost-anomaly', 'S').text.startsWith(String(fl.length)) && !by(w4, 'cost-anomaly', 'S').spark, 'cost-anomaly S: the count of unusual days, no sparkline', by(w4, 'cost-anomaly', 'S').text.slice(0, 40));
  ok(by(w4, 'cost-anomaly', 'M').spark && by(w4, 'cost-anomaly', 'M').flags === flagDates.size, 'cost-anomaly M: daily sparkline with one dot per flagged day', { flags: by(w4, 'cost-anomaly', 'M').flags, days: flagDates.size });
  ok(by(w4, 'cost-anomaly', 'M').sr.length === fl.length, 'cost-anomaly M: the flagged days as a text list (screen readers)', by(w4, 'cost-anomaly', 'M').sr);
  ok(by(w4, 'cost-anomaly', 'L').table === Math.min(6, fl.length), 'cost-anomaly L: the flagged days with phase, spend, mean and σ', by(w4, 'cost-anomaly', 'L').table);
  ok(/mean \+ 2σ/.test(by(w4, 'cost-anomaly', 'M').status[0].title), 'cost-anomaly: the rule is written in the status tooltip');

  // usage-runway: weekly vs the p85 finish
  const u = L.usageRunway;
  ok(u?.status === 'ok' && u.weeklyBeforeP85 === true, 'seed: the weekly limit runs out before the p85 finish', u && { b: u.weeklyBeforeP85, gap: u.gapDays });
  const us = by(w4, 'usage-runway', 'M').status[0];
  const gapText = u.gapDays > 0 ? `${u.gapDays} day${u.gapDays === 1 ? '' : 's'} before p85` : 'by the p85 day';
  ok(us.kind === 'bad' && us.text.endsWith(`Red: weekly limit runs out ${gapText}`), 'usage-runway: red with the gap in days', us);
  ok(by(w4, 'usage-runway', 'S').limits === 0 && by(w4, 'usage-runway', 'M').limits === 2 && by(w4, 'usage-runway', 'L').limits === 2, 'usage-runway: both limits at M and up');
  ok(by(w4, 'usage-runway', 'M').notes.some((t) => /forecast: 50% .* · 85% /.test(t)), 'usage-runway M: names the forecast it is judged against', by(w4, 'usage-runway', 'M').notes);

  // ---- 375 wide: the same widgets, no page-level horizontal scroll ----
  await page.setViewportSize({ width: 375, height: 900 });
  await page.waitForTimeout(400);
  await shot('375');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '375px: no horizontal page scroll');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ---- the young board (2 days of spend): "Needs ≥ 5 days of history"; a board with no runs: empty ----
  await putLayout(seed.mobile, ['cost-anomaly']);
  await page.goto(`${base}/?project=${seed.mobile}&view=home&range=4w`);
  await settle(3);
  await shot('young', ['cost-anomaly']);
  const young = await widgets();
  ok(SIZES.every((s) => by(young, 'cost-anomaly', s).status[0]?.kind === 'none' && by(young, 'cost-anomaly', s).status[0].text.endsWith('Needs ≥ 5 days of history')), 'cost-anomaly (young board): grey "Needs ≥ 5 days of history"', young.map((w) => w.status));
  await putLayout(seed.empty, ['rework-cost']);
  await page.goto(`${base}/?project=${seed.empty}&view=home&range=4w`);
  await settle(3);
  const empty = await widgets();
  ok(empty.every((w) => w.state === 'empty' && /No priced agent runs/.test(w.text)), 'rework-cost (no runs): empty state with its reason', empty.map((w) => w.text));

  ok(errors.length === 0, 'no page errors', errors);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
