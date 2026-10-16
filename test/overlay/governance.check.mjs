// Headless checks of the overlay's Governance view: decision log + risk register (card 1d5bcff9).
// Self-contained: starts its own daemon on a scratch DB + port, seeds a workspace "shop" with a
// vertical "web" (phases, cards, a few decisions/risks via the HTTP API), drives Chrome, then
// kills the daemon and removes the scratch dir.
// Not part of `npm test` (needs Chrome + playwright-core). Run from the repo root:
//
//   node test/overlay/governance.check.mjs
//
// Env: PORT (default 7971; never 7890 or 7900), CHROME (browser binary; default macOS Google Chrome),
// PLAYWRIGHT_CORE (path to a playwright-core package; default: resolved from the repo, else
// the npx cache: `npx playwright-core --version` fills it), OUT (screenshot dir; none by default).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 7971);
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

// ---- scratch daemon ----
const base = `http://127.0.0.1:${PORT}`;
// the port must be free: never drive (or write to) a daemon this script didn't start
if (await fetch(base + '/').then(() => true, () => false)) throw new Error(`something already answers on ${PORT}: pick another PORT`);
const S = mkdtempSync(join(tmpdir(), 'kankan-governance-'));
mkdirSync(join(S, 'data'));
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
  const j = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
    const t = await r.json();
    if (!r.ok) throw new Error(`${p} ${JSON.stringify(t)}`);
    return t;
  };

  // ---- seed ----
  mkdirSync(join(S, 'shop/apps/web'), { recursive: true });
  const ws = (await j('GET', `/project?root=${encodeURIComponent(join(S, 'shop'))}&name=shop`)).project_id;
  const web = (await j('POST', '/vertical', { workspace_id: ws, name: 'web', root: join(S, 'shop/apps/web') })).project_id;
  const phCheckout = (await j('POST', '/phase', { project_id: ws, title: 'Checkout' })).phase_id;
  const phWeb = (await j('POST', '/phase', { project_id: web, title: 'Web checkout' })).phase_id;
  const cardPay = (await j('POST', '/task', { project_id: ws, title: 'Pick a payment provider', phase_id: phCheckout })).task_id;
  const cardPage = (await j('POST', '/task', { project_id: web, title: 'Checkout page', phase_id: phWeb })).task_id;
  const DAY = 86_400_000;
  const dOld = await j('POST', '/decisions', { project_id: ws, title: 'Monorepo with verticals', decision: 'One repo, apps/* per vertical.', decided_by: 'Knwar', decided_at: Date.now() - 20 * DAY });
  const dWeb = await j('POST', '/decisions', { project_id: web, title: 'Server-rendered checkout', decision: 'Render the checkout on the server.', rationale: 'Faster first paint.', decided_at: Date.now() - 10 * DAY, links: [{ target_type: 'card', target_id: cardPage }] });
  await j('POST', '/risks', { project_id: ws, title: 'Card data in logs', likelihood: 2, impact: 5, owner: 'Ada', mitigation: 'Scrub PANs in the logger.' });
  await j('POST', '/risks', { project_id: web, title: 'Slow checkout page', likelihood: 2, impact: 2 });

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
  };
  watch(page);
  const shot = (p, n) => (OUT ? p.screenshot({ path: `${OUT}/${n}.png` }) : null);
  const titles = (p, sel = '#gv-body .gv-item') => p.$$eval(sel, (els) => els.map((e) => e.querySelector('.gv-title').textContent));
  const itemBy = (p, title) => p.locator('#gv-body .gv-item', { has: p.locator(`.gv-title:text-is("${title}")`) });
  const dlg = page.locator('.gv-dialog');
  const field = (label) => dlg.getByLabel(label, { exact: true });

  // ================= DECISIONS (workspace) =================
  await page.goto(`${base}/?project=${ws}&view=governance`);
  await page.waitForSelector('#gv-body .gv-item', { timeout: 15000 });
  await page.waitForFunction(() => typeof gov !== 'undefined' && gov.meta, null, { timeout: 15000 });
  ok(await page.locator('#rail-governance').evaluate((e) => e.classList.contains('active')), 'rail entry active on ?view=governance');
  ok((await page.locator('.mx-tab[aria-current="page"]').textContent()) === 'Decisions', 'Decisions tab selected by default');
  ok(JSON.stringify(await titles(page)) === JSON.stringify(['Server-rendered checkout', 'Monorepo with verticals']), 'decisions newest first', await titles(page));
  ok((await itemBy(page, 'Server-rendered checkout').locator('.gv-scope').textContent()) === 'web', 'vertical item badge names the vertical board');
  ok((await itemBy(page, 'Monorepo with verticals').locator('.gv-scope').textContent()) === 'own', 'own item badge');
  ok((await itemBy(page, 'Server-rendered checkout').getByRole('button', { name: /^Edit/ }).count()) === 0, "a vertical's item is read-only on the workspace");

  // add with links (keyboard: focus Add, Enter opens; the first field has focus)
  await page.focus('#gv-add');
  await page.keyboard.press('Enter');
  await dlg.waitFor();
  ok(await field('Title').evaluate((e) => e === document.activeElement), 'add form: the title field has focus');
  await page.keyboard.type('Use Stripe for payments');
  await field('Decision').fill('Stripe Checkout, hosted page.');
  await field('Rationale').fill('PCI scope stays with the provider.');
  await field('Decided by').fill('Knwar');
  await field('Links').selectOption(`card:${cardPay}`);
  await field('Links').selectOption(`phase:${phCheckout}`);
  ok((await dlg.locator('.gv-chip').count()) === 2, 'add form: two link chips staged');
  await shot(page, '01-add-decision-form');
  await dlg.getByRole('button', { name: 'Add decision' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('#gv-body .gv-item').length === 3);
  ok((await titles(page))[0] === 'Use Stripe for payments', 'the new decision is listed first', await titles(page));
  const stripe = itemBy(page, 'Use Stripe for payments');
  const chips = await stripe.locator('.gv-chip').evaluateAll((els) => els.map((e) => e.textContent));
  ok(chips.some((t) => t.includes('Pick a payment provider')) && chips.some((t) => t.includes('Checkout')), 'link chips name the card + phase', chips);
  await shot(page, '02-decisions');

  // a 400 shown inline (empty title)
  await page.click('#gv-add');
  await dlg.waitFor();
  await field('Decision').fill('Something');
  await dlg.getByRole('button', { name: 'Add decision' }).click();
  await dlg.locator('.gv-form-err:not(:empty)').waitFor();
  const err400 = await dlg.locator('.gv-form-err').textContent();
  ok(err400.includes('title (non-empty string) required'), "the server's 400 text is shown inline", err400);
  await shot(page, '03-inline-400');
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  ok(await page.evaluate(() => document.activeElement?.id === 'gv-add'), 'Escape closes the form; focus returns to Add');

  // search
  await page.fill('#gv-search', 'stripe');
  ok(JSON.stringify(await titles(page)) === JSON.stringify(['Use Stripe for payments']), 'search filters (title)', await titles(page));
  await page.fill('#gv-search', 'first paint');
  ok(JSON.stringify(await titles(page)) === JSON.stringify(['Server-rendered checkout']), 'search filters (rationale)', await titles(page));
  await page.fill('#gv-search', 'zzz-nothing');
  ok((await page.locator('#gv-body .gv-empty').textContent()).includes('No decisions match'), 'search: no-match state');
  await page.fill('#gv-search', '');

  // supersede
  await stripe.getByRole('button', { name: 'Supersede' }).click();
  await dlg.waitFor();
  await field('Title').fill('Use Adyen for payments');
  await field('Decision').fill('Adyen, for the EU acquiring rates.');
  await dlg.getByRole('button', { name: 'Supersede' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('#gv-body .gv-item').length === 4);
  const oldRow = itemBy(page, 'Use Stripe for payments');
  ok((await oldRow.locator('.gv-pill').textContent()) === 'superseded', 'old decision marked superseded');
  ok((await oldRow.locator('.gv-super').textContent()) === 'Superseded by Use Adyen for payments', 'superseded links to the replacement');
  ok((await oldRow.getByRole('button', { name: /^(Edit|Supersede)/ }).count()) === 0, 'a superseded decision is read-only (no Edit / Supersede)');
  const newRow = itemBy(page, 'Use Adyen for payments');
  ok((await newRow.locator('.gv-pill').textContent()) === 'active', 'replacement is active');
  ok((await newRow.locator('.gv-chip').count()) === 2, 'replacement inherits the links');
  await page.fill('#gv-search', 'stripe');
  await oldRow.locator('.gv-super-link').click();
  ok(await page.evaluate(() => document.activeElement?.querySelector?.('.gv-title')?.textContent === 'Use Adyen for payments'), 'the replacement link reveals it (clearing the search)');
  ok((await page.inputValue('#gv-search')) === '', 'search cleared to reveal');
  await shot(page, '04-superseded');

  // card chip → card modal on Kanban; phase chip → Phases view with the phase selected
  await newRow.locator('.gv-chip.k-card').click();
  await page.waitForSelector('#card-modal:not(.hidden)');
  await page.waitForFunction(() => document.getElementById('card-title').textContent === 'Pick a payment provider', null, { timeout: 5000 }).catch(() => {});
  ok((await page.locator('#card-title').textContent()) === 'Pick a payment provider', 'card chip opens the card modal');
  ok(await page.locator('#rail-kanban').evaluate((e) => e.classList.contains('active')), 'card chip switches to Kanban');
  ok(new URL(page.url()).searchParams.get('view') !== 'governance', 'leaving the view drops ?view=governance');
  await page.keyboard.press('Escape');
  await page.evaluate(() => closeCardModal());
  await page.click('#rail-governance');
  await page.waitForSelector('#gv-body .gv-item');
  await itemBy(page, 'Use Adyen for payments').locator('.gv-chip.k-phase').click();
  await page.waitForSelector('#phases-view:not(.hidden)');
  ok(await page.evaluate((id) => selectedPhaseId === id, phCheckout), 'phase chip opens the Phases view on that phase');

  // ================= RISKS =================
  await page.goto(`${base}/?project=${ws}&view=governance&tab=risks`);
  await page.waitForSelector('#gv-body .gv-risk');
  ok((await page.locator('.mx-tab[aria-current="page"]').textContent()) === 'Risks', '?tab=risks opens the register');
  ok(await page.locator('#gv-search').isHidden(), 'no decision search on the Risks tab');
  async function addRisk(t, l, i, extra = {}) {
    await page.click('#gv-add');
    await dlg.waitFor();
    await field('Title').fill(t);
    await field('Likelihood (1-5)').fill(String(l));
    await field('Impact (1-5)').fill(String(i));
    if (extra.owner) await field('Owner').fill(extra.owner);
    if (extra.mitigation) await field('Mitigation').fill(extra.mitigation);
    if (extra.link) await field('Links').selectOption(extra.link);
    const n = await page.locator('#gv-body .gv-risk').count();
    await dlg.getByRole('button', { name: 'Add risk' }).click();
    await dlg.waitFor({ state: 'detached' });
    await page.waitForFunction((k) => document.querySelectorAll('#gv-body .gv-risk').length === k, n + 1);
  }
  await addRisk('Provider outage at launch', 4, 5, { owner: 'Inder', mitigation: 'Fallback provider behind a flag.', link: `phase:${phWeb}` });
  await addRisk('Currency rounding bugs', 3, 3, { owner: 'Ada' });
  // a 400 from the register form: blank impact
  await page.click('#gv-add');
  await dlg.waitFor();
  await field('Title').fill('Bad one');
  await field('Impact (1-5)').fill('');
  await dlg.getByRole('button', { name: 'Add risk' }).click();
  await dlg.locator('.gv-form-err:not(:empty)').waitFor();
  ok((await dlg.locator('.gv-form-err').textContent()).includes('impact must be an integer 1-5'), 'risk form: 400 inline');
  await page.keyboard.press('Escape');
  const risks = await page.$$eval('#gv-body .gv-risk', (els) => els.map((e) => ({ t: e.querySelector('.gv-title').textContent, n: Number(e.querySelector('.gv-score-n').textContent), sev: [...e.querySelector('.gv-score').classList].find((c) => ['hi', 'mid', 'low'].includes(c)) })));
  ok(JSON.stringify(risks.map((r) => r.n)) === JSON.stringify([20, 10, 9, 4]), 'risks sorted by score', risks);
  ok(JSON.stringify(risks.map((r) => r.sev)) === JSON.stringify(['hi', 'mid', 'mid', 'low']), 'severity colouring (≥15 rose, ≥8 amber, else grey)', risks);
  const colors = await page.$$eval('#gv-body .gv-score', (els) => els.map((e) => getComputedStyle(e).borderColor));
  ok(colors[0] !== colors[1] && colors[1] === colors[2] && colors[2] !== colors[3], 'severity colours differ on screen', colors);
  const outage = itemBy(page, 'Provider outage at launch');
  ok((await outage.locator('.gv-fact.owner').textContent()).includes('Inder') && (await outage.locator('.gv-fact.mitigation').textContent()).includes('Fallback provider'), 'owner + mitigation shown');
  ok((await outage.locator('.gv-chip.k-phase').textContent()).includes('Web checkout'), 'risk link chip (cross-board phase) names its board');
  ok((await itemBy(page, 'Slow checkout page').locator('.gv-scope').textContent()) === 'web', "vertical risk badge; read-only (no status select)") ;
  ok((await itemBy(page, 'Slow checkout page').locator('select.gv-status').count()) === 0, 'a vertical risk has no status control on the workspace');
  await shot(page, '05-risks');

  // edit
  await itemBy(page, 'Currency rounding bugs').getByRole('button', { name: 'Edit' }).click();
  await dlg.waitFor();
  ok((await field('Owner').inputValue()) === 'Ada', 'edit form prefilled');
  await field('Owner').fill('Knwar');
  await field('Likelihood (1-5)').fill('5');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.waitForFunction(() => [...document.querySelectorAll('#gv-body .gv-risk')].some((e) => e.querySelector('.gv-title').textContent === 'Currency rounding bugs' && e.querySelector('.gv-score-n').textContent === '15'));
  ok((await itemBy(page, 'Currency rounding bugs').locator('.gv-fact.owner').textContent()).includes('Knwar'), 'edit saved (owner, likelihood → score 15, rose)');
  ok((await titles(page, '#gv-body .gv-risk'))[1] === 'Currency rounding bugs', 're-sorted after the edit', await titles(page, '#gv-body .gv-risk'));

  // status change → closed collapsible
  await itemBy(page, 'Card data in logs').locator('select.gv-status').selectOption('closed');
  await page.waitForSelector('#gv-body details.gv-closed');
  ok((await page.locator('.gv-closed-sum').textContent()) === 'Closed & occurred (1)', 'closed goes to the collapsible section');
  ok(!(await page.locator('details.gv-closed').evaluate((d) => d.open)), 'collapsed by default');
  await page.locator('.gv-closed-sum').click();
  ok((await page.locator('details.gv-closed .gv-title').textContent()) === 'Card data in logs', 'the closed risk is inside it');
  ok((await page.locator('details.gv-closed .gv-pill').textContent()) === 'closed', 'status pill: closed');
  await shot(page, '06-closed');

  // live refresh: another client writes
  await j('POST', '/risks', { project_id: ws, title: 'Written by another client', likelihood: 5, impact: 5 });
  await page.waitForFunction(() => document.querySelector('#gv-body .gv-risk .gv-title')?.textContent === 'Written by another client', null, { timeout: 5000 }).then(
    () => ok(true, 'WS governance message refreshes the register'),
    () => ok(false, 'WS governance message refreshes the register'),
  );
  ok(await page.locator('details.gv-closed').evaluate((d) => d.open), 'the collapsible keeps its state across refreshes');
  await page.click('.mx-tab[data-tab="decisions"]');
  await j('PATCH', `/decisions/${dOld.id}`, { title: 'Monorepo with verticals (apps/*)' });
  await page.waitForFunction(() => [...document.querySelectorAll('#gv-body .gv-title')].some((e) => e.textContent === 'Monorepo with verticals (apps/*)'), null, { timeout: 5000 }).then(
    () => ok(true, 'WS refresh on the Decisions tab'),
    () => ok(false, 'WS refresh on the Decisions tab'),
  );

  // ================= VERTICAL VIEW =================
  const vp = await ctx.newPage();
  watch(vp);
  await vp.goto(`${base}/?project=${web}&view=governance`);
  await vp.waitForSelector('#gv-body .gv-item');
  await vp.waitForFunction(() => gov.meta);
  const vRow = itemBy(vp, 'Use Adyen for payments');
  ok((await vRow.locator('.gv-scope').textContent()) === 'workspace', 'vertical view: workspace item carries the "workspace" badge');
  ok((await vRow.getByRole('button', { name: /Edit|Supersede/ }).count()) === 0, 'vertical view: workspace item is read-only');
  ok((await vRow.locator('.gv-ro').textContent()) === 'Read-only · edit on the workspace', 'vertical view: says where to edit it');
  const own = itemBy(vp, 'Server-rendered checkout');
  ok((await own.locator('.gv-scope').textContent()) === 'own' && (await own.getByRole('button', { name: 'Edit' }).count()) === 1, 'vertical view: its own decision is editable');
  await shot(vp, '07-vertical-decisions');
  // a write on the workspace reaches the vertical's panel
  await page.click('.mx-tab[data-tab="decisions"]');
  await j('POST', '/decisions', { project_id: ws, title: 'Feature flags via env', decision: 'Env vars for now.' });
  await vp.waitForFunction(() => [...document.querySelectorAll('#gv-body .gv-title')].some((e) => e.textContent === 'Feature flags via env'), null, { timeout: 5000 }).then(
    () => ok(true, 'vertical view refreshes on a workspace write'),
    () => ok(false, 'vertical view refreshes on a workspace write'),
  );
  await vp.click('.mx-tab[data-tab="risks"]');
  await vp.waitForSelector('#gv-body .gv-risk');
  ok(new URL(vp.url()).searchParams.get('tab') === 'risks', 'tab kept in the URL');
  ok((await itemBy(vp, 'Written by another client').locator('.gv-scope').textContent()) === 'workspace', 'vertical view: workspace risk badge');
  ok((await itemBy(vp, 'Slow checkout page').locator('select.gv-status').count()) === 1, 'vertical view: own risk has a status control');
  await shot(vp, '08-vertical-risks');

  // ================= EMPTY + ERROR STATES =================
  mkdirSync(join(S, 'fresh'), { recursive: true });
  const fresh = (await j('GET', `/project?root=${encodeURIComponent(join(S, 'fresh'))}&name=fresh`)).project_id;
  const ep = await ctx.newPage();
  watch(ep);
  await ep.goto(`${base}/?project=${fresh}&view=governance`);
  await ep.waitForSelector('#gv-body .gv-empty');
  ok((await ep.locator('#gv-body .gv-empty').textContent()).startsWith('No decisions yet'), 'empty state (decisions)');
  await ep.click('.mx-tab[data-tab="risks"]');
  ok((await ep.locator('#gv-body .gv-empty').textContent()).startsWith('No risks yet'), 'empty state (risks)');
  await shot(ep, '09-empty');
  // a failed refresh of a shown list: kept, with the reason in the bar
  const failDecisions = (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
  await ep.click('.mx-tab[data-tab="decisions"]');
  await ep.route(/\/decisions\?/, failDecisions);
  await ep.evaluate(() => gvLoad());
  await ep.waitForSelector('#gv-err:not(:empty)');
  ok((await ep.locator('#gv-err').textContent()) === "Couldn't refresh the decisions: boom", 'failed refresh: reason in the bar, list kept');
  ok((await ep.locator('#gv-body .gv-empty').count()) === 1, 'failed refresh: the shown state stays');
  // a failed first load: the error state + Retry
  const xp = await ctx.newPage();
  watch(xp);
  await xp.route(/\/decisions\?/, failDecisions);
  await xp.goto(`${base}/?project=${fresh}&view=governance`);
  await xp.waitForSelector('#gv-body .mx-error');
  ok((await xp.locator('#gv-body .mx-error').textContent()).includes("Couldn't load the decisions: boom"), 'error state with the reason');
  await shot(xp, '10-error');
  await xp.unroute(/\/decisions\?/);
  await xp.locator('#gv-body .mx-error button').click();
  await xp.waitForSelector('#gv-body .gv-empty');
  ok(true, 'Retry recovers');
  // "Failed to load resource" console lines from the routed 500s are filtered by watch()

  ok(!exited, 'the daemon stayed up for the whole run', exited);
  ok(errors.length === 0, 'no page errors', errors);
} catch (err) {
  fails++;
  console.error('FAIL (threw)', err);
} finally {
  await browser?.close();
  daemon.kill();
  rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
