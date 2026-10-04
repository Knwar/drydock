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

// A period-over-period chip (dwDeltaChip) for a compare=previous read r: labelled with the range's
// name ("vs previous 4 weeks"; a custom range its dates, "vs Aug 31 – Sep 13"), the exact dates as its tooltip, grey for
// all time and "No full previous period" when the previous window starts before the board's first
// activity (since).
function kpiPrevDelta(r, ctx, since, subject, polarity, fmt, cur, prev) {
  const vs = dwVs(ctx.range, r.previousWindow, r.window);
  return dwDeltaChip({ cur, prev, polarity, fmt, subject, ...vs, has: !!r.previous && !!r.previousWindow, since, previousWindow: r.previousWindow });
}

// A row under the headline holding a chip, its subject inline before it ("range spend ▲ +$293 …") at every size.
function kpiDeltaRow(chip, caption) {
  const row = node('div', 'kpi-delta-row');
  if (caption) row.append(node('span', 'kpi-delta-cap', caption));
  row.append(chip);
  return row;
}

// A small-caps key with a date part kept in the tiles' date case: "WEEKLY COST · Oct 1 – Oct 26".
function kpiKey(text, dates) {
  const k = node('span', 'kpi-k', `${text} · `);
  k.append(node('span', 'kpi-k-date', dates));
  return k;
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
  const snap = (day) => hist.phases.find((x) => x.phase_id === phase.id && x.date === day) ?? null;
  const slip = dl && dl.from !== dl.to ? (dl.slipDays.p85 ?? null) : null;
  return { phase, next, today: s.today, slip, slipFrom: slip === null ? null : snap(dl.from)?.p85, slipTo: slip === null ? null : snap(dl.to)?.p85 };
}

function kpiScheduleRender(el, d, ctx) {
  const p = d.phase;
  const [kind, text] = KPI_SCHEDULE[p.status] ?? KPI_SCHEDULE.unknown;
  el.append(kpiMain(p.p85 ? kpiDay(p.p85) : '—', 'p85', `target ${kpiDay(p.target_date)} · ${p.title}`, () => kpiOpenMetrics('forecast'), 'Open the forecast in Metrics'));
  if (d.slip !== null) el.append(kpiDeltaRow(kpiSlip(d.slip, d.slipFrom, d.slipTo), d.slip > 0 ? 'slipped' : d.slip < 0 ? 'pulled in' : null));
  el.append(kpiStatus(kind, text));
  if (p.status === 'on_track') el.append(node('div', 'kpi-sub', 'still ahead of target'));
  if (ctx.size === 'S') return;
  const det = node('div', 'kpi-detail');
  const pct = node('div', 'kpi-pcts');
  for (const [k, v] of [['p50', p.p50], ['p85', p.p85]]) {
    const cell = node('div', 'kpi-pct');
    cell.append(node('span', 'kpi-k', k), node('span', 'kpi-v', v ? kpiDay(v) : '—'));
    pct.append(cell);
  }
  // the server's sentence carries ISO days: shown in the tiles' date format ("Oct 24")
  det.append(pct, node('div', 'kpi-reason', String(p.reason ?? '').replace(/\b\d{4}-\d{2}-\d{2}\b/g, (day) => kpiDay(day))));
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

// "slipped ▲ +3 d vs baseline" (later is bad), "pulled in ▼ −2 d vs baseline" (earlier is good), "±0 on
// baseline"; the dwDeltaChip look. Tooltip: "forecast p85 moved from Oct 16 to Oct 24" (from / to: the
// baseline's and the latest snapshot's p85 days).
function kpiSlip(days, from, to) {
  const chip = node('span', 'dw-delta');
  chip.setAttribute('role', 'img');
  if (from && to) chip.title = `forecast p85 moved from ${kpiDay(from)} to ${kpiDay(to)}`;
  if (days === 0) {
    chip.classList.add('dw-d-flat');
    chip.append(node('span', 'dw-d-chg', '±0'), node('span', 'dw-d-vs', 'on baseline'));
    chip.setAttribute('aria-label', 'p85 forecast on the phase baseline');
    return chip;
  }
  chip.classList.add(days > 0 ? 'dw-d-bad' : 'dw-d-good');
  const val = `${days > 0 ? '+' : '−'}${Math.abs(days)} d`;
  const arrow = node('span', 'dw-d-arrow', days > 0 ? '▲' : '▼');
  arrow.setAttribute('aria-hidden', 'true');
  const chg = node('span', 'dw-d-chg');
  chg.append(arrow, node('span', 'dw-d-val', val));
  chip.append(chg, node('span', 'dw-d-vs', 'vs baseline'));
  const moved = from && to ? ` (from ${kpiDay(from)} to ${kpiDay(to)})` : '';
  chip.setAttribute('aria-label', `p85 forecast ${days > 0 ? 'slipped' : 'pulled in'} ${mxPlural(Math.abs(days), 'day')} vs the phase baseline${moved}, ${days > 0 ? 'worse' : 'better'}`);
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
  const [cost, since] = await Promise.all([
    kpiGet(ctx, '/metrics/cost', { project: f.project, tz: MX_LOCAL_TZ, phase: id, from: f.from, to: f.to, limit: 1, compare: 'previous' }),
    dwFirstActivity(ctx).catch(() => null),
  ]);
  const b = cost.budgets.find((x) => x.phase_id === id);
  if (!b || b.budget === null) return { empty: 'Set a budget on the active phase to track spend' };
  return { b, weekly: cost.weekly.slice(-8), cost, since };
}

function kpiBudgetRender(el, d, ctx) {
  const b = d.b;
  const [kind, text] = b.overBudget ? ['bad', 'Over budget'] : b.projectedOverBudget ? ['warn', 'Projected over'] : ['ok', 'Within budget'];
  const label = `${b.title} · ${b.projected === null ? 'no projection yet' : `projected ${mxMoney(b.projected)}`}`;
  const c = d.cost;
  // the headline is all-time (phase to date); the chip compares the range's spend, and says so at every size
  el.append(
    kpiMain(mxMoney(b.actual), `of ${mxMoney(b.budget)} · phase to date`, label, () => kpiOpenMetrics('overview'), 'Open cost in Metrics'),
    kpiDeltaRow(kpiPrevDelta(c, ctx, d.since, `Range spend ${mxMoney(c.totals.cost)}`, -1, mxMoney, c.totals.cost, c.previous?.totals.cost), 'range spend'),
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
    spark.append(kpiKey('weekly cost', range), mxSparkline(d.weekly.map((w) => w.cost)));
    det.append(spark);
  }
  el.append(det);
}

// ── decisions: "What needs a human?" ──
// Every card filter applies (Phase, Tag, Agent, Type): /metrics/wait filters them all server-side;
// /attention takes tag / agent (matched as the metrics do), phase and type are applied here.
const KPI_DECISIONS_HINT = 'List what needs a human (Home’s Phase, Tag, Agent and Type filters apply)';
async function kpiDecisionsLoad(ctx) {
  const f = kpiFilters(ctx);
  const card = { phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType };
  // live (range-free) reads for the list + count; a separate ranged compare read only for the chip
  const [att, wait, ranged, since] = await Promise.all([
    kpiGet(ctx, '/attention', { project: f.project, tag: f.tag, agent: f.agent }),
    kpiGet(ctx, '/metrics/wait', { project: f.project, tz: MX_LOCAL_TZ, ...card }),
    kpiGet(ctx, '/metrics/wait', { project: f.project, tz: MX_LOCAL_TZ, ...card, from: f.from, to: f.to, compare: 'previous' }),
    dwFirstActivity(ctx).catch(() => null),
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
  // decisions: blockers (raised, failed twice, unmerged, sync conflicts) + sessions waiting on you; the
  // stall heuristic ("Agent quiet … — may be stuck") is a guess, not a decision: counted apart
  const scoped = att.filter((a) => a.severity === 'blocker' && (!f.phase || a.phase_id === f.phase) && typeOk(a));
  for (const a of scoped) if (a.kind !== 'stalled') add({ id: a.card_id, board: f.project, title: a.title, since: a.since });
  for (const x of wait.waiting.blockers) add({ id: x.task_id, board: x.project_id, title: x.title, since: x.since });
  for (const n of wait.waiting.needsYou) add({ id: n.task_id, board: n.project_id, title: n.reason ? `Session waiting: ${n.reason}` : 'A session is waiting on you', since: n.since });
  items.sort((a, b) => a.since - b.since); // oldest first
  const stuck = scoped.filter((a) => a.kind === 'stalled' && !seen.has(a.card_id)).map((a) => ({ title: a.title, reason: a.reason }));
  return { items, stuck, ranged, since };
}

async function kpiDrillDecisions(ctx, d, btn) {
  btn.disabled = true;
  try {
    const meta = await homeMeta();
    const cards = d.items.map((it) => {
      const c = it.id ? meta?.cards.get(it.id) : null;
      return { ...(c ?? {}), id: it.id ?? undefined, title: it.title, board: c?.board ?? it.board, lane: c?.lane ?? '', lane_since: it.since, blocked: c?.blocked };
    });
    await ctx.drillCards({ kicker: 'WHAT NEEDS A HUMAN', title: `${cards.length} waiting on you`, cards });
  } catch (e) {
    console.error('kpi decisions drill', e);
  } finally {
    btn.disabled = false;
  }
}

function kpiDecisionsRender(el, d, ctx) {
  const now = Date.now();
  const n = d.items.length;
  // needs-you waits + blocker waits overlapping the range vs the previous period; down is good
  const w = d.ranged;
  const waits = (r) => (r ? r.needsYou.count + r.blocked.count : null);
  const oldest = n ? `oldest ${mxWait(now - d.items[0].since)}` : null;
  // S: the age joins the status line (one line less: the tile fits its row with the chip wrapped)
  const S = ctx.size === 'S';
  const main = kpiMain(String(n), 'waiting on you', S ? null : (oldest ?? 'no blockers, no sessions waiting'), () => kpiDrillDecisions(ctx, d, main), KPI_DECISIONS_HINT);
  el.append(
    main,
    kpiDeltaRow(kpiPrevDelta(w, ctx, d.since, `Waits this period ${waits(w)}`, -1, String, waits(w), waits(w.previous)), 'waits this period'),
    n ? kpiStatus('warn', S ? `Needs you · ${oldest}` : 'Needs you') : kpiStatus('ok', 'All clear'),
  );
  if (d.stuck?.length) {
    const s = node('div', 'kpi-stuck', `${d.stuck.length} possibly stuck`);
    s.title = d.stuck.map((x) => `${x.title}: ${x.reason}`).join('\n');
    el.append(s);
  }
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

// ── throughput: "Last 7 days vs 4-wk average" (a trend: up is good; not throughput-trend's weekly chart) ──
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
    await ctx.drillCards({ kicker: 'THROUGHPUT · LAST 7 DAYS', title: `${mxPlural(cards.length, 'card')} done`, cards, range: `since ${kpiDay(mxDayKey(d.now - KPI_WEEK_MS, MX_LOCAL_TZ))}` });
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
  const chip = dwDeltaChip({
    subject: 'Cards done in the last 7 days',
    polarity: 1,
    fmt: (x) => mxNum(Math.round(x * 10) / 10),
    cur: last,
    prev: avg,
    has: prior.length > 0,
    label: `vs prior ${prior.length}-wk avg`,
    labelLong: `vs the prior ${prior.length}-week average`,
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
  throughput: { q: 'Last 7 days vs 4-wk average', load: kpiThroughputLoad, render: kpiThroughputRender },
};

dwRegister({
  type: 'kpi',
  title: (params) => KPI_METRICS[params.metric]?.q ?? '',
  sizes: ['S', 'M', 'L'],
  // schedule (forecast vs target) and throughput (its own rolling 7-day windows) ignore the range
  ranged: (params) => ['budget', 'decisions'].includes(params.metric ?? 'schedule'),
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
