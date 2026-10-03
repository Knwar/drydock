// Dashboard widget: kpi. One headline number per tile, params.metric:
//   schedule | budget | decisions | throughput (sizes S, M, L).
// The question is the frame's title (a function of params.metric), so it shows in the loading,
// empty and error states too; params.title overrides it. Uses app.js globals read-only (node, svgEl, mx*,
// homeMeta, setView). Status is always an icon + text, never colour alone.

const KPI_ICONS = { ok: '✓', warn: '!', bad: '✕', none: '–' };

// Home's filters (fbParams: scope / phase / tag / agent / from / to as epoch ms).
function kpiFilters(ctx) {
  const q = new URLSearchParams(ctx.filters);
  const get = (k) => q.get(k) || '';
  return { project: get('scope') || ctx.projectId, phase: get('phase'), tag: get('tag'), agent: get('agent'), from: get('from'), to: get('to') };
}

// GET path?params, deduped per refresh cycle by its URL; errors throw (the renderer's error state).
function kpiGet(ctx, path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `${path}?${q}`;
  return ctx.shared(url, () => mxGet(url));
}

const kpiDay = (day) => `${MX_MONTHS[mxUtc(day).getUTCMonth()]} ${mxUtc(day).getUTCDate()}`; // Oct 20

function kpiStatus(kind, text) {
  const el = node('div', `kpi-status kpi-${kind}`);
  const ico = node('span', 'kpi-ico', KPI_ICONS[kind]);
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'kpi-status-text', text));
  return el;
}

// The headline: a big value (+ unit) over a quiet label; a button when the tile navigates / drills.
function kpiMain(value, unit, label, onClick, hint) {
  const el = node(onClick ? 'button' : 'div', 'kpi-main');
  if (onClick) {
    el.type = 'button';
    el.title = hint;
    el.onclick = onClick;
  }
  const line = node('span', 'kpi-line');
  line.append(node('span', 'kpi-value', value));
  if (unit) line.append(node('span', 'kpi-unit', unit));
  el.append(line);
  if (label) el.append(node('span', 'kpi-label', label));
  return el;
}

// Metrics opened on a tab (openMetrics reads ?tab; leaving Home clears only Home's own keys).
function kpiOpenMetrics(tab) {
  const url = new URL(location.href);
  url.searchParams.set('tab', tab);
  history.replaceState(null, '', url);
  setView('metrics');
}

// ── schedule: "Will the active phase hit its date?" ──
const KPI_SCHEDULE = {
  on_track: ['ok', 'On track'],
  at_risk: ['warn', 'At risk'],
  late: ['bad', 'Late'],
  complete: ['ok', 'Complete'],
  done: ['ok', 'Done'],
  unknown: ['none', 'No data'],
};

async function kpiScheduleLoad(ctx) {
  const f = kpiFilters(ctx);
  const s = await kpiGet(ctx, '/metrics/schedule', { project: f.project, tz: MX_LOCAL_TZ });
  const phase = f.phase ? s.phases.find((p) => p.id === f.phase) : s.phases.find((p) => p.project_id === f.project && p.phase_status === 'active');
  if (!phase) return { empty: 'No active phase to track' };
  if (!phase.target_date) return { empty: 'Set a target date on the active phase to track it' };
  const next = s.milestones.filter((m) => m.date >= s.today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  return { phase, next, today: s.today };
}

function kpiScheduleRender(el, d, ctx) {
  const p = d.phase;
  const [kind, text] = KPI_SCHEDULE[p.status] ?? KPI_SCHEDULE.unknown;
  el.append(
    kpiMain(p.p85 ? kpiDay(p.p85) : '—', 'p85', `target ${kpiDay(p.target_date)} · ${p.title}`, () => kpiOpenMetrics('forecast'), 'Open the forecast in Metrics'),
    kpiStatus(kind, text),
  );
  if (ctx.size === 'S') return;
  const det = node('div', 'kpi-detail');
  const pct = node('div', 'kpi-pcts');
  for (const [k, v] of [['p50', p.p50], ['p85', p.p85]]) {
    const cell = node('div', 'kpi-pct');
    cell.append(node('span', 'kpi-k', k), node('span', 'kpi-v', v ? kpiDay(v) : '—'));
    pct.append(cell);
  }
  det.append(pct, node('div', 'kpi-reason', p.reason));
  if (ctx.size === 'L') {
    const m = node('div', 'kpi-milestone');
    m.append(node('span', 'kpi-k', 'Next milestone'));
    if (d.next) {
      const days = Math.round((mxUtc(d.next.date) - mxUtc(d.today)) / 86_400_000);
      m.append(node('span', 'kpi-v', `${d.next.title} · ${kpiDay(d.next.date)}`), node('span', 'kpi-sub', days === 0 ? 'today' : `in ${mxPlural(days, 'day')}`));
    } else m.append(node('span', 'kpi-sub', 'none scheduled'));
    det.append(m);
  }
  el.append(det);
}

// ── budget: "Is spend within budget?" ──
async function kpiBudgetLoad(ctx) {
  const f = kpiFilters(ctx);
  let id = f.phase;
  if (!id) {
    const phases = await kpiGet(ctx, '/phases', { project: f.project });
    id = phases.find((p) => p.status === 'active')?.id;
  }
  if (!id) return { empty: 'No active phase to track' };
  // phase-level: no tag / agent (the budget covers the whole phase); from / to only shape the weekly series
  const cost = await kpiGet(ctx, '/metrics/cost', { project: f.project, tz: MX_LOCAL_TZ, phase: id, from: f.from, to: f.to, limit: 1 });
  const b = cost.budgets.find((x) => x.phase_id === id);
  if (!b || b.budget === null) return { empty: 'Set a budget on the active phase to track spend' };
  return { b, weekly: cost.weekly.slice(-8) };
}

function kpiBudgetRender(el, d, ctx) {
  const b = d.b;
  const [kind, text] = b.overBudget ? ['bad', 'Over budget'] : b.projectedOverBudget ? ['warn', 'Projected over'] : ['ok', 'Within budget'];
  const label = `${b.title} spend to date (all-time) · ${b.projected === null ? 'no projection yet' : `projected ${mxMoney(b.projected)}`}`;
  el.append(kpiMain(mxMoney(b.actual), `of ${mxMoney(b.budget)}`, label, () => kpiOpenMetrics('overview'), 'Open cost in Metrics'), kpiStatus(kind, text));
  if (ctx.size === 'S') return;
  const det = node('div', 'kpi-detail');
  const scale = Math.max(b.budget, b.actual, b.projected ?? 0) || 1;
  const pct = (v) => `${Math.min(100, (v / scale) * 100).toFixed(1)}%`;
  const bar = node('div', 'kpi-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `Actual ${mxMoney(b.actual)}${b.projected === null ? '' : `, projected ${mxMoney(b.projected)}`}, budget ${mxMoney(b.budget)}`);
  const seg = (cls, prop, v) => {
    const s = node('span', cls);
    s.style[prop] = pct(v);
    return s;
  };
  if (b.projected !== null) bar.append(seg('kpi-bar-proj', 'width', b.projected));
  bar.append(seg('kpi-bar-act', 'width', b.actual), seg('kpi-bar-cap', 'left', b.budget));
  const legend = node('div', 'kpi-legend');
  legend.append(node('span', 'kpi-lg-act', `actual ${mxMoney(b.actual)}`));
  if (b.projected !== null) legend.append(node('span', 'kpi-lg-proj', `projected ${mxMoney(b.projected)}`));
  legend.append(node('span', 'kpi-lg-cap', `budget ${mxMoney(b.budget)}`));
  det.append(bar, legend);
  if (ctx.size === 'L' && d.weekly.length >= 2) {
    const spark = node('div', 'kpi-spark');
    const range = `${kpiDay(d.weekly[0].start)} – ${kpiDay(mxAddDays(d.weekly[d.weekly.length - 1].start, 6))}`;
    spark.append(node('span', 'kpi-k', `weekly cost · ${range}`), mxSparkline(d.weekly.map((w) => w.cost)));
    det.append(spark);
  }
  el.append(det);
}

// ── decisions: "What needs a human?" ──
async function kpiDecisionsLoad(ctx) {
  const f = kpiFilters(ctx);
  const [att, wait] = await Promise.all([
    kpiGet(ctx, '/attention', { project: f.project }),
    kpiGet(ctx, '/metrics/wait', { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase }),
  ]);
  const seen = new Set();
  const items = [];
  const add = (it) => {
    if (it.id && seen.has(it.id)) return;
    if (it.id) seen.add(it.id);
    items.push(it);
  };
  for (const a of att) if (a.severity === 'blocker' && (!f.phase || a.phase_id === f.phase)) add({ id: a.card_id, board: f.project, title: a.title, since: a.since });
  for (const x of wait.waiting.blockers) add({ id: x.task_id, board: x.project_id, title: x.title, since: x.since });
  for (const n of wait.waiting.needsYou) add({ id: n.task_id, board: n.project_id, title: n.reason ? `Session waiting: ${n.reason}` : 'A session is waiting on you', since: n.since });
  items.sort((a, b) => a.since - b.since); // oldest first
  return { items };
}

function kpiDecisionsRender(el, d, ctx) {
  const now = Date.now();
  const n = d.items.length;
  el.append(
    kpiMain(String(n), 'waiting on you', n ? `oldest ${mxWait(now - d.items[0].since)}` : 'no blockers, no sessions waiting'),
    n ? kpiStatus('warn', 'Needs you') : kpiStatus('ok', 'All clear'),
  );
  if (ctx.size === 'S' || !n) return;
  const list = node('ul', 'kpi-list');
  for (const it of d.items.slice(0, ctx.size === 'L' ? 6 : 3)) {
    const li = node('li');
    const row = node(it.id ? 'button' : 'div', 'kpi-item');
    if (it.id) {
      row.type = 'button';
      row.title = 'Open the card';
      row.onclick = () => ctx.openCard(it.id, it.board);
    }
    row.append(node('span', 'kpi-item-title', it.title), node('span', 'kpi-item-age', mxWait(now - it.since)));
    li.append(row);
    list.append(li);
  }
  el.append(list);
}

// ── throughput: "Is delivery speeding up?" (a trend, not a target: neutral) ──
// One /metrics/flow read over the last 8 rolling 7-day windows ending now (no partial ISO week).
const KPI_WEEK_MS = 7 * 86_400_000;
async function kpiThroughputLoad(ctx) {
  const f = kpiFilters(ctx);
  const now = Date.now();
  // no `to` (open-ended = up to now) and `from` floored to the minute: tiles in one cycle share the URL
  const from = Math.floor((now - 8 * KPI_WEEK_MS) / 60_000) * 60_000;
  const flow = await kpiGet(ctx, '/metrics/flow', { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, tag: f.tag, agent: f.agent, from });
  const windows = Array(8).fill(0); // oldest → newest; [7] = the last 7 days
  for (const p of flow.points) {
    const k = Math.floor((now - p.doneAt) / KPI_WEEK_MS);
    if (k >= 0 && k < 8) windows[7 - k]++;
  }
  return { windows, recent: flow.points.filter((p) => now - p.doneAt < KPI_WEEK_MS), project: f.project, now };
}

async function kpiDrillRecent(ctx, d, btn) {
  btn.disabled = true;
  try {
    const meta = await homeMeta();
    const cards = d.recent.map((p) => {
      const c = meta?.cards.get(p.id);
      return { ...(c ?? {}), id: p.id, title: p.title, board: c?.board ?? d.project, lane: 'done', lane_since: p.doneAt };
    });
    await ctx.drillCards({ kicker: 'THROUGHPUT · LAST 7 DAYS', title: `${mxPlural(cards.length, 'card')} done`, cards, range: `since ${mxLongDay(mxDayKey(d.now - KPI_WEEK_MS, MX_LOCAL_TZ))}` });
  } catch (e) {
    console.error('kpi throughput drill', e);
  } finally {
    btn.disabled = false;
  }
}

function kpiThroughputRender(el, d, ctx) {
  const last = d.windows[7];
  const prior = d.windows.slice(3, 7); // the 4 windows before: now−35d … now−7d
  const avg = prior.reduce((s, x) => s + x, 0) / prior.length;
  const main = kpiMain(String(last), 'done · last 7 days', `vs prior 4-wk avg ${mxNum(Math.round(avg * 10) / 10)}`, () => kpiDrillRecent(ctx, d, main), 'List the cards done in the last 7 days');
  el.append(main);
  const trend = node('div', 'kpi-status kpi-trend');
  if (avg === 0) {
    const ico = node('span', 'kpi-ico', '–');
    ico.setAttribute('aria-hidden', 'true');
    trend.append(ico, node('span', 'kpi-status-text', 'no prior data'));
  } else {
    const dir = last > avg ? 'up' : last < avg ? 'down' : 'flat';
    const ico = node('span', 'kpi-ico', dir === 'up' ? '▲' : dir === 'down' ? '▼' : '=');
    ico.setAttribute('aria-hidden', 'true');
    const pct = Math.round((Math.abs(last - avg) / avg) * 100);
    trend.append(ico, node('span', 'kpi-status-text', dir === 'flat' ? 'Level with average' : `${pct}% ${dir === 'up' ? 'above' : 'below'} average`));
  }
  el.append(trend);
  if (ctx.size === 'S') return;
  const spark = node('div', 'kpi-detail kpi-spark');
  spark.append(node('span', 'kpi-k', 'cards done per 7 days · last 8 windows'), mxSparkline(d.windows));
  el.append(spark);
}

const KPI_METRICS = {
  schedule: { q: 'Will the active phase hit its date?', load: kpiScheduleLoad, render: kpiScheduleRender },
  budget: { q: 'Is spend within budget?', load: kpiBudgetLoad, render: kpiBudgetRender },
  decisions: { q: 'What needs a human?', load: kpiDecisionsLoad, render: kpiDecisionsRender },
  throughput: { q: 'Is delivery speeding up?', load: kpiThroughputLoad, render: kpiThroughputRender },
};

dwRegister({
  type: 'kpi',
  title: (params) => KPI_METRICS[params.metric]?.q ?? '',
  sizes: ['S', 'M', 'L'],
  load(ctx) {
    const m = KPI_METRICS[ctx.params.metric];
    if (!m) throw new Error(`Unknown KPI metric “${ctx.params.metric}”`);
    return m.load(ctx);
  },
  render(el, data, ctx) {
    if (data.empty) return { empty: data.empty };
    const box = node('div', 'kpi');
    KPI_METRICS[ctx.params.metric].render(box, data, ctx);
    el.append(box);
  },
});
