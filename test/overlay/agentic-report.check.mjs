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
    ['steer-bad', 'steering-pack', 'M', { period: 'steering', steeringDate: '2026-02-30' }],
    ['runway-M', 'usage-runway', 'M', {}],
    // stale stored overrides for filters these types don't use (filters: [workType] / [phase]): ignored, kept
    ['steer-stale', 'steering-pack', 'M', { vars: { tag: 'api', agent: 'Ada', phase: 'nope' } }],
    ['runway-stale', 'usage-runway', 'M', { vars: { tag: 'api', workType: 'feature' } }],
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
    if (id === 'steer-nodate' || id === 'steer-bad') continue;
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
    ok(/^Agent build time ÷ human estimate/.test(g.help) && /agent-hours/.test(g.help) && /above 1×, more/.test(g.help), `perception-gap ${s}: the tooltip explains the measure (agent build time, agent-hours) and a ratio > 1`, g.help);
    const p = est.perception;
    ok((!p.fallbacks || g.help.includes(`${p.fallbacks} card`)) && (!p.tooShort || g.help.includes(`${p.tooShort} card`)) && p.measure === 'build_time', `perception-gap ${s}: the tooltip counts the fallback (${p.fallbacks}) and too-short (${p.tooShort}) cards`, g.help);
    ok(/agent build time ÷ human estimate/.test(g.text) && !/cycle|measured ÷/.test(g.text), `perception-gap ${s}: labelled "agent build time ÷ human estimate"`, g.text.slice(0, 120));
    ok(r.detail === (s !== 'S') && g.detail === (s !== 'S'), `rate/gap ${s}: ${s === 'S' ? 'headline only' : 'the detail tier'}`);
  }
  const names = est.hourlyRate.byAgent.map((a) => a.agent ?? 'No agent');
  ok(names.length > 0 && JSON.stringify(by(w, 'rate-L').agents) === JSON.stringify(names) && by(w, 'rate-M').agents.length === 0, 'agent-hourly-rate L: the per-agent breakdown (byAgent), not at M', { ui: by(w, 'rate-L').agents, names });
  ok(by(w, 'gap-L').list === est.perception.topMisses.length && by(w, 'gap-L').list > 0 && by(w, 'gap-M').list === 0, 'perception-gap L: the top (≤ 5) misses, not at M', by(w, 'gap-L').list);
  // units and bases spelled out; one money format per widget
  const rateInfo = await page.evaluate(() => {
    const f = (id) => document.querySelector(`.dw-widget[data-widget-id="${id}"] .dw-body`);
    const perHour = [...f('rate-M').querySelectorAll('.ag-fig')].find((x) => /per estimated human hour/.test(x.textContent));
    return {
      chips: ['rate-S', 'gap-S'].map((id) => f(id).querySelector('.dw-delta')?.textContent ?? ''),
      flat: ['rate-S', 'gap-S'].map((id) => f(id).querySelector('.dw-delta')?.classList.contains('dw-d-flat')),
      perHour: perHour?.title ?? '',
      heads: [...f('rate-L').querySelectorAll('.ar-agents th')].map((th) => th.title),
      // the figures' money (not the "per $1" in the label)
      money: ['rate-M', 'rate-L'].map((id) => (f(id).innerText.replace(/per \$1\b/g, '').match(/\$[\d,]+(?:\.\d+)?/g) ?? [])),
    };
  });
  ok((rateInfo.flat[0] || rateInfo.chips[0].includes('h/$')) && (rateInfo.flat[1] || rateInfo.chips[1].includes('×')), 'chips: h/$ for the hourly rate, × for the ratio', rateInfo.chips);
  ok(/AI spend on the estimated done cards ÷ their estimated human hours/.test(rateInfo.perHour), 'agent-hourly-rate: "$ per human-equivalent hour" spells out its basis', rateInfo.perHour);
  ok(/share of its spend/.test(rateInfo.heads[2]) && /runs this agent ran/.test(rateInfo.heads[3]), 'agent-hourly-rate L: the table heads state the byAgent basis (hours by spend share, spend per run agent)', rateInfo.heads);
  const allMoney = rateInfo.money.flat();
  ok(allMoney.length > 0 && (allMoney.every((x) => x.includes('.')) || allMoney.every((x) => !x.includes('.'))) && rateInfo.money[0][0] === rateInfo.money[1][0], 'agent-hourly-rate: one money format, the same at M and L', rateInfo.money);
  const units = await page.evaluate(() => ({
    tiny: arRatio(0.004),
    zero: arRatio(0),
    one: arRatio(1),
    hrs: arHours(0.001),
    noAgent: (() => {
      const el = document.createElement('div');
      arRateRender(
        el,
        { e: { done: 4, coverage: { estimated: 4, pct: 1 }, hourlyRate: { cards: 1, noSpend: 0, estimateHours: 2, cost: 4, hoursPerDollar: 0.5, dollarsPerHour: 2, byAgent: [{ agent: null, cards: 1, estimateHours: 2, cost: 4, hoursPerDollar: 0.5 }] } } },
        { size: 'L', range: { id: '4w' } },
      );
      const td = el.querySelector('.ar-agents tbody td');
      return { text: td?.textContent, title: td?.title };
    })(),
  }));
  ok(units.tiny === '<0.01×' && units.zero === '<0.01×' && units.one === '1×' && units.hrs === '<0.01 h', 'perception-gap: a tiny ratio shows "<0.01×", never "0×"', units);
  ok(units.noAgent.text === 'No agent' && /no credited agent/.test(units.noAgent.title), 'agent-hourly-rate L: a null agent is "No agent" (runs with no credited agent)', units.noAgent);

  // drill: the top misses
  await page.click('.dw-widget[data-widget-id="gap-L"] .ag-k-row .ag-link');
  await page.waitForFunction(() => document.querySelector('.mx-drill .mx-kicker')?.textContent === 'ESTIMATE MISSES', null, { timeout: 10000 });
  const drillRows = await page.$eval('.mx-drill', (p) => p.querySelectorAll('.mx-drill-row').length);
  const gd = await page.$eval('.mx-drill', (p) => ({
    sub: p.querySelector('.mx-drill-sub')?.textContent ?? '',
    sort: p.querySelector('.mx-drill-tools select')?.selectedOptions[0]?.textContent ?? '',
    titles: [...p.querySelectorAll('.mx-drill-row .mx-drill-title')].map((e) => e.textContent),
  }));
  if (OUT) await page.screenshot({ path: `${OUT}/drill-misses.png` });
  ok(drillRows === est.perception.topMisses.length, 'perception-gap drill: opens the top misses', drillRows);
  ok(/^Last 4 weeks · /.test(gd.sub), 'perception-gap drill: the subtitle names the period', gd.sub);
  ok(gd.sort === 'Biggest miss first' && JSON.stringify(gd.titles) === JSON.stringify(est.perception.topMisses.map((c) => c.title)), 'perception-gap drill: in the widget’s order (biggest miss first)', gd);
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
  // a stored override for a filter the type doesn't use: no chip the user can't clear, no "not applied" note,
  // not sent with its reads, and still stored as it was
  const stale = await page.evaluate(() =>
    ['steer-stale', 'runway-stale'].map((id) => {
      const f = document.querySelector(`.dw-widget[data-widget-id="${id}"]`);
      return { id, chip: f.querySelector('.dw-vars').textContent, note: !!f.querySelector('.ar-unused'), vars: dwVars(dw.layout.sections[0].rows.find((r) => r.id === `r-${id}`).slots[0].widgets[0]) };
    }),
  );
  ok(stale.every((x) => x.chip === '' && !x.note && x.vars === null), 'stale overrides of unused filters: no chip, no "not applied" note, not applied', stale);
  const stored = (await j('GET', `/project/${seed.ws}/layout`)).layout.sections[0].rows.find((r) => r.id === 'r-steer-stale').slots[0].widgets[0].params.vars;
  ok(stored?.tag === 'api' && stored.agent === 'Ada' && stored.phase === 'nope', 'stale overrides: kept in the stored layout untouched', stored);
  const bad = by(w, 'steer-bad');
  ok(bad.state === 'empty' && /2026-02-30\) isn’t a real date/.test(bad.text), 'steering-pack: an impossible date (2026-02-30) "isn’t a real date"', bad.text);
  for (const id of ['steer-M', 'steer-L', 'steer-XL']) {
    const x = by(w, id);
    const shipped = Number(x.counts[3]);
    ok(x.text.includes(shipped === 1 ? '1\ncard shipped' : `${shipped}\ncards shipped`), `${id}: "card(s) shipped" pluralised (${shipped})`, x.text.match(/\d+\ncards? shipped/)?.[0]);
  }
  ok(/Decided by you/.test(xl.text) && !/Decided by user/.test(xl.text), 'steering-pack XL: the human decider is "you", never "user"', xl.text.match(/Decided by \w+/g));
  // L and XL fit their rows at 1440 (two columns); a narrow (390) body scrolls under the bottom fade
  const fit = await page.evaluate(() => ['steer-L', 'steer-XL'].map((id) => {
    const b = document.querySelector(`.dw-widget[data-widget-id="${id}"] .dw-body`);
    return { id, over: b.scrollHeight - b.clientHeight, cols: getComputedStyle(b.querySelector('.ar-grid')).gridTemplateColumns.split(' ').length };
  }));
  ok(fit.every((f) => f.over <= 1 && f.cols === 2), 'steering-pack L / XL at 1440: two columns, no scrolling', fit);

  // narrow: one column, and a body that scrolls shows the fade cue
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => ['steer-L', 'steer-XL'].map((id) => {
    const b = document.querySelector(`.dw-widget[data-widget-id="${id}"] .dw-body`);
    return { id, over: b.scrollHeight - b.clientHeight, fade: b.classList.contains('dw-clipped'), mask: getComputedStyle(b).maskImage || getComputedStyle(b).webkitMaskImage };
  }));
  if (OUT) await page.screenshot({ path: `${OUT}/steer-390.png` });
  ok(narrow.every((n) => n.over <= 1 || (n.fade && /gradient/.test(n.mask))), 'steering-pack at 390: a scrolling body shows the bottom fade', narrow);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(300);

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
    ok(/Shown once 30% or more of the done cards have an estimate/.test(x.text), `${id} (gated): states the 30% minimum inline`, x.text);
  }

  // ---- Home filtered by work type + tag: the pack's report link carries the work type; the tag is named as not applied ----
  await page.goto(`${base}/?project=${seed.ws}&view=home&range=4w&workType=feature&tag=api`);
  await settle(WS.length);
  const fw = await widgets();
  const href = new URLSearchParams(by(fw, 'steer-M').href.split('?')[1]);
  ok(href.get('workType') === 'feature', '"Open full report" carries the work type', by(fw, 'steer-M').href);
  ok(/^Tag filter not applied/.test(by(fw, 'steer-L').text.match(/Tag filter not applied[^\n]*/)?.[0] ?? ''), 'steering-pack: says the Tag filter is not applied', by(fw, 'steer-L').text.slice(0, 300));
  const rpw = await context.newPage();
  const repReq = rpw.waitForRequest((q) => q.url().includes('/report?'), { timeout: 10000 });
  await rpw.goto(`${base}${by(fw, 'steer-M').href}`);
  ok(new URL((await repReq).url()).searchParams.get('workType') === 'feature', 'report.html: reads /report with the work type it was opened with');
  await rpw.close();

  // ---- the editor: the config drawer shows only the filters a widget uses; the library clears the selection ----
  await page.goto(`${base}/?project=${seed.ws}&view=home&range=4w`);
  await settle(WS.length);
  await page.click('#home-edit');
  await page.waitForFunction(() => deState.active, null, { timeout: 5000 });
  const drawer = async (id) => {
    await page.evaluate((x) => decOpen(x), id);
    await page.waitForTimeout(200);
    return page.$$eval('#dec-drawer [data-dec-field^="v-"]', (els) => els.map((e) => e.dataset.decField).filter((k) => !/^v-(from|to)$/.test(k)));
  };
  const dRunway = await drawer('runway-M');
  const dSteer = await drawer('steer-M');
  const dRate = await drawer('rate-M');
  ok(JSON.stringify(dRunway) === JSON.stringify(['v-phase']), 'drawer: usage-runway offers only the Phase override (filters: [phase])', dRunway);
  ok(JSON.stringify(dSteer) === JSON.stringify(['v-workType']), 'drawer: steering-pack offers only the Type override (filters: [workType])', dSteer);
  ok(['v-phase', 'v-range', 'v-agent', 'v-tag', 'v-workType', 'v-compare'].every((k) => dRate.includes(k)), 'drawer: a widget declaring no filters keeps every field (the default)', dRate);
  await page.evaluate(() => decClose({ refocus: false }));
  // library: the selected widget's slot is already full → warned; after an add the selection clears
  const lib = await page.evaluate(async () => {
    deSelect({ kind: 'widget', id: 'rate-S' });
    deLibraryOpen();
    await new Promise((r) => setTimeout(r, 100));
    const sub = document.querySelector('.de-lib-sub');
    const before = { text: sub.textContent, warn: sub.classList.contains('de-lib-warn') };
    document.querySelector('.de-lib-type[data-type="cost-anomaly"]').click();
    await new Promise((r) => setTimeout(r, 50));
    document.querySelector('.de-lib-form button[type=submit]').click();
    await new Promise((r) => setTimeout(r, 200));
    const slot = loFind(deState.draft, 's-rate-S').node.widgets.length;
    const selected = deState.selected;
    deLibraryOpen();
    await new Promise((r) => setTimeout(r, 100));
    const next = document.querySelector('.de-lib-sub').textContent;
    const icons = [...document.querySelectorAll('.de-lib-type')].filter((b) => DE_LIB_TYPES[b.dataset.type]?.group === 'Agentic (experimental)').map((b) => ({ type: b.dataset.type, parts: b.querySelector('.de-lib-ic').children.length, generic: /de-lib-ic-generic/.test(b.querySelector('.de-lib-ic').className) }));
    document.querySelector('.de-lib-close').click();
    return { before, slot, selected, next, toast: document.querySelector('#ds-toast')?.textContent ?? '', icons };
  });
  if (OUT) await page.screenshot({ path: `${OUT}/editor-library.png` });
  ok(lib.before.warn && /fits about 1/.test(lib.before.text), 'library: adding to a slot that already fills its row is warned about', lib.before);
  ok(lib.slot === 2 && /now holds 2 widgets/.test(lib.toast), 'library: the over-full slot is named after the add (toast)', lib);
  ok(lib.selected === null && /new row/.test(lib.next), 'library: after "Add widget" the selection clears; the next add makes a new row', lib);
  ok(lib.icons.length === 12 && lib.icons.every((i) => i.parts > 0 && !i.generic), 'library: every agentic widget has its own schematic icon', lib.icons);

  ok(errors.length === 0, 'no page errors', errors);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
