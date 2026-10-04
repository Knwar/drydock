// Dashboard widget: kpi. One headline number per tile, params.metric:
//   schedule | budget | decisions | throughput (sizes S, M, L).
// The question is the frame's title (a function of params.metric), so it shows in the loading,
// empty and error states too; params.title overrides it. Uses app.js globals read-only (node, svgEl, mx*,
// homeMeta, setView). Status is always an icon + text, never colour alone.

const KPI_ICONS = { ok: '✓', warn: '!', bad: '✕', none: '–' };

// Home's filters (fbParams: scope / phase / tag / agent / workType / from / to as epoch ms).
function kpiFilters(ctx) {
  const q = new URLSearchParams(ctx.filters);
  const get = (k) => q.get(k) || '';
  return { project: get('scope') || ctx.projectId, phase: get('phase'), tag: get('tag'), agent: get('agent'), workType: get('workType'), from: get('from'), to: get('to') };
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

// Window length in days (null = all time: no comparison), from previousWindow (whole calendar days,
// `to` inclusive; window.to is "now" for a rolling range, so it would round to the wrong N).
const kpiDays = (r) => {
  const pw = r?.previousWindow;
  return pw ? Math.max(1, Math.round((pw.to + 1 - pw.from) / 86_400_000)) : null;
};

// The standard delta chip ("▲ +3 · +50% vs prev 14 d"), as the agent panel's: colour by polarity
// (pol 1 = up is good, -1 = down is good), grey when there's nothing to compare, ±0 when the change
// rounds to zero at the display precision (diff formats a magnitude). o: { label, pol, diff, cur, prev,
// has (a comparison exists), vs / vsLong (visible / announced comparison label), none (the no-comparison text) }.
function kpiDelta(o) {
  const chip = node('span', 'kpi-delta');
  chip.setAttribute('role', 'img'); // its aria-label (with the better / worse verdict) is what's announced
  const a = o.cur;
  const b = o.prev;
  if (!o.has || a === null || a === undefined || b === null || b === undefined) {
    chip.classList.add('kpi-d-flat');
    chip.append(node('span', 'kpi-d-chg', o.has ? '—' : (o.none ?? 'No previous period')));
    if (o.has) chip.append(node('span', 'kpi-d-vs', o.vs));
    chip.setAttribute('aria-label', o.has ? `${o.label}: no comparison ${o.vsLong}` : `${o.label}: ${(o.none ?? 'No previous period').toLowerCase()}`);
    return chip;
  }
  const shown = o.diff(Math.abs(a - b));
  const d = Number(shown.replace(/[^\d.]/g, '')) === 0 ? 0 : a - b;
  if (d === 0) {
    chip.classList.add('kpi-d-flat');
    chip.append(node('span', 'kpi-d-chg', '±0'), node('span', 'kpi-d-vs', o.vs));
    chip.setAttribute('aria-label', `${o.label} unchanged ${o.vsLong}`);
    return chip;
  }
  const tone = o.pol === 0 ? 'flat' : d * o.pol > 0 ? 'good' : 'bad';
  chip.classList.add(`kpi-d-${tone}`);
  const sign = d > 0 ? '+' : '−';
  const pct = b !== 0 ? `${sign}${Math.abs(Math.round((d / Math.abs(b)) * 100))}%` : null;
  const arrow = node('span', 'kpi-d-arrow', d > 0 ? '▲' : '▼');
  arrow.setAttribute('aria-hidden', 'true');
  const val = `${sign}${shown}`;
  const chg = node('span', 'kpi-d-chg');
  chg.append(arrow, node('span', 'kpi-d-val', pct ? `${val} · ${pct}` : val));
  chip.append(chg, node('span', 'kpi-d-vs', o.vs));
  const verdict = tone === 'good' ? ', better' : tone === 'bad' ? ', worse' : '';
  chip.setAttribute('aria-label', `${o.label} ${d > 0 ? 'up' : 'down'} ${val}${pct ? ` (${pct})` : ''} ${o.vsLong}${verdict}`);
  return chip;
}

// A period-over-period chip for a compare=previous read r: "vs prev N d", or grey for all time.
function kpiPrevDelta(r, label, pol, diff, cur, prev) {
  const days = kpiDays(r);
  return kpiDelta({ label, pol, diff, cur, prev, has: !!r.previous && days !== null, vs: `vs prev ${days} d`, vsLong: `vs previous ${days} days` });
}

// A row under the headline holding a chip (and an optional quiet caption before it; dropped at S).
function kpiDeltaRow(chip, caption, ctx) {
  const row = node('div', 'kpi-delta-row');
  if (caption && ctx?.size !== 'S') row.append(node('span', 'kpi-delta-cap', caption));
  row.append(chip);
  return row;
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
  // p85 slip vs the phase's first snapshot (its baseline); null until there are two snapshot days
  const hist = await kpiGet(ctx, '/metrics/history', { project: f.project, phase: phase.id });
  const dl = hist.deltas;
  return { phase, next, today: s.today, slip: dl && dl.from !== dl.to ? (dl.slipDays.p85 ?? null) : null };
}

function kpiScheduleRender(el, d, ctx) {
  const p = d.phase;
  const [kind, text] = KPI_SCHEDULE[p.status] ?? KPI_SCHEDULE.unknown;
  el.append(kpiMain(p.p85 ? kpiDay(p.p85) : '—', 'p85', `target ${kpiDay(p.target_date)} · ${p.title}`, () => kpiOpenMetrics('forecast'), 'Open the forecast in Metrics'));
  if (d.slip !== null) el.append(kpiDeltaRow(kpiSlip(d.slip)));
  el.append(kpiStatus(kind, text));
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

// "▲ +3 d vs baseline" (later is bad), "▼ −2 d vs baseline" (earlier is good), "±0 on baseline".
function kpiSlip(days) {
  const chip = node('span', 'kpi-delta');
  chip.setAttribute('role', 'img');
  if (days === 0) {
    chip.classList.add('kpi-d-flat');
    chip.append(node('span', 'kpi-d-chg', '±0'), node('span', 'kpi-d-vs', 'on baseline'));
    chip.setAttribute('aria-label', 'p85 forecast on the phase baseline');
    return chip;
  }
  chip.classList.add(days > 0 ? 'kpi-d-bad' : 'kpi-d-good');
  const val = `${days > 0 ? '+' : '−'}${Math.abs(days)} d`;
  const arrow = node('span', 'kpi-d-arrow', days > 0 ? '▲' : '▼');
  arrow.setAttribute('aria-hidden', 'true');
  const chg = node('span', 'kpi-d-chg');
  chg.append(arrow, node('span', 'kpi-d-val', val));
  chip.append(chg, node('span', 'kpi-d-vs', 'vs baseline'));
  chip.setAttribute('aria-label', `p85 forecast ${mxPlural(Math.abs(days), 'day')} ${days > 0 ? 'later' : 'earlier'} than the phase baseline, ${days > 0 ? 'worse' : 'better'}`);
  return chip;
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
  // phase-level: no tag / agent (the budget covers the whole phase, all-time); from / to shape the weekly
  // series and the range spend (totals), compared with the previous period
  const cost = await kpiGet(ctx, '/metrics/cost', { project: f.project, tz: MX_LOCAL_TZ, phase: id, from: f.from, to: f.to, limit: 1, compare: 'previous' });
  const b = cost.budgets.find((x) => x.phase_id === id);
  if (!b || b.budget === null) return { empty: 'Set a budget on the active phase to track spend' };
  return { b, weekly: cost.weekly.slice(-8), cost };
}

function kpiBudgetRender(el, d, ctx) {
  const b = d.b;
  const [kind, text] = b.overBudget ? ['bad', 'Over budget'] : b.projectedOverBudget ? ['warn', 'Projected over'] : ['ok', 'Within budget'];
  const label = `${b.title} spend to date (all-time) · ${b.projected === null ? 'no projection yet' : `projected ${mxMoney(b.projected)}`}`;
  const c = d.cost;
  el.append(
    kpiMain(mxMoney(b.actual), `of ${mxMoney(b.budget)}`, label, () => kpiOpenMetrics('overview'), 'Open cost in Metrics'),
    kpiDeltaRow(kpiPrevDelta(c, 'Phase spend', -1, mxMoney, c.totals.cost, c.previous?.totals.cost), c.window ? `${mxMoney(c.totals.cost)} phase spend in range` : null, ctx),
    kpiStatus(kind, text),
  );
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
  // live (range-free) reads for the list + count; a separate ranged compare read only for the chip
  const [att, wait, ranged] = await Promise.all([
    kpiGet(ctx, '/attention', { project: f.project }),
    kpiGet(ctx, '/metrics/wait', { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, workType: f.workType }),
    kpiGet(ctx, '/metrics/wait', { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, workType: f.workType, from: f.from, to: f.to, compare: 'previous' }),
  ]);
  const seen = new Set();
  const items = [];
  const add = (it) => {
    if (it.id && seen.has(it.id)) return;
    if (it.id) seen.add(it.id);
    items.push(it);
  };
  // the Type filter, applied here (/attention returns every type): 'none' = unclassified
  const typeOk = (a) => !f.workType || (f.workType === 'none' ? !a.work_type : a.work_type === f.workType);
  for (const a of att) if (a.severity === 'blocker' && (!f.phase || a.phase_id === f.phase) && typeOk(a)) add({ id: a.card_id, board: f.project, title: a.title, since: a.since });
  for (const x of wait.waiting.blockers) add({ id: x.task_id, board: x.project_id, title: x.title, since: x.since });
  for (const n of wait.waiting.needsYou) add({ id: n.task_id, board: n.project_id, title: n.reason ? `Session waiting: ${n.reason}` : 'A session is waiting on you', since: n.since });
  items.sort((a, b) => a.since - b.since); // oldest first
  return { items, ranged };
}

function kpiDecisionsRender(el, d, ctx) {
  const now = Date.now();
  const n = d.items.length;
  // needs-you waits + blocker waits overlapping the range vs the previous period; down is good
  const w = d.ranged;
  const waits = (r) => (r ? r.needsYou.count + r.blocked.count : null);
  el.append(
    kpiMain(String(n), 'waiting on you', n ? `oldest ${mxWait(now - d.items[0].since)}` : 'no blockers, no sessions waiting'),
    kpiDeltaRow(kpiPrevDelta(w, 'Waits in range', -1, String, waits(w), waits(w.previous)), w.window ? `${waits(w)} waits in range` : null, ctx),
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

// ── throughput: "Is delivery speeding up?" (a trend: up is good) ──
// One /metrics/flow read over the last 8 rolling 7-day windows ending now (no partial ISO week).
// Windows ending before the board's first activity (flow.firstActivityAt) are pre-history: left
// out of the sparkline, and the prior average counts only full windows (starting at or after it).
const KPI_WEEK_MS = 7 * 86_400_000;
async function kpiThroughputLoad(ctx) {
  const f = kpiFilters(ctx);
  const now = Date.now();
  // no `to` (open-ended = up to now) and `from` floored to the minute: tiles in one cycle share the URL
  const from = Math.floor((now - 8 * KPI_WEEK_MS) / 60_000) * 60_000;
  const flow = await kpiGet(ctx, '/metrics/flow', { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from });
  const counts = Array(8).fill(0); // oldest → newest; [7] = the last 7 days
  for (const p of flow.points) {
    const k = Math.floor((now - p.doneAt) / KPI_WEEK_MS);
    if (k >= 0 && k < 8) counts[7 - k]++;
  }
  // window i spans (now − (8−i)·7d, now − (7−i)·7d]; no activity at all → only the current one
  const first = flow.firstActivityAt ?? now;
  const end = (i) => now - (7 - i) * KPI_WEEK_MS;
  const windows = counts.filter((_, i) => i === 7 || end(i) >= first); // the sparkline's
  const prior = counts.slice(3, 7).filter((_, j) => end(3 + j) - KPI_WEEK_MS >= first); // full windows of the 4 before
  return { windows, prior, recent: flow.points.filter((p) => now - p.doneAt < KPI_WEEK_MS), project: f.project, now };
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
  const last = d.windows[d.windows.length - 1];
  const prior = d.prior; // the full windows among the 4 before: now−35d … now−7d
  const avg = prior.length ? prior.reduce((s, x) => s + x, 0) / prior.length : 0;
  const vs = prior.length ? `prior ${prior.length}-wk avg ${mxNum(Math.round(avg * 10) / 10)}` : 'prior avg —';
  const main = kpiMain(String(last), 'done · last 7 days', vs, () => kpiDrillRecent(ctx, d, main), 'List the cards done in the last 7 days');
  // its own windows (not Home's range): the last 7 days vs the average of the full prior weeks; up is good
  const chip = kpiDelta({
    label: 'Cards done in the last 7 days',
    pol: 1,
    diff: (x) => mxNum(Math.round(x * 10) / 10),
    cur: last,
    prev: avg,
    has: prior.length > 0,
    vs: `vs prior ${prior.length}-wk avg`,
    vsLong: `vs the prior ${prior.length}-week average`,
    none: 'No full prior week yet',
  });
  el.append(main, kpiDeltaRow(chip));
  if (ctx.size === 'S' || d.windows.length < 2) return;
  const spark = node('div', 'kpi-detail kpi-spark');
  spark.append(node('span', 'kpi-k', `cards done per 7 days · last ${d.windows.length} windows`), mxSparkline(d.windows));
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
  params: [
    {
      key: 'metric',
      label: 'Metric',
      type: 'select',
      options: [
        { value: 'schedule', label: 'Schedule' },
        { value: 'budget', label: 'Budget' },
        { value: 'decisions', label: 'Decisions' },
        { value: 'throughput', label: 'Throughput' },
      ],
      default: 'schedule',
    },
  ],
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
