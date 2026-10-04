// Headless checks of the agentic report widgets (steering-pack, agent-hourly-rate, perception-gap; card 50995b55):
// each renders at its sizes with no NaN / undefined / null and the "Experimental" head note; the estimate
// widgets show their coverage line, are greyed out under 30% coverage, break the rate down per agent at L and
// list (and drill) the top misses at L; the steering pack follows its period param (week / 2 weeks / since a
// steering date), its counts match GET /report, it lists decisions with their rationale (the options) and the
// milestones that moved, its "Open full report" link opens /report.html over the same period and "Copy as
// Markdown" copies /report.md (Clipboard API, and the execCommand fallback without it).
// Self-contained: starts its own daemon on a scratch DB + port, seeds ~8 weeks of data (metrics-seed.mjs) plus
// the extras below (estimates, decisions with options, risks, a moved milestone), drives Chrome, then kills
// the daemon and removes the DB. Not part of `npm test` (needs Chrome + playwright-core). Run from the repo root:
//
//   node test/overlay/agentic-report.check.mjs
//
// Env: PORT (default 7976; never 7890), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else
// the npx cache: `npx playwright-core --version` fills it), OUT (screenshot dir; none by default).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7976);
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

const D = 86_400_000;
const localDay = (t) => new Date(t).toLocaleDateString('en-CA'); // YYYY-MM-DD in the local tz (the browser's too)

// ---- scratch daemon + seed ----
const base = `http://127.0.0.1:${PORT}`;
// the port must be free: never drive (or seed) a daemon this script didn't start
if (await fetch(base + '/').then(() => true, () => false)) throw new Error(`something already answers on ${PORT}: pick another PORT`);
const S = mkdtempSync(join(tmpdir(), 'kankan-agentic-report-'));
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
  const j = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
    if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${await r.text()}`);
    return r.json();
  };
  const now = Date.now();
  const today = localDay(now);
  const dayOff = (n) => localDay(now + n * D);

  // ---- report extras: decisions with their options, risks, a milestone that moved 3 days ago ----
  await j('POST', '/decisions', { project_id: seed.ws, title: 'Payment provider', decision: 'Stripe first', rationale: 'Options: Stripe, Adyen, both. Chose Stripe: fastest to launch.', decided_by: 'user', decided_at: now - 2 * D });
  await j('POST', '/decisions', { project_id: seed.web, title: 'Analytics', decision: 'Server-side events', rationale: 'Options: client SDK or server events. Server-side avoids ad-blocker loss.', decided_by: 'user', decided_at: now - 9 * D });
  await j('POST', '/risks', { project_id: seed.ws, title: 'Provider approval delayed', likelihood: 4, impact: 5, status: 'open', owner: 'Knwar', mitigation: 'Apply this week' });
  await j('POST', '/risks', { project_id: seed.api, title: 'Refund edge cases', likelihood: 2, impact: 3, status: 'open' });
  const ms = await j('POST', '/milestones', { project_id: seed.ws, title: 'Beta', date: dayOff(9) });

  // ---- estimates on every done card except the mobile board's (mobile: 0% coverage, greyed out) + the milestone's history ----
  const Database = createRequire(join(REPO, 'package.json'))('better-sqlite3');
  const db = new Database(join(S, 'data', 'board.db'));
  db.pragma('busy_timeout = 5000');
  db.transaction(() => {
    const done = db.prepare(`SELECT id FROM tasks WHERE lane = 'done' AND project_id IN (?, ?, ?) ORDER BY id`).all(seed.ws, seed.web, seed.api);
    done.forEach((c, i) => db.prepare('UPDATE tasks SET estimate_hours = ? WHERE id = ?').run(2 + (i % 7) * 2, c.id));
    const snap = db.prepare('INSERT OR REPLACE INTO milestone_snapshots (milestone_id, project_id, date, milestone_date) VALUES (?, ?, ?, ?)');
    for (let d = 20; d >= 1; d--) snap.run(ms.id, seed.ws, dayOff(-d), d > 3 ? dayOff(5) : dayOff(9)); // +4 days, 3 days ago
  })();
  db.close();

  const ok = (cond, msg, extra) => {
    if (!cond) fails++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  };

  const steerDay = dayOff(-10);
  const SPAN = { S: 3, M: 6, L: 8, XL: 12 };
  const HEIGHT = { S: 3, M: 4, L: 5, XL: 8 };
  const WS = [
    ...['S', 'M', 'L'].flatMap((s) => [
      [`rate-${s}`, 'agent-hourly-rate', s, {}],
      [`gap-${s}`, 'perception-gap', s, {}],
    ]),
    ['steer-M', 'steering-pack', 'M', {}],
    ['steer-L', 'steering-pack', 'L', { period: '2weeks' }],
    ['steer-XL', 'steering-pack', 'XL', { period: 'steering', steeringDate: steerDay }],
    ['steer-nodate', 'steering-pack', 'M', { period: 'steering' }],
  ];
  const layout = (ws) => ({
    layout: {
      version: 1,
      sections: [{ id: 'sec1', title: 'Report', rows: ws.map(([id, type, size, params]) => ({ id: `r-${id}`, height: HEIGHT[size], slots: [{ id: `s-${id}`, span: SPAN[size], widgets: [{ id, type, size, params }] }] })) }],
    },
  });
  await j('PUT', `/project/${seed.ws}/layout`, layout(WS));
  const MOBILE = [
    ['rate-M', 'agent-hourly-rate', 'M', {}],
    ['gap-M', 'perception-gap', 'M', {}],
  ];
  await j('PUT', `/project/${seed.mobile}/layout`, layout(MOBILE));

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const estUrls = []; // the widgets' own /metrics/estimates reads (Home's filters + range)
  page.on('request', (q) => q.url().includes('/metrics/estimates?') && estUrls.push(q.url()));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
  const shot = async (n, ids) => {
    if (!OUT) return;
    for (const id of ids) {
      const el = await page.$(`.dw-widget[data-widget-id="${id}"]`);
      await el.scrollIntoViewIfNeeded();
      await el.screenshot({ path: `${OUT}/${n}-${id}.png` });
    }
  };
  const settle = (n) =>
    page.waitForFunction(
      (n) => document.querySelectorAll('.dw-widget').length === n && !document.querySelector('.dw-widget.is-loading') && [...document.querySelectorAll('.dw-widget')].every((f) => f.querySelector('.dw-body').children.length),
      n,
      { timeout: 20000 },
    );
  const widgets = () =>
    page.$$eval('.dw-widget', (els) =>
      els.map((f) => {
        const body = f.querySelector('.dw-body');
        return {
          id: f.dataset.widgetId,
          size: body.dataset.size,
          state: ['error', 'empty', 'stale'].find((s) => f.classList.contains(`is-${s}`)) ?? null,
          text: body.innerText,
          exp: f.querySelector(':scope > .dw-head .ag-exp')?.textContent ?? null,
          value: body.querySelector('.ag-value')?.textContent ?? null,
          help: body.querySelector('.ar-help')?.title ?? '',
          coverage: body.querySelector('.ar-coverage')?.textContent ?? null,
          gated: body.querySelector('.ar-gated-text')?.textContent ?? null,
          chips: body.querySelectorAll('.dw-delta').length,
          detail: !!body.querySelector('.ag-detail'),
          agents: [...body.querySelectorAll('.ar-agents tbody tr')].map((tr) => tr.firstChild.textContent),
          list: body.querySelectorAll('.ag-list li').length,
          rag: body.querySelector('.ar-rag .dl-st')?.textContent ?? null,
          counts: [...body.querySelectorAll('.ar-counts .ag-value')].map((v) => v.textContent),
          href: body.querySelector('.ar-actions a')?.getAttribute('href') ?? null,
          copy: !!body.querySelector('.ar-actions button'),
          pack: !!body.querySelector('.ar-pack'),
          secs: [...body.querySelectorAll('.ar-sec .ag-k')].map((k) => k.textContent),
        };
      }),
    );
  const BAD = /\bNaN\b|\bundefined\b|\bnull\b|Infinity|\[object|Invalid Date/;
  const by = (ws, id) => ws.find((w) => w.id === id);

  // ---- the workspace, 4 weeks ----
  await page.goto(`${base}/?project=${seed.ws}&view=home&range=4w`);
  await settle(WS.length);
  await shot('ws', WS.map((w) => w[0]));
  const w = await widgets();
  for (const [id] of WS) {
    const x = by(w, id);
    ok(!!x && x.exp === 'Experimental', `${id}: the head says "Experimental"`, x?.exp);
    if (id === 'steer-nodate') continue;
    ok(!!x && x.state === null, `${id}: renders (no error / empty / stale state)`, x && { state: x.state, text: x.text.slice(0, 160) });
    ok(!!x && !BAD.test(x.text), `${id}: no NaN / undefined / null in its text`, x?.text.match(BAD)?.[0]);
  }

  // estimates: the API figures the widgets should show
  ok(estUrls.length > 0 && new Set(estUrls).size === 1, 'rate + gap: one shared /metrics/estimates read', estUrls);
  const est = await fetch(estUrls[0]).then((r) => r.json());
  for (const s of ['S', 'M', 'L']) {
    const r = by(w, `rate-${s}`);
    const g = by(w, `gap-${s}`);
    const cov = `Based on ${est.coverage.estimated} of ${est.done} done cards with estimates (${Math.round(est.coverage.pct * 100)}%)`;
    ok(r.coverage === cov && g.coverage === cov, `rate/gap ${s}: the coverage line ("${cov}")`, [r.coverage, g.coverage]);
    ok(/^\d[\d.,]* h$/.test(r.value) && r.chips === 1, `agent-hourly-rate ${s}: hours per dollar + its delta chip`, r);
    ok(/^\d[\d.,]*×$/.test(g.value) && g.chips === 1, `perception-gap ${s}: the median ratio + its delta chip`, g);
    ok(/above 1× means the work took longer than estimated/.test(g.help), `perception-gap ${s}: the tooltip explains a ratio > 1`, g.help);
    ok(r.detail === (s !== 'S') && g.detail === (s !== 'S'), `rate/gap ${s}: ${s === 'S' ? 'headline only' : 'the detail tier'}`);
  }
  const names = est.hourlyRate.byAgent.map((a) => a.agent ?? 'Unassigned');
  ok(names.length > 0 && JSON.stringify(by(w, 'rate-L').agents) === JSON.stringify(names) && by(w, 'rate-M').agents.length === 0, 'agent-hourly-rate L: the per-agent breakdown (byAgent), not at M', { ui: by(w, 'rate-L').agents, names });
  ok(by(w, 'gap-L').list === est.perception.topMisses.length && by(w, 'gap-L').list > 0 && by(w, 'gap-M').list === 0, 'perception-gap L: the top (≤ 5) misses, not at M', by(w, 'gap-L').list);

  // drill: the top misses
  await page.click('.dw-widget[data-widget-id="gap-L"] .ag-k-row .ag-link');
  await page.waitForFunction(() => document.querySelector('.mx-drill .mx-kicker')?.textContent === 'ESTIMATE MISSES', null, { timeout: 10000 });
  const drillRows = await page.$eval('.mx-drill', (p) => p.querySelectorAll('.mx-drill-row').length);
  if (OUT) await page.screenshot({ path: `${OUT}/drill-misses.png` });
  ok(drillRows === est.perception.topMisses.length, 'perception-gap drill: opens the top misses', drillRows);
  await page.keyboard.press('Escape');

  // steering pack: counts match /report over each period
  const tz = await page.evaluate(() => MX_LOCAL_TZ);
  const report = (q) => j('GET', `/report?project=${seed.ws}&tz=${encodeURIComponent(tz)}&${q}`);
  const PERIODS = [
    ['steer-M', `from=${dayOff(-6)}`, `days=7`],
    ['steer-L', `from=${dayOff(-13)}`, `days=14`],
    ['steer-XL', `from=${steerDay}`, `from=${steerDay}`],
  ];
  for (const [id, q, link] of PERIODS) {
    const x = by(w, id);
    const r = await report(q);
    const want = [r.decisions.made.length, r.risks.open.length, 1, r.shipped.total].map(String);
    ok(JSON.stringify(x.counts) === JSON.stringify(want), `${id}: decisions / open risks / milestones moved / shipped match /report (${q})`, { ui: x.counts, want });
    ok(!!x.rag && x.copy && x.href?.startsWith('/report.html?') && x.href.includes(link), `${id}: RAG headline + "Open full report" (${link}) + "Copy as Markdown"`, x.href);
    ok(x.pack === (x.size !== 'M'), `${id}: ${x.size === 'M' ? 'headline + counts only' : 'the one-pager sections'}`, x.secs);
  }
  const xl = by(w, 'steer-XL');
  ok(/Stripe first/.test(xl.text) && /Options: Stripe, Adyen, both/.test(xl.text) && /Options: client SDK or server events/.test(xl.text), 'steering-pack XL: decisions with their options (rationale), since the steering date', xl.text.slice(0, 400));
  ok(/Beta/.test(xl.text) && /\+4 d/.test(xl.text), 'steering-pack XL: the milestone moved +4 days', xl.text.match(/Milestones moved[\s\S]*/)?.[0]);
  ok(/Provider approval delayed/.test(xl.text) && /Owner Knwar/.test(xl.text), 'steering-pack XL: top risks with owner / mitigation', xl.text.match(/Top risks[\s\S]*/)?.[0]?.slice(0, 200));
  ok(!/Payment provider/.test(by(w, 'steer-M').text), 'steering-pack M: no decision list (headline + counts)');
  const nodate = by(w, 'steer-nodate');
  ok(nodate.state === 'empty' && /Set the last steering date/.test(nodate.text), 'steering-pack "since last steering date" with no date: asks for it', nodate);

  // Copy as Markdown: the Clipboard API, then the execCommand fallback without it
  await page.click('.dw-widget[data-widget-id="steer-M"] .ar-actions button');
  await page.waitForFunction(() => document.querySelector('.dw-widget[data-widget-id="steer-M"] .ar-copied')?.textContent === 'Copied', null, { timeout: 5000 }).catch(() => {});
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const md = await fetch(`${base}/report.md?project=${seed.ws}&tz=${encodeURIComponent(tz)}&from=${dayOff(-6)}`).then((r) => r.text());
  ok(clip.startsWith('# Status report') && clip === md, 'Copy as Markdown: copies /report.md for the period', clip.slice(0, 80));
  const fallback = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const btn = document.querySelector('.dw-widget[data-widget-id="steer-L"] .ar-actions button');
    btn.click();
    for (let i = 0; i < 40 && !btn.nextElementSibling.textContent; i++) await new Promise((r) => setTimeout(r, 50));
    return btn.nextElementSibling.textContent;
  });
  ok(fallback === 'Copied', 'Copy as Markdown: execCommand fallback without the Clipboard API', fallback);

  // Open full report: report.html over the same period (the steering date via from=)
  const rp = await context.newPage();
  await rp.goto(`${base}${xl.href}`);
  await rp.waitForSelector('#rp-overall', { timeout: 10000 });
  const sub = await rp.$eval('.rp-sub', (e) => e.textContent);
  const cur = await rp.$$eval('.rp-seg .rp-btn', (bs) => bs.filter((b) => b.getAttribute('aria-current') === 'true').length);
  if (OUT) await rp.screenshot({ path: `${OUT}/report-from.png` });
  ok(sub.startsWith(`${steerDay} to ${today}`) && cur === 0, 'Open full report: report.html from the steering date (no day range highlighted)', { sub, cur });
  await rp.goto(`${base}${by(w, 'steer-L').href}`);
  await rp.waitForSelector('#rp-overall', { timeout: 10000 });
  ok((await rp.$eval('.rp-sub', (e) => e.textContent)).startsWith(`${dayOff(-13)} to ${today}`), 'Open full report: report.html over the last 2 weeks');
  await rp.close();

  // ---- under 30% coverage (mobile: no estimates): greyed out with the coverage line ----
  await page.goto(`${base}/?project=${seed.mobile}&view=home&range=4w`);
  await settle(MOBILE.length);
  await shot('mobile', MOBILE.map((x) => x[0]));
  const m = await widgets();
  for (const id of ['rate-M', 'gap-M']) {
    const x = by(m, id);
    ok(x.gated === 'Add estimates to cards to see this' && /^Based on 0 of \d+ done cards with estimates \(0%\)$/.test(x.coverage) && x.value === null && !x.detail, `${id} (0% coverage): grey "Add estimates to cards to see this" + the coverage line`, x);
  }

  ok(errors.length === 0, 'no page errors', errors);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
