// Headless checks of the agentic widgets (autonomy-index, agent-stops, batch-size, spec-adherence,
// governance-posture; card a1e4b9cb): each renders at S / M / L with no NaN / undefined / null, its
// size tier's parts and the "Experimental" head note; chips whose previous period predates the board's
// first activity are grey ("No full previous period") and pre-history weeks are drawn grey; the
// autonomy-index ("needed a human") and batch-size drills open. Self-contained: starts its own daemon on a scratch DB + port, seeds ~8 weeks
// of data (metrics-seed.mjs) plus the agentic extras below (redirects, line data, acceptance criteria,
// tool events, decision links), drives Chrome, then kills the daemon and removes the DB.
// Not part of `npm test` (needs Chrome + playwright-core). Run from the repo root:
//
//   node test/overlay/agentic.check.mjs
//
// Env: PORT (default 7973; never 7890 or 7900), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else
// the npx cache: `npx playwright-core --version` fills it), OUT (screenshot dir; none by default).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7973);
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

const TYPES = ['autonomy-index', 'agent-stops', 'batch-size', 'spec-adherence', 'governance-posture'];
const SIZES = ['S', 'M', 'L'];

// ---- scratch daemon + seed ----
const base = `http://127.0.0.1:${PORT}`;
// the port must be free: never drive (or seed) a daemon this script didn't start
if (await fetch(base + '/').then(() => true, () => false)) throw new Error(`something already answers on ${PORT}: pick another PORT`);
const S = mkdtempSync(join(tmpdir(), 'kankan-agentic-'));
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

  // ---- agentic extras, straight into the scratch DB (the daemon only reads them back) ----
  const Database = createRequire(join(REPO, 'package.json'))('better-sqlite3');
  const db = new Database(join(S, 'data', 'board.db'));
  db.pragma('busy_timeout = 5000');
  const now = Date.now();
  const H = 3_600_000;
  const done = db.prepare(`SELECT id, project_id, assigned_agent AS agent FROM tasks WHERE lane = 'done' AND project_id IN (?, ?, ?) ORDER BY updated_at DESC`).all(seed.ws, seed.web, seed.api);
  const inFlight = db.prepare(`SELECT id, project_id, assigned_agent AS agent FROM tasks WHERE lane IN ('in_progress', 'in_review') AND project_id IN (?, ?, ?)`).all(seed.ws, seed.web, seed.api);
  const ev = db.prepare('INSERT INTO task_events (project_id, task_id, type, payload, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const firstMove = db.prepare(`SELECT created_at FROM task_events WHERE task_id = ? AND type = 'move' AND json_extract(payload, '$.to') = 'in_progress' ORDER BY created_at LIMIT 1`);
  db.transaction(() => {
    done.forEach((c, i) => {
      // every 4th done card was redirected (a human interrupt), every 5th raised a blocker (a self-stop)
      const ip = firstMove.get(c.id)?.created_at;
      if (ip && i % 4 === 1) ev.run(c.project_id, c.id, 'redirect', JSON.stringify({ reason: 'use the shared component' }), null, ip + 60_000);
      if (ip && i % 5 === 2) ev.run(c.project_id, c.id, 'block', JSON.stringify({ reason: 'which API shape?' }), c.agent, ip + 120_000);
      // line data on the latest run (the last two keep legacy estimated rows: no line data)
      const row = db.prepare('SELECT id FROM card_activity WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(c.id);
      if (row) db.prepare('UPDATE card_activity SET lines_added = ?, lines_removed = ?, estimated = ? WHERE id = ?').run(20 + ((i * 137) % 480), (i * 31) % 60, i >= done.length - 2 ? 1 : 0, row.id);
      // acceptance criteria: mostly all checked, every 3rd card one left unchecked
      const total = 3;
      const checked = i % 3 === 0 ? 2 : 3;
      db.prepare('UPDATE tasks SET subtasks = ? WHERE id = ?').run(JSON.stringify(Array.from({ length: total }, (_, k) => ({ text: `criterion ${k + 1}`, done: k < checked }))), c.id);
    });
    // tool events: tied to in-flight cards (two risky Bash commands among them), plus one untied
    const cmds = [['Bash', 'npm test'], ['Edit', 'src/a.ts'], ['Bash', 'rm -rf dist && npm run build'], ['Read', 'src/b.ts'], ['Bash', 'git push --force origin main'], ['Bash', 'git push --force-with-lease']];
    cmds.forEach(([tool, file], i) => {
      const c = inFlight[i % inFlight.length];
      ev.run(c.project_id, c.id, 'tool', JSON.stringify({ tool, file }), c.agent ?? 'builder', now - (i + 1) * 2 * H);
    });
    ev.run(seed.ws, null, 'tool', JSON.stringify({ tool: 'Bash', file: 'ls' }), 'builder', now - 20 * H);
  })();
  db.close();
  // decisions linked to a few recent done cards
  const dec = await fetch(`${base}/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: seed.ws, title: 'Shared components only', decision: 'Reuse the design system', decided_by: 'user', decided_at: now - 5 * 86_400_000, links: done.slice(0, 3).map((c) => ({ target_type: 'card', target_id: c.id })) }),
  });
  if (!dec.ok) throw new Error(`decision POST ${dec.status} ${await dec.text()}`);

  const ok = (cond, msg, extra) => {
    if (!cond) fails++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  };

  // the layout under test: every agentic type at S, M and L
  const SPAN = { S: 3, M: 6, L: 8 };
  const HEIGHT = { S: 3, M: 4, L: 5 };
  const rows = TYPES.flatMap((t) => SIZES.map((s) => ({ id: `r-${t}-${s}`, height: HEIGHT[s], slots: [{ id: `s-${t}-${s}`, span: SPAN[s], widgets: [{ id: `${t}-${s}`, type: t, size: s, params: {} }] }] })));
  const putLayout = async (project) => {
    const put = await fetch(`${base}/project/${project}/layout`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: { version: 1, sections: [{ id: 'sec1', title: 'Agentic', rows }] } }) });
    if (!put.ok) throw new Error(`layout PUT ${put.status} ${await put.text()}`);
  };
  await putLayout(seed.ws);
  await putLayout(seed.mobile);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
  const shot = async (n) => {
    if (!OUT) return;
    for (const t of TYPES)
      for (const s of SIZES) {
        const el = await page.$(`.dw-widget[data-widget-id="${t}-${s}"]`);
        await el.scrollIntoViewIfNeeded();
        await el.screenshot({ path: `${OUT}/${n}-${t}-${s}.png` });
      }
  };
  const settle = () =>
    page.waitForFunction(
      (n) => document.querySelectorAll('.dw-widget').length === n && !document.querySelector('.dw-widget.is-loading') && [...document.querySelectorAll('.dw-widget')].every((f) => f.querySelector('.dw-body').children.length),
      TYPES.length * SIZES.length,
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
          detail: !!body.querySelector('.ag-detail'),
          status: [...body.querySelectorAll('.ag-status')].map((s) => ({ text: s.textContent, ico: s.querySelector('.ag-ico')?.textContent ?? '', title: s.title })),
          chips: [...body.querySelectorAll('.dw-delta')].map((c) => ({ text: c.textContent, flat: c.classList.contains('dw-d-flat'), vs: c.querySelector('.dw-d-vs')?.textContent ?? null })),
          spark: !!body.querySelector('.ag-spark, .ag-bars'),
          list: body.querySelectorAll('.ag-list li').length,
          table: body.querySelectorAll('.ag-table tbody tr').length,
          patterns: body.querySelectorAll('.ag-patterns li').length,
        };
      }),
    );
  const BAD = /\bNaN\b|\bundefined\b|\bnull\b|Infinity|\[object|Invalid Date/;
  const by = (ws, t, s) => ws.find((w) => w.id === `${t}-${s}`);

  // ---- 4 weeks: every widget, every size ----
  await page.goto(`${base}/?project=${seed.ws}&view=home&range=4w`);
  await settle();
  await shot('4w');
  const w4 = await widgets();
  for (const t of TYPES)
    for (const s of SIZES) {
      const w = by(w4, t, s);
      ok(!!w && w.state === null, `${t} ${s}: renders (no error / empty / stale state)`, w && { state: w.state, text: w.text.slice(0, 120) });
      if (!w) continue;
      ok(!BAD.test(w.text), `${t} ${s}: no NaN / undefined / null in its text`, w.text.match(BAD)?.[0]);
      ok(w.exp === 'Experimental', `${t} ${s}: the head says "Experimental"`, w.exp);
      ok(w.status.length > 0 && w.status.every((x) => x.ico && x.text.length > x.ico.length && x.title), `${t} ${s}: status is an icon + text with its thresholds in the tooltip`, w.status);
      ok(w.chips.length > 0, `${t} ${s}: has a delta chip`);
      ok(w.detail === (s !== 'S'), `${t} ${s}: ${s === 'S' ? 'headline + chip only' : 'shows the detail tier'}`);
    }
  for (const t of ['autonomy-index', 'agent-stops']) ok(!by(w4, t, 'S').spark && by(w4, t, 'M').spark && by(w4, t, 'L').spark, `${t}: weekly trend at M and L, not S`);
  ok(by(w4, 'batch-size', 'L').list > 0 && by(w4, 'batch-size', 'L').list <= 5 && by(w4, 'batch-size', 'M').list === 0, 'batch-size: L lists the top (≤ 5) largest cards, M does not', by(w4, 'batch-size', 'L').list);
  // S has no room for the note (a tight S drops its second caption line): the count rides in the status tooltip; M shows it
  ok(!/had no line data/.test(by(w4, 'batch-size', 'S').text) && /had no line data/.test(by(w4, 'batch-size', 'S').status[0].title), 'batch-size S: the no-line-data count is in the status tooltip, not a body line', by(w4, 'batch-size', 'S'));
  ok(/had no line data/.test(by(w4, 'batch-size', 'M').text), 'batch-size M: says how many done cards had no line data', by(w4, 'batch-size', 'M').text);
  ok(by(w4, 'batch-size', 'S').chips.length === 1 && by(w4, 'batch-size', 'M').chips.length === 2, 'batch-size S: the median drops its chip (one caption line); M keeps both', [by(w4, 'batch-size', 'S').chips.length, by(w4, 'batch-size', 'M').chips.length]);
  ok(/first-pass on done cards/.test(by(w4, 'spec-adherence', 'M').text), 'spec-adherence M: the first-pass figure is "first-pass on done cards" (not quality’s first-pass rate)', by(w4, 'spec-adherence', 'M').text);
  ok(/reopen/.test(by(w4, 'autonomy-index', 'M').status[0].title), 'autonomy-index: the rule names reopens as needing a human', by(w4, 'autonomy-index', 'M').status[0].title);
  const axis = await page.$$eval('.dw-widget[data-widget-id^="autonomy-index-"] .ag-yaxis', (els) => els.map((e) => e.innerText.replace(/\n+/g, ' / ')));
  ok(axis.length === 2 && axis.every((t) => t === '100% / 0'), 'autonomy-index M / L: the sparkline axis is labelled 100% / 0', axis);
  // L: the trend grows into the free height (no empty half of a widget), and nothing overflows
  const fill = await page.evaluate(() => {
    const h = (id, sel) => document.querySelector(`.dw-widget[data-widget-id="${id}"] ${sel}`)?.getBoundingClientRect().height ?? 0;
    const over = (id) => {
      const b = document.querySelector(`.dw-widget[data-widget-id="${id}"] .dw-body`);
      return b.scrollHeight - b.clientHeight;
    };
    return { autoM: h('autonomy-index-M', '.ag-spark'), autoL: h('autonomy-index-L', '.ag-spark'), stopsM: h('agent-stops-M', '.ag-bars'), stopsL: h('agent-stops-L', '.ag-bars'), overAuto: over('autonomy-index-L'), overStops: over('agent-stops-L'), overGov: over('governance-posture-L') };
  });
  ok(fill.autoL > 2 * fill.autoM && fill.stopsL > 2 * fill.stopsM && fill.overAuto <= 1 && fill.overStops <= 1 && fill.overGov <= 1, 'autonomy / stops L: the trend fills the free height, nothing scrolls (governance L too)', fill);
  const stopChip = by(w4, 'agent-stops', 'S').chips[0];
  ok(stopChip.flat || stopChip.text.includes('×'), 'agent-stops: the ratio chip is in × (a ratio unit)', stopChip);
  // in-page: the states this seed doesn't reach (no criteria anywhere; an all-time empty board says "yet")
  const states = await page.evaluate(() => {
    const el = () => document.createElement('div');
    const ctx = (size, from) => ({ size, filters: from ? `from=${from}` : '', projectId: 'x', params: {} });
    const spec = el();
    agSpecRender(spec, { r: { specAdherence: { done: 3, pct: 0, byPhase: [{ phase_id: null, title: null, cards: 3, adherent: 0, criteria: { total: 0, checked: 0 }, reviewed: 2, firstPassRate: 0.5 }] }, previous: null } }, ctx('M'));
    const st = spec.querySelector('.ag-status');
    return {
      spec: { text: spec.innerText, kind: st?.className, icon: st?.querySelector('.ag-ico')?.textContent },
      yet: agAutonomyRender(el(), { r: { autonomy: { done: 0 } } }, ctx('M'))?.empty,
      period: agAutonomyRender(el(), { r: { autonomy: { done: 0 } } }, ctx('M', 1))?.empty,
    };
  });
  ok(/No acceptance criteria written/.test(states.spec.text) && /ag-none/.test(states.spec.kind) && !/Red|0%/.test(states.spec.text), 'spec-adherence (no criteria on any card): a neutral "No acceptance criteria written", not Red 0%', states.spec);
  ok(/^No cards done yet/.test(states.yet) && /^No cards done in this period/.test(states.period), 'empty copy: "yet" for all time, "in this period" for a range', states);
  ok(by(w4, 'spec-adherence', 'L').table > 0 && by(w4, 'spec-adherence', 'M').table === 0, 'spec-adherence: L adds the per-phase table');
  ok(by(w4, 'governance-posture', 'L').patterns === 6, 'governance-posture: L breaks risky commands down by pattern');
  const risky = by(w4, 'governance-posture', 'M').status[0];
  ok(/^✕Red: 2 risky commands ran$/.test(risky.text), 'governance-posture: risky commands are red (icon + text) when > 0, force-with-lease not counted', risky);
  // a ranged, named comparison; percentages change in points, never a %
  const g = by(w4, 'governance-posture', 'M').chips.concat(by(w4, 'autonomy-index', 'M').chips, by(w4, 'spec-adherence', 'M').chips);
  ok(g.every((c) => c.flat || c.vs === 'vs previous 4 weeks'), 'chips (4 weeks): labelled "vs previous 4 weeks"', g);
  ok(g.filter((c) => !c.flat).every((c) => !c.text.includes('%')), 'percentage chips change in points, never a %', g);

  // ---- drill: batch-size L "Open list" opens the largest cards ----
  const n = by(w4, 'batch-size', 'L').list;
  const listed = await page.$$eval('.dw-widget[data-widget-id="batch-size-L"] .ag-list .ag-item-title', (els) => els.map((e) => e.textContent));
  await page.click('.dw-widget[data-widget-id="batch-size-L"] .ag-link');
  await page.waitForSelector('.mx-drill', { timeout: 10000 });
  const drill = await page.$eval('.mx-drill', (p) => ({
    kicker: p.querySelector('.mx-kicker')?.textContent,
    rows: p.querySelectorAll('.mx-drill-row').length,
    sub: p.querySelector('.mx-drill-sub')?.textContent ?? '',
    sort: p.querySelector('.mx-drill-tools select')?.selectedOptions[0]?.textContent ?? '',
    titles: [...p.querySelectorAll('.mx-drill-row .mx-drill-title')].map((e) => e.textContent),
  }));
  if (OUT) await page.screenshot({ path: `${OUT}/drill-batch.png` });
  ok(drill.kicker === 'LARGEST CHANGES' && drill.rows === n, 'batch-size drill: opens the largest cards', { drill, n });
  ok(/^Last 4 weeks · /.test(drill.sub), 'batch-size drill: the subtitle names the period', drill.sub);
  ok(drill.sort === 'Largest first' && JSON.stringify(drill.titles) === JSON.stringify(listed), 'batch-size drill: in the widget’s order (largest first) by default', { drill, listed });
  await page.keyboard.press('Escape');

  // ---- drill: autonomy-index L "N needed a human" opens those cards ----
  const human = await page.$eval('.dw-widget[data-widget-id="autonomy-index-L"] .ag-human .ag-link', (b) => b.textContent);
  const nHuman = Number(human.match(/^(\d+) needed a human$/)?.[1]);
  await page.click('.dw-widget[data-widget-id="autonomy-index-L"] .ag-human .ag-link');
  await page.waitForFunction(() => document.querySelector('.mx-drill .mx-kicker')?.textContent === 'NEEDED A HUMAN', null, { timeout: 10000 });
  const hDrill = await page.$eval('.mx-drill', (p) => p.querySelectorAll('.mx-drill-row').length);
  // rows carry each card's done time (lane_since = doneAt), not one shared "done today"
  const hDays = await page.$$eval('.mx-drill .mx-drill-row .mx-drill-meta', (els) => new Set(els.map((e) => e.textContent.match(/done [A-Z][a-z]{2} \d+/)?.[0])).size);
  ok(hDays > 1, 'autonomy-index drill: rows show their own done dates', hDays);
  const hSub = await page.$eval('.mx-drill .mx-drill-sub', (e) => e.textContent);
  ok(/^Last 4 weeks · /.test(hSub), 'autonomy-index drill: the subtitle names the period', hSub);
  if (OUT) await page.screenshot({ path: `${OUT}/drill-autonomy.png` });
  ok(nHuman > 0 && hDrill === nHuman, 'autonomy-index L drill: "N needed a human" opens those N cards', { human, hDrill });
  await page.keyboard.press('Escape');

  // ---- a late-registering script: the Experimental note is applied to widgets already on screen ----
  const late = await page.evaluate(() => {
    document.querySelectorAll('.ag-exp').forEach((e) => e.remove());
    agExpNote(document);
    return [...document.querySelectorAll('.dw-widget')].every((f) => f.querySelector(':scope > .dw-head .ag-exp'));
  });
  ok(late, 'Experimental note: applied to widgets already on screen (agExpNote(document) at registration)');

  // ---- 8 weeks: the previous 8 weeks start before the seeded history → pre-history, grey ----
  await page.goto(`${base}/?project=${seed.ws}&view=home&range=8w`);
  await settle();
  await shot('8w');
  const w8 = await widgets();
  const pre = w8.flatMap((w) => w.chips);
  ok(pre.length > 0 && pre.every((c) => c.flat && c.text === 'No full previous period' && c.vs === null), 'chips (8 weeks): pre-history is grey "No full previous period", no label', pre.filter((c) => !(c.flat && c.text === 'No full previous period')));
  ok(w8.every((w) => !BAD.test(w.text) && w.state === null), '8 weeks: every widget renders without NaN / undefined', w8.filter((w) => BAD.test(w.text) || w.state).map((w) => w.id));

  // ---- a young board (mobile: first card 6 days ago), 4 weeks: weeks before it are drawn grey ----
  await page.goto(`${base}/?project=${seed.mobile}&view=home&range=4w`);
  await page.waitForFunction(() => document.querySelector('.dw-widget[data-widget-id="autonomy-index-M"] .ag-spark'), null, { timeout: 20000 });
  await shot('young');
  const young = await page.$eval('.dw-widget[data-widget-id="autonomy-index-M"] .dw-body', (b) => ({ band: !!b.querySelector('.ag-pre-band'), note: b.querySelector('.ag-axis')?.textContent ?? null }));
  ok(young.band && young.note === 'grey: before the board’s first activity', 'autonomy-index M (young board): pre-history weeks are a grey band, named', young);
  const emptyStops = await page.$eval('.dw-widget[data-widget-id="agent-stops-M"]', (f) => ({ empty: f.classList.contains('is-empty'), text: f.querySelector('.dw-body').innerText }));
  ok(emptyStops.empty && /no blockers raised/.test(emptyStops.text), 'agent-stops (no stops): empty state with its reason', emptyStops);

  ok(errors.length === 0, 'no page errors', errors);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
} finally {
  await browser?.close().catch(() => {});
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
