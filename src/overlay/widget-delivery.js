// ── Dashboard widgets: Delivery (phase-health, forecast, milestones, scope-change, planned-delivered, gate-readiness, rag-trend) ──
// Each title states the question. Data: /metrics/schedule (phases with p50/p85/p95, target, status),
// (+ its milestones), /metrics/history (daily phase + milestone snapshots: the baseline is a phase's /
// milestone's first snapshot), /metrics/cost (budgets), /workspace/cards, /risks, /metrics/wait. Reads go through ctx.shared keyed by URL, so widgets (and the KPI tiles)
// asking for the same read in one cycle share it. Uses app.js globals read-only (node, svgEl, mx*,
// MX_MONTHS, MX_LOCAL_TZ). Status is always an icon + text, never colour alone; user strings go in
// via textContent. Schedule slip bands (the research doc): green within 5%, amber 6–15%, red over 15%.

const DL_DAY = 86_400_000;
const DL_NO_SNAP = 'No snapshots yet — history starts tomorrow';
const DL_STATES = {
  ok: '✓',
  warn: '!',
  bad: '✕',
  none: '–',
  done: '✓',
};
// a phase's RAG (report.ts's phaseRag, as the snapshots store it): label + status kind
const DL_RAG = {
  green: ['ok', 'On track'],
  amber: ['warn', 'At risk'],
  red: ['bad', 'Off track'],
  grey: ['none', 'No data'],
  done: ['done', 'Done'],
};
// Source of truth: src/core/report.ts RAG_OF + phaseRag (the snapshots' rag column uses them too).
const DL_RAG_OF = { on_track: 'green', at_risk: 'amber', late: 'red', complete: 'done', done: 'done', unknown: 'grey' };

// Home's filters (fbParams): the board in scope, the phase, the range (epoch ms).
function dlFilters(ctx) {
  const q = new URLSearchParams(ctx.filters);
  const get = (k) => q.get(k) || '';
  return { project: get('scope') || ctx.projectId, phase: get('phase'), from: get('from'), to: get('to') };
}

// GET path?params, deduped per refresh cycle by its URL; errors throw (the renderer's error state).
function dlGet(ctx, path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `${path}?${q}`;
  return ctx.shared(url, () => mxGet(url));
}
const dlSchedule = (ctx, f) => dlGet(ctx, '/metrics/schedule', { project: f.project, tz: MX_LOCAL_TZ });
const dlHistory = (ctx, f, phase) => dlGet(ctx, '/metrics/history', { project: f.project, phase });
const dlCost = (ctx, f) => dlGet(ctx, '/metrics/cost', { project: f.project, tz: MX_LOCAL_TZ, limit: 1 });
const dlCards = (ctx, f) => dlGet(ctx, '/workspace/cards', { project: f.project });

// The phase a single-phase widget answers for: Home's phase filter, else the board's active phase.
const dlPhase = (s, f) => (f.phase ? s.phases.find((p) => p.id === f.phase) : s.phases.find((p) => p.project_id === f.project && p.phase_status === 'active')) ?? null;

const dlDay = (day) => `${MX_MONTHS[mxUtc(day).getUTCMonth()]} ${mxUtc(day).getUTCDate()}`; // Oct 20
const dlDiff = (a, b) => (a && b ? Math.round((mxUtc(b) - mxUtc(a)) / DL_DAY) : null); // days from a to b
const dlSigned = (n, unit = ' d') => (n === 0 ? `±0${unit}` : `${n > 0 ? '+' : '−'}${Math.abs(n)}${unit}`);
const dlPct = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(Math.round(n))}%`;

// A status: icon + text (colour only reinforces).
function dlStatus(kind, text, cls = '') {
  const el = node('span', `dl-st dl-${kind}${cls ? ` ${cls}` : ''}`);
  const ico = node('span', 'dl-ico', DL_STATES[kind]);
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'dl-st-text', text));
  return el;
}
const dlRag = (rag, cls) => dlStatus(DL_RAG[rag][0], DL_RAG[rag][1], cls);

// THE phase RAG rule, used by every widget here: report.ts's phaseRag (src/core/report.ts RAG_OF /
// phaseRag are the source of truth) — the schedule status mapped, green → amber on an open blocker.
function dlPhaseRag(status, blockers) {
  const rag = DL_RAG_OF[status] ?? 'grey';
  return rag === 'green' && blockers > 0 ? 'amber' : rag;
}

// Open blockers per phase id, from /workspace/cards (blocked and not done).
function dlBlockers(cards) {
  const m = new Map();
  for (const cd of cards) if (cd.blocked && cd.lane !== 'done' && cd.phase_id) m.set(cd.phase_id, (m.get(cd.phase_id) ?? 0) + 1);
  return m;
}

// The day a done phase finished: no endpoint returns when a phase was marked done, so the day its
// last card reached done (lane_since) stands in — from then on its RAG is 'done' anyway (RAG_OF
// maps 'complete' to done). null when it has no done card.
function dlDoneDay(cards, phaseId) {
  let at = null;
  for (const cd of cards) if (cd.phase_id === phaseId && cd.lane === 'done' && cd.lane_since != null && (at === null || cd.lane_since > at)) at = cd.lane_since;
  return at === null ? null : mxDayKey(at, MX_LOCAL_TZ);
}

// Each phase's snapshots (history rows come ordered by date).
function dlSnapsByPhase(rows) {
  const m = new Map();
  for (const r of rows) {
    let list = m.get(r.phase_id);
    if (!list) m.set(r.phase_id, (list = []));
    list.push(r);
  }
  return m;
}

// p85 slip vs the baseline (first snapshot) as deltasSince computes it: null until two snapshot days.
// basis: the baseline's own forecast span (baseline day → its p85), the denominator of the slip %.
function dlSlip(snaps) {
  if (!snaps?.length) return { slip: null, basis: null, has: false };
  const base = snaps[0];
  const last = snaps[snaps.length - 1];
  if (base.date === last.date) return { slip: null, basis: null, has: true, single: true };
  const basis = dlDiff(base.date, base.p85);
  return { slip: dlDiff(base.p85, last.p85), basis: basis > 0 ? basis : null, has: true };
}

// Schedule slip band (research doc): later by ≤5% of the baseline span green, 6–15% amber, >15% red.
function dlSlipKind(slip, basis) {
  if (slip <= 0) return 'ok';
  if (!basis) return 'warn';
  const pct = Math.round((slip / basis) * 100);
  return pct <= 5 ? 'ok' : pct <= 15 ? 'warn' : 'bad';
}

// "▲ +3 d vs baseline" with its band (icon + text); null slip → a quiet reason.
function dlSlipChip(s, short = false) {
  if (!s.has || s.slip === null) {
    const text = !s.has ? 'No baseline' : s.single ? 'Baseline today' : '—';
    const el = node('span', 'dl-slip dl-none', text);
    el.title = !s.has ? DL_NO_SNAP : s.single ? 'Only one snapshot day so far: the comparison starts tomorrow' : 'The baseline or the latest snapshot has no p85 forecast';
    return el;
  }
  const kind = dlSlipKind(s.slip, s.basis);
  const pct = s.basis ? ` · ${dlPct((s.slip / s.basis) * 100)}` : '';
  const el = node('span', `dl-slip dl-${kind}`);
  const ico = node('span', 'dl-slip-arrow', s.slip > 0 ? '▲' : s.slip < 0 ? '▼' : '=');
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'dl-slip-val', `${dlSigned(s.slip)}${pct}`));
  if (!short) el.append(node('span', 'dl-slip-vs', 'vs baseline'));
  el.setAttribute('role', 'img');
  const verdict = kind === 'ok' ? 'within 5%' : kind === 'warn' ? '6 to 15%, at risk' : 'over 15%, off track';
  el.setAttribute('aria-label', s.slip === 0 ? 'p85 forecast on the baseline' : `p85 forecast ${mxPlural(Math.abs(s.slip), 'day')} ${s.slip > 0 ? 'later' : 'earlier'} than the baseline${s.slip > 0 ? `, ${verdict}` : ''}`);
  return el;
}

// The big headline: value (+ unit) over a quiet label.
function dlMain(value, unit, label) {
  const el = node('div', 'dl-main');
  const line = node('div', 'dl-line');
  line.append(node('span', 'dl-value', value));
  if (unit) line.append(node('span', 'dl-unit', unit));
  el.append(line);
  if (label) el.append(node('div', 'dl-label', label));
  return el;
}

// An HTML label placed at x% along a chart.
function dlAt(cls, text, pct) {
  const l = node('span', cls, text);
  l.style.left = `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`;
  return l;
}

// ── phase-health: "Which phases are on track?" ──
async function dlHealthLoad(ctx) {
  const f = dlFilters(ctx);
  const [s, h, c, cards] = await Promise.all([dlSchedule(ctx, f), dlHistory(ctx, f), dlCost(ctx, f), dlCards(ctx, f)]);
  const phases = f.phase ? s.phases.filter((p) => p.id === f.phase) : s.phases;
  if (!phases.length) return { empty: f.phase ? 'The filtered phase isn’t on this board' : 'No phases yet — plan a roadmap to see phase health' };
  const snaps = dlSnapsByPhase(h.phases);
  const budgets = new Map(c.budgets.map((b) => [b.phase_id, b]));
  const blockers = dlBlockers(cards.cards);
  const rows = phases.map((p) => ({
    p,
    rag: dlPhaseRag(p.status, blockers.get(p.id) ?? 0),
    blockers: blockers.get(p.id) ?? 0,
    slip: dlSlip(snaps.get(p.id)),
    budget: budgets.get(p.id) ?? null,
    cards: cards.cards.filter((cd) => cd.phase_id === p.id),
  }));
  return { rows };
}

function dlHealthS(el, rows) {
  const open = rows.filter((r) => r.rag !== 'done');
  const done = rows.length - open.length;
  if (!open.length) {
    el.append(dlMain(String(done), done === 1 ? 'phase done' : 'phases done', 'nothing open'), dlStatus('done', 'All phases done'));
    return;
  }
  const list = node('ul', 'dl-counts');
  for (const rag of ['red', 'amber', 'green', 'grey']) {
    const n = open.filter((r) => r.rag === rag).length;
    const li = node('li', `dl-count${n ? '' : ' dl-zero'}`);
    li.append(node('span', 'dl-count-n', String(n)), dlRag(rag));
    list.append(li);
  }
  el.append(list);
  if (done) el.append(node('div', 'dl-note', `${mxPlural(done, 'phase')} done`));
}

function dlBudgetCell(b) {
  const cell = node('span', 'dl-cell dl-c-budget');
  if (!b || b.budget === null) {
    cell.append(node('span', 'dl-dim', 'No budget'));
    return cell;
  }
  const [kind, text] = b.overBudget ? ['bad', 'Over'] : b.projectedOverBudget ? ['warn', 'Projected over'] : ['ok', 'Within'];
  cell.append(dlStatus(kind, text), node('span', 'dl-sub', `${mxMoney(b.actual)} of ${mxMoney(b.budget)}`));
  return cell;
}

function dlTargetCell(p) {
  const cell = node('span', 'dl-cell dl-c-target');
  if (p.phase_status === 'done' || p.status === 'complete') {
    cell.append(node('span', 'dl-dim', p.phase_status === 'done' ? 'Done' : 'All cards done'));
    return cell;
  }
  cell.append(node('span', 'dl-v', p.p85 ? dlDay(p.p85) : '—'));
  if (!p.target_date) cell.append(node('span', 'dl-sub', 'no target'));
  else if (!p.p85) cell.append(node('span', 'dl-sub', `target ${dlDay(p.target_date)} · no forecast`));
  else {
    const d = dlDiff(p.target_date, p.p85);
    cell.append(node('span', 'dl-sub', `target ${dlDay(p.target_date)} · ${d > 0 ? `${d} d over` : d === 0 ? 'on target' : `${-d} d spare`}`));
  }
  return cell;
}

function dlProgressCell(p) {
  const cell = node('span', 'dl-cell dl-c-prog');
  const done = p.total - p.remaining;
  cell.append(node('span', 'dl-v', `${done}/${p.total}`));
  const bar = node('span', 'dl-prog');
  bar.setAttribute('aria-hidden', 'true');
  const fill = node('span', 'dl-prog-fill');
  fill.style.width = `${p.total ? (done / p.total) * 100 : 0}%`;
  bar.append(fill);
  cell.append(bar);
  return cell;
}

function dlHealthRender(el, d, ctx) {
  if (ctx.size === 'S') return dlHealthS(el, d.rows);
  const wide = ctx.size === 'L' || ctx.size === 'XL';
  const rows = wide ? d.rows : d.rows.filter((r) => r.rag !== 'done');
  const table = node('div', `dl-ph dl-ph-${ctx.size}`);
  table.setAttribute('role', 'list');
  const head = node('div', 'dl-ph-head');
  head.setAttribute('aria-hidden', 'true');
  const cols = ['Phase', 'Status', 'p85 vs target', 'Slip vs baseline', ...(wide ? ['Budget'] : []), 'Done'];
  for (const c of cols) head.append(node('span', 'dl-ph-h', c));
  table.append(head);
  for (const r of rows) {
    const p = r.p;
    const item = node('div', 'dl-ph-li');
    item.setAttribute('role', 'listitem');
    const row = node(r.cards.length ? 'button' : 'div', 'dl-ph-row');
    item.append(row);
    if (r.cards.length) {
      row.type = 'button';
      row.title = `List the cards in ${p.title}`;
      row.onclick = () => ctx.drillCards({ kicker: `PHASE · ${p.title}`.toUpperCase(), title: mxPlural(r.cards.length, 'card'), cards: r.cards });
    }
    const name = node('span', 'dl-cell dl-c-name');
    name.append(node('span', 'dl-name', p.title));
    if (ctx.size === 'XL') {
      const sub = [p.reason, r.blockers ? mxPlural(r.blockers, 'open blocker') : null].filter(Boolean).join(' · ');
      if (sub) name.append(node('span', 'dl-sub dl-reason', sub));
    }
    const slip = node('span', 'dl-cell dl-c-slip');
    slip.append(dlSlipChip(r.slip, true)); // the column header says "vs baseline"
    row.append(name, dlRag(r.rag, 'dl-cell'), dlTargetCell(p), slip);
    if (wide) row.append(dlBudgetCell(r.budget));
    row.append(dlProgressCell(p));
    table.append(item);
  }
  el.append(table);
  const hidden = d.rows.length - rows.length;
  if (!rows.length) el.append(node('div', 'dl-note', 'All phases done'));
  else if (hidden) el.append(node('div', 'dl-note', `+ ${mxPlural(hidden, 'done phase')} (shown at L)`));
}

// ── forecast: "When will the active phase land?" ──
async function dlForecastLoad(ctx) {
  const f = dlFilters(ctx);
  const s = await dlSchedule(ctx, f);
  const phase = dlPhase(s, f);
  if (!phase) return { empty: 'No active phase to forecast' };
  if (phase.phase_status === 'done' || phase.status === 'complete') return { empty: `${phase.title}: every card is done` };
  if (!phase.target_date) return { empty: `Set a target date on ${phase.title} to forecast it` };
  if (!phase.p85) return { empty: `No forecast for ${phase.title}: ${phase.reason}` };
  const [h, cards] = await Promise.all([dlHistory(ctx, f, phase.id), dlCards(ctx, f)]);
  // the next milestone: the phase's own, else any on the board in scope
  const next = (list) => list.filter((m) => m.date >= s.today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  return {
    phase,
    today: s.today,
    rag: dlPhaseRag(phase.status, dlBlockers(cards.cards).get(phase.id) ?? 0),
    slip: dlSlip(h.phases),
    milestone: next(phase.milestones ?? []) ?? next(s.milestones),
  };
}

// p50 → p95 as a band on a day axis (today … the later of p95 / target), p85 a bar, the target a marker.
function dlRangeChart(p, today, large) {
  const end = [p.p95, p.target_date, p.p85].filter(Boolean).sort().pop();
  const span = Math.max(1, dlDiff(today, end) * 1.08);
  const x = (day) => (Math.max(0, dlDiff(today, day)) / span) * 100;
  const wrap = node('div', `dl-range${large ? ' dl-range-lg' : ''}`);
  const svg = svgEl('svg', { viewBox: '0 0 100 24', preserveAspectRatio: 'none', class: 'dl-range-svg', role: 'img' });
  svg.setAttribute('aria-label', `50% likely by ${dlDay(p.p50)}, 85% by ${dlDay(p.p85)}${p.p95 ? `, 95% by ${dlDay(p.p95)}` : ''}; target ${dlDay(p.target_date)}`);
  svg.append(svgEl('rect', { x: 0, y: 11, width: 100, height: 2, class: 'dl-r-track' }));
  svg.append(svgEl('rect', { x: x(p.p50), y: 6, width: Math.max(0.6, x(p.p95 ?? p.p85) - x(p.p50)), height: 12, rx: 0, class: 'dl-r-band' }));
  svg.append(svgEl('rect', { x: x(p.p85) - 0.5, y: 3, width: 1, height: 18, class: 'dl-r-p85' }));
  svg.append(svgEl('line', { x1: x(p.target_date), x2: x(p.target_date), y1: 0, y2: 24, class: 'dl-r-target', 'vector-effect': 'non-scaling-stroke' }));
  const top = node('div', 'dl-range-top');
  top.setAttribute('aria-hidden', 'true');
  top.append(dlAt('dl-range-lbl dl-range-tgt', `◆ target ${dlDay(p.target_date)}`, x(p.target_date)));
  const bot = node('div', 'dl-range-bot');
  bot.setAttribute('aria-hidden', 'true');
  bot.append(dlAt('dl-range-lbl dl-range-today', 'today', 0));
  const pts = [['p50', p.p50], ['p85', p.p85], ['p95', p.p95]].filter(([, v]) => v);
  for (const [k, v] of pts) bot.append(dlAt(`dl-range-lbl dl-range-${k}`, k, x(v)));
  wrap.append(top, svg, bot);
  return wrap;
}

function dlForecastRender(el, d, ctx) {
  const p = d.phase;
  el.append(dlMain(dlDay(p.p85), '85% likely', `${p.title} · target ${dlDay(p.target_date)}`));
  const st = node('div', 'dl-row');
  st.append(dlRag(d.rag), dlSlipChip(d.slip));
  el.append(st, dlRangeChart(p, d.today, ctx.size === 'L'));
  const pcts = node('div', 'dl-pcts');
  for (const [k, v] of [['p50', p.p50], ['p85', p.p85], ['p95', p.p95]]) {
    const c = node('div', 'dl-pct');
    const days = v ? dlDiff(d.today, v) : null;
    c.append(node('span', 'dl-k', k), node('span', 'dl-v', v ? dlDay(v) : '—'), node('span', 'dl-sub', days === null ? '' : days <= 0 ? 'today' : `in ${mxPlural(days, 'day')}`));
    pcts.append(c);
  }
  el.append(pcts);
  if (ctx.size !== 'L') return;
  // L: why (the schedule's reason) and the next commitment
  const det = node('div', 'dl-detail');
  const why = node('div', 'dl-fc-item');
  why.append(node('span', 'dl-k', 'Why'), node('span', 'dl-reason-l', p.reason));
  const ms = node('div', 'dl-fc-item');
  ms.append(node('span', 'dl-k', 'Next milestone'));
  const m = d.milestone;
  if (m) {
    const days = dlDiff(d.today, m.date);
    ms.append(node('span', 'dl-v', `${m.title} · ${dlDay(m.date)}`), node('span', 'dl-sub', days === 0 ? 'today' : `in ${mxPlural(days, 'day')}`));
  } else ms.append(node('span', 'dl-sub', 'none scheduled'));
  det.append(why, ms);
  el.append(det);
}

// ── milestones: "Which commitments moved?" ──
async function dlMilestonesLoad(ctx) {
  const f = dlFilters(ctx);
  const [s, h] = await Promise.all([dlSchedule(ctx, f), dlHistory(ctx, f)]);
  const ms = f.phase ? s.milestones.filter((m) => m.phase_id === f.phase) : s.milestones; // the same list GET /milestones returns
  if (!ms.length) return { empty: f.phase ? 'No milestones on this phase' : 'No milestones yet — add one on the Phases view' };
  const base = new Map(h.milestones.map((m) => [m.milestone_id, m.series[0]]));
  const phases = new Map(s.phases.map((p) => [p.id, p.title]));
  const rows = ms.map((m) => {
    const b = base.get(m.id);
    return { id: m.id, title: m.title, date: m.date, phase: phases.get(m.phase_id) ?? null, base: b ?? null, moved: b ? dlDiff(b.milestone_date, m.date) : null, past: m.date < s.today };
  });
  const upcoming = rows.filter((r) => !r.past).sort((a, b) => a.date.localeCompare(b.date));
  const past = rows.filter((r) => r.past).sort((a, b) => b.date.localeCompare(a.date));
  return { upcoming, past, today: s.today };
}

function dlMovedCell(r) {
  if (r.moved === null) {
    const el = node('span', 'dl-moved dl-dim', 'no baseline');
    el.title = DL_NO_SNAP;
    return el;
  }
  if (r.moved === 0) return node('span', 'dl-moved dl-dim', 'not moved');
  const el = node('span', `dl-moved dl-${r.moved > 0 ? 'bad' : 'ok'}`);
  const ico = node('span', 'dl-moved-ico', '⚑');
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'dl-moved-val', `moved ${dlSigned(r.moved)}`));
  el.title = `Was ${dlDay(r.base.milestone_date)} on ${dlDay(r.base.date)} (baseline)`;
  return el;
}

function dlMilestoneRow(r, today) {
  const li = node('li', `dl-ms${r.past ? ' dl-past' : ''}`);
  const date = node('span', 'dl-ms-date');
  const days = dlDiff(today, r.date);
  date.append(node('span', 'dl-v', dlDay(r.date)), node('span', 'dl-sub', r.past ? 'passed' : days === 0 ? 'today' : `in ${days} d`));
  const t = node('span', 'dl-ms-title');
  t.append(node('span', 'dl-name', r.title));
  if (r.phase) t.append(node('span', 'dl-sub', r.phase));
  li.append(date, t, dlMovedCell(r));
  return li;
}

function dlMilestonesRender(el, d, ctx) {
  const all = [...d.upcoming, ...d.past];
  const moved = all.filter((r) => r.moved);
  const hasBase = all.some((r) => r.moved !== null);
  el.append(
    hasBase
      ? moved.length
        ? dlStatus('warn', `${moved.length} of ${mxPlural(all.length, 'milestone')} moved since baseline`)
        : dlStatus('ok', `None of ${mxPlural(all.length, 'milestone')} moved since baseline`)
      : dlStatus('none', 'No baseline yet — history starts tomorrow'),
  );
  const nUp = ctx.size === 'L' ? 10 : 5;
  const nPast = ctx.size === 'L' ? 5 : 2;
  const list = node('ul', 'dl-ms-list');
  for (const r of d.upcoming.slice(0, nUp)) list.append(dlMilestoneRow(r, d.today));
  if (!d.upcoming.length) list.append(node('li', 'dl-note', 'Nothing upcoming'));
  if (d.past.length && nPast) {
    list.append(node('li', 'dl-ms-sep', 'Past'));
    for (const r of d.past.slice(0, nPast)) list.append(dlMilestoneRow(r, d.today));
  }
  el.append(list);
  const more = Math.max(0, d.upcoming.length - nUp) + Math.max(0, d.past.length - nPast);
  if (more) el.append(node('div', 'dl-note', `+ ${more} more`));
}

// ── scope-change: "Is the target moving?" ──
async function dlScopeLoad(ctx) {
  const f = dlFilters(ctx);
  const s = await dlSchedule(ctx, f);
  const phase = dlPhase(s, f);
  if (!phase) return { empty: 'No active phase to track' };
  const h = await dlHistory(ctx, f, phase.id);
  if (!h.phases.length) return { empty: DL_NO_SNAP };
  return { phase, snaps: h.phases, today: s.today };
}

// Scope band (default thresholds): a change within 5% of the baseline green, 6–15% amber, over 15% red.
function dlScopeKind(pct) {
  if (pct === null) return 'none';
  const a = Math.abs(Math.round(pct));
  return a <= 5 ? 'ok' : a <= 15 ? 'warn' : 'bad';
}

// Two lines over the snapshot days (+ today live): scope and done.
function dlScopeChart(points, tall) {
  const H = tall ? 90 : 48;
  const W = 300;
  const max = Math.max(1, ...points.map((p) => p.scope));
  const first = points[0].date;
  const span = Math.max(1, dlDiff(first, points[points.length - 1].date));
  const x = (day) => (dlDiff(first, day) / span) * W;
  const y = (v) => H - 3 - (v / max) * (H - 6);
  const line = (key) => points.map((p) => `${x(p.date).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const wrap = node('div', 'dl-chart');
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'dl-chart-svg', role: 'img' });
  svg.style.height = `${H}px`;
  const last = points[points.length - 1];
  svg.setAttribute('aria-label', `Scope from ${points[0].scope} to ${last.scope} cards, done from ${points[0].done} to ${last.done}, ${dlDay(first)} to ${dlDay(last.date)}`);
  svg.append(
    svgEl('polyline', { points: line('scope'), class: 'dl-l-scope', 'vector-effect': 'non-scaling-stroke' }),
    svgEl('polyline', { points: line('done'), class: 'dl-l-done', 'vector-effect': 'non-scaling-stroke' }),
  );
  const axis = node('div', 'dl-axis');
  axis.setAttribute('aria-hidden', 'true');
  axis.append(node('span', '', dlDay(first)), node('span', '', last.live ? 'today' : dlDay(last.date)));
  const legend = node('div', 'dl-legend');
  legend.append(node('span', 'dl-lg dl-lg-scope', `scope ${last.scope}`), node('span', 'dl-lg dl-lg-done', `done ${last.done}`));
  wrap.append(svg, axis, legend);
  return wrap;
}

function dlScopeRender(el, d, ctx) {
  const p = d.phase;
  const base = d.snaps[0];
  const abs = base.scope === null ? null : p.total - base.scope;
  const pct = abs === null || !base.scope ? null : (abs / base.scope) * 100;
  el.append(dlMain(abs === null ? '—' : dlSigned(abs, ''), abs === null ? '' : `cards${pct === null ? '' : ` · ${dlPct(pct)}`}`, `${p.title}: ${p.total} now vs ${base.scope ?? '—'} at baseline ${dlDay(base.date)}`));
  const kind = dlScopeKind(pct);
  const text = { ok: 'Steady: within 5%', warn: 'Moving: 6–15%', bad: 'Moving: over 15%', none: 'No baseline scope' }[kind];
  const st = node('div', 'dl-row');
  st.append(dlStatus(kind, text));
  if (ctx.size !== 'S') st.append(node('span', 'dl-sub', 'default thresholds'));
  el.append(st);
  if (ctx.size === 'S') return;
  const points = d.snaps.filter((r) => r.scope !== null).map((r) => ({ date: r.date, scope: r.scope, done: r.done ?? 0 }));
  const live = { date: d.today, scope: p.total, done: p.total - p.remaining, live: true };
  if (points.length && points[points.length - 1].date === d.today) points[points.length - 1] = live;
  else points.push(live);
  if (points.length < 2) return void el.append(node('div', 'dl-note', 'The trend appears after the second snapshot day'));
  el.append(dlScopeChart(points, ctx.size === 'L'));
}

// ── planned-delivered: "Do we deliver what we commit?" ──
// Planned: the phase's scope at its first snapshot. Done: its cards done now — which may include cards
// added after the baseline (the snapshots don't record which cards were planned), so the ratio is
// capped at 100% and the cards added since are shown separately.
async function dlPlannedLoad(ctx) {
  const f = dlFilters(ctx);
  const [s, h, cards] = await Promise.all([dlSchedule(ctx, f), dlHistory(ctx, f), dlCards(ctx, f)]);
  if (!h.phases.length) return { empty: DL_NO_SNAP };
  const snaps = dlSnapsByPhase(h.phases);
  // the board in scope's done phases, most recently finished first (dlDoneDay: no endpoint returns
  // when a phase was marked done); a phase with no done card sorts last, then by position
  const doneDay = new Map();
  for (const p of s.phases) if (p.phase_status === 'done' && p.project_id === f.project) doneDay.set(p.id, dlDoneDay(cards.cards, p.id) ?? '');
  const doneRecent = s.phases
    .filter((p) => doneDay.has(p.id))
    .sort((a, b) => doneDay.get(b.id).localeCompare(doneDay.get(a.id)) || b.position - a.position);
  const phase = dlPhase(s, f) ?? (f.phase ? null : doneRecent[0] ?? null);
  if (!phase) return { empty: 'No active or finished phase to compare' };
  const row = (p) => {
    const base = snaps.get(p.id)?.[0] ?? null;
    const planned = base?.scope ?? null;
    const delivered = p.total - p.remaining;
    return {
      p,
      planned,
      delivered,
      added: planned === null ? 0 : Math.max(0, p.total - planned),
      ratio: planned ? Math.min(1, delivered / planned) : null,
      since: base?.date ?? null,
      doneOn: doneDay.get(p.id) || null,
    };
  };
  return { head: row(phase), recent: doneRecent.filter((p) => p.id !== phase.id).slice(0, 4).map(row) };
}

// "5 done of 8 planned (+2 added since)"
const dlPlannedText = (r) => `${r.delivered} done of ${r.planned} planned${r.added ? ` (+${r.added} added since)` : ''}`;

function dlPlannedStatus(r) {
  if (r.ratio === null) return dlStatus('none', r.planned === null ? 'No baseline' : 'Nothing committed');
  const done = r.p.phase_status === 'done';
  return r.ratio >= 0.8 ? dlStatus('ok', done ? 'Delivered 80%+' : '80%+ so far') : dlStatus('warn', done ? 'Under 80%' : 'Under 80% so far');
}

function dlPlannedRender(el, d, ctx) {
  const r = d.head;
  if (r.planned === null) return { empty: `No snapshot of ${r.p.title} yet — history starts tomorrow` };
  el.append(
    dlMain(r.ratio === null ? '—' : `${Math.round(r.ratio * 100)}%`, 'of plan delivered', `${dlPlannedText(r)} · ${r.p.title}, baseline ${dlDay(r.since)}`),
    dlPlannedStatus(r),
  );
  if (ctx.size === 'S') return;
  const box = node('div', 'dl-detail');
  box.append(node('div', 'dl-k', 'Recently done phases'));
  if (!d.recent.length) box.append(node('div', 'dl-note', 'No other finished phases yet'));
  const list = node('ul', 'dl-pd-list');
  for (const x of d.recent) {
    const li = node('li', 'dl-pd');
    const name = node('span', 'dl-pd-name');
    name.append(node('span', 'dl-name', x.p.title), node('span', 'dl-sub', x.planned === null ? 'no baseline' : dlPlannedText(x)));
    li.append(name, node('span', 'dl-v', x.ratio === null ? '—' : `${Math.round(x.ratio * 100)}%`), dlPlannedStatus(x));
    list.append(li);
  }
  if (d.recent.length) box.append(list);
  el.append(box);
}

// ── gate-readiness: "Can this phase pass its gate?" ──
// High risk: likelihood × impact ≥ 15, open or mitigating, no mitigation written down.
const DL_HIGH_RISK = 15;
async function dlGateLoad(ctx) {
  const f = dlFilters(ctx);
  const s = await dlSchedule(ctx, f);
  const phase = dlPhase(s, f);
  if (!phase) return { empty: 'No active phase to check' };
  const [cards, risks, cost, wait] = await Promise.all([
    dlCards(ctx, f),
    dlGet(ctx, '/risks', { project: f.project, phase: phase.id }),
    dlCost(ctx, f),
    dlGet(ctx, '/metrics/wait', { project: f.project, tz: MX_LOCAL_TZ, phase: phase.id }),
  ]);
  const mine = cards.cards.filter((c) => c.phase_id === phase.id);
  const ids = new Set(mine.map((c) => c.id));
  const open = mine.filter((c) => c.lane !== 'done');
  const blocked = open.filter((c) => c.blocked);
  const high = risks.filter((r) => r.likelihood * r.impact >= DL_HIGH_RISK && (r.status === 'open' || r.status === 'mitigating') && !r.mitigation?.trim());
  const b = cost.budgets.find((x) => x.phase_id === phase.id) ?? null;
  const waiting = wait.waiting.needsYou.filter((n) => n.task_id && ids.has(n.task_id));
  const cardOf = (id) => mine.find((c) => c.id === id);
  const items = [
    {
      ok: mine.length > 0 && !open.length,
      label: 'All cards done',
      detail: mine.length ? `${mine.length - open.length} of ${mine.length} done` : 'No cards yet',
      list: open.map((c) => ({ text: c.title, card: c })),
    },
    {
      ok: !high.length,
      label: 'No unmitigated high risk',
      detail: high.length ? `${mxPlural(high.length, 'risk')} score ${DL_HIGH_RISK}+ with no mitigation` : `${mxPlural(risks.length, 'linked risk')}, none high and unmitigated`,
      list: high.map((r) => ({ text: `${r.title} · score ${r.likelihood * r.impact}` })),
    },
    {
      ok: !b?.overBudget,
      label: 'Budget not over',
      detail: !b || b.budget === null ? 'No budget set' : `${mxMoney(b.actual)} of ${mxMoney(b.budget)}${b.overBudget ? '' : b.projectedOverBudget ? ' · projected over' : ''}`,
      list: [],
    },
    {
      ok: !blocked.length,
      label: 'No open blockers',
      detail: blocked.length ? `${mxPlural(blocked.length, 'blocked card')}` : 'Nothing blocked',
      list: blocked.map((c) => ({ text: c.title, card: c })),
    },
    {
      ok: !waiting.length,
      label: 'No decisions waiting on you',
      detail: waiting.length ? `${mxPlural(waiting.length, 'session')} waiting on a human` : 'No session on this phase’s cards is waiting',
      list: waiting.map((n) => ({ text: n.reason ? `${cardOf(n.task_id)?.title ?? n.task_id}: ${n.reason}` : (cardOf(n.task_id)?.title ?? n.task_id), card: cardOf(n.task_id) })),
    },
  ];
  return { phase, items };
}

function dlGateRender(el, d, ctx) {
  const failed = d.items.filter((i) => !i.ok).length;
  const head = node('div', 'dl-gate-head');
  head.append(failed ? dlStatus('bad', 'Hold', 'dl-verdict') : dlStatus('ok', 'Go', 'dl-verdict'), node('span', 'dl-sub', failed ? `${failed} of ${d.items.length} checks open · ${d.phase.title}` : `all ${d.items.length} checks pass · ${d.phase.title}`));
  el.append(head);
  const list = node('ul', 'dl-gate');
  for (const it of d.items) {
    const li = node('li', `dl-gate-item${it.ok ? '' : ' dl-fail'}`);
    const line = node('div', 'dl-gate-line');
    line.append(dlStatus(it.ok ? 'ok' : 'bad', it.ok ? 'Pass' : 'Fail', 'dl-gate-st'), node('span', 'dl-name', it.label), node('span', 'dl-sub', it.detail));
    li.append(line);
    if (ctx.size === 'L' && !it.ok && it.list.length) {
      const sub = node('ul', 'dl-gate-sub');
      for (const x of it.list.slice(0, 4)) {
        const sli = node('li');
        if (x.card) {
          const btn = node('button', 'dl-link', x.text);
          btn.type = 'button';
          btn.title = 'Open the card';
          btn.onclick = () => ctx.openCard(x.card.id, x.card.board);
          sli.append(btn);
        } else sli.append(node('span', 'dl-dim', x.text));
        sub.append(sli);
      }
      if (it.list.length > 4) sub.append(node('li', 'dl-dim', `+ ${it.list.length - 4} more`));
      li.append(sub);
    }
    list.append(li);
  }
  el.append(list);
}

// ── rag-trend: "Is health getting better or worse?" ──
async function dlTrendLoad(ctx) {
  const f = dlFilters(ctx);
  const [s, h, cards] = await Promise.all([dlSchedule(ctx, f), dlHistory(ctx, f), dlCards(ctx, f)]);
  if (!h.phases.length) return { empty: DL_NO_SNAP };
  // Home's range (epoch ms) as local days; the history rows are filtered here so one read serves all
  const from = f.from ? mxDayKey(Number(f.from), MX_LOCAL_TZ) : '';
  const to = f.to ? mxDayKey(Number(f.to), MX_LOCAL_TZ) : '';
  const rows = h.phases.filter((r) => (!from || r.date >= from) && (!to || r.date <= to) && (!f.phase || r.phase_id === f.phase));
  if (!rows.length) return { empty: 'No snapshots in this range — widen the range to see the trend' };
  const by = dlSnapsByPhase(rows);
  const order = new Map(s.phases.map((p, i) => [p.id, i]));
  const titles = new Map(s.phases.map((p) => [p.id, p.title]));
  // done phases: phase_status is the phases.status column (what GET /phases reports; the schedule's
  // list also covers a workspace's verticals). From its done day on, a done phase reads "Done", not
  // "On track" (snapshots store a done phase as green); no done card → only its latest day.
  const isDone = new Set(s.phases.filter((p) => p.phase_status === 'done').map((p) => p.id));
  const phases = [...by.keys()]
    .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
    .map((id) => {
      const days = new Map();
      const jumps = new Set();
      let prev = null;
      const snaps = by.get(id);
      const doneFrom = isDone.has(id) ? (dlDoneDay(cards.cards, id) ?? snaps.at(-1).date) : null;
      for (const r of snaps) {
        const rag = doneFrom && r.date >= doneFrom ? 'done' : (r.rag ?? 'grey');
        days.set(r.date, rag);
        if (rag === 'red' && prev === 'green') jumps.add(r.date); // green → red with no amber day between
        if (rag !== 'grey') prev = rag;
      }
      return { id, title: titles.get(id) ?? 'Removed phase', days, jumps, now: isDone.has(id) ? 'done' : (snaps.at(-1).rag ?? 'grey') };
    });
  const dates = rows.map((r) => r.date).sort();
  return { phases, first: dates[0], last: dates[dates.length - 1] };
}

const DL_TREND_DAYS = { M: 14, L: 45 };
function dlTrendRender(el, d, ctx) {
  const n = Math.min(DL_TREND_DAYS[ctx.size] ?? 14, dlDiff(d.first, d.last) + 1);
  const start = mxAddDays(d.last, -(n - 1));
  const days = Array.from({ length: n }, (_, i) => mxAddDays(start, i));
  const grid = node('div', 'dl-trend');
  grid.style.setProperty('--n', String(n));
  const jumps = [];
  for (const p of d.phases) {
    const row = node('div', 'dl-tr-row');
    const name = node('span', 'dl-tr-name', p.title);
    name.title = p.title;
    const strip = node('span', 'dl-tr-strip');
    strip.setAttribute('role', 'img');
    const counts = { green: 0, amber: 0, red: 0, done: 0 };
    for (const day of days) {
      const rag = p.days.get(day);
      const jump = p.jumps.has(day);
      const cell = node('span', `dl-tc dl-tc-${rag ?? 'missing'}${jump ? ' dl-tc-jump' : ''}`, rag ? (jump ? '↓' : DL_STATES[DL_RAG[rag][0]]) : '');
      cell.title = `${dlDay(day)}: ${rag ? DL_RAG[rag][1] : 'no snapshot'}${jump ? ' — straight from on track to off track' : ''}`;
      if (rag in counts) counts[rag]++;
      if (jump) jumps.push(`${p.title} on ${dlDay(day)}`);
      strip.append(cell);
    }
    strip.setAttribute('aria-label', `${p.title}, last ${mxPlural(n, 'day')}: ${counts.green} on track, ${counts.amber} at risk, ${counts.red} off track${counts.done ? `, ${counts.done} done` : ''}${p.jumps.size ? ', jumped straight to red' : ''}`);
    row.append(name, strip, dlRag(p.now, 'dl-tr-now'));
    grid.append(row);
  }
  const axis = node('div', 'dl-tr-axis');
  axis.setAttribute('aria-hidden', 'true');
  axis.append(node('span', '', dlDay(days[0])), node('span', '', dlDay(days[days.length - 1])));
  grid.append(axis);
  el.append(grid);
  if (jumps.length) {
    const j = node('div', 'dl-jumps');
    j.append(dlStatus('bad', `Straight to red: ${jumps.slice(0, 3).join(', ')}${jumps.length > 3 ? ` +${jumps.length - 3}` : ''}`));
    el.append(j);
  }
  if (ctx.size === 'L') {
    const legend = node('div', 'dl-tr-legend');
    for (const rag of ['green', 'amber', 'red', 'grey', 'done']) legend.append(dlRag(rag));
    const jl = node('span', 'dl-st dl-bad');
    const ico = node('span', 'dl-ico', '↓');
    ico.setAttribute('aria-hidden', 'true');
    jl.append(ico, node('span', 'dl-st-text', 'Jumped to red'));
    legend.append(jl);
    el.append(legend);
  }
}

// ── registration ──
// A load may return { empty } (nothing to show, with the reason); render passes it on.
// ranged false: the load never reads the range (schedule / history / cards / budgets are all-time).
function dlRegister(type, title, sizes, load, render, ranged = true) {
  dwRegister({
    type,
    title,
    sizes,
    ranged,
    load,
    render(el, data, ctx) {
      if (data.empty) return { empty: data.empty };
      const box = node('div', `dl dl-${type}`);
      el.append(box);
      return render(box, data, ctx);
    },
  });
}

dlRegister('phase-health', 'Which phases are on track?', ['S', 'M', 'L', 'XL'], dlHealthLoad, dlHealthRender, false);
dlRegister('forecast', 'When will the active phase land?', ['M', 'L'], dlForecastLoad, dlForecastRender, false);
dlRegister('milestones', 'Which commitments moved?', ['M', 'L'], dlMilestonesLoad, dlMilestonesRender, false);
dlRegister('scope-change', 'Is the target moving?', ['S', 'M', 'L'], dlScopeLoad, dlScopeRender, false);
dlRegister('planned-delivered', 'Do we deliver what we commit?', ['S', 'M'], dlPlannedLoad, dlPlannedRender, false);
dlRegister('gate-readiness', 'Can this phase pass its gate?', ['M', 'L'], dlGateLoad, dlGateRender, false);
dlRegister('rag-trend', 'Is health getting better or worse?', ['M', 'L'], dlTrendLoad, dlTrendRender);
