// ── Dashboard widgets: Flow (cycle-breakdown, wip, review-queue, throughput-trend, escalation) ──
// Each title states the question. Uses app.js globals read-only (node, svgEl, mx*, MX_LOCAL_TZ,
// EMBED, openSettings) and dashboard.js's dwRegister / dwDeltaChip / dwPrevDays. Status is always an
// icon + text, never colour alone; charts are inline SVG; every user string goes in as text.

const FW_ICONS = { ok: '✓', warn: '!', none: '–' };
// the in-flight stages, in cycle order (the Metrics CFD's lane hues); blocked is NOT one of them:
// blocked time overlaps the lane it happened in, so it's always shown apart, never stacked
const FW_STAGES = [
  { k: 'queued', name: 'Queued', color: '#61afef' },
  { k: 'in_progress', name: 'Building', color: '#5dd3a8' },
  { k: 'in_review', name: 'In review', color: '#e5c07b' },
];
const FW_BLOCKED = '#e06c75';
// work types in legend order, each with the board chips' hue (styles.css .wt-*)
const FW_TYPES = [
  { k: 'feature', name: 'Feature', color: '#8bb8e8' },
  { k: 'defect', name: 'Defect', color: '#e89297' },
  { k: 'debt', name: 'Debt', color: '#d6b878' },
  { k: 'risk', name: 'Risk', color: '#c7a2e3' },
  { k: 'none', name: 'Unclassified', color: '#5b6275' },
];
const FW_WIP_LANES = [
  { k: 'in_progress', name: 'Building' },
  { k: 'in_review', name: 'In review' },
];

// Home's filters (fbParams: scope / phase / tag / agent / workType / from / to as epoch ms).
function fwFilters(ctx) {
  const q = new URLSearchParams(ctx.filters);
  const get = (k) => q.get(k) || '';
  return { project: get('scope') || ctx.projectId, phase: get('phase'), tag: get('tag'), agent: get('agent'), workType: get('workType'), from: get('from'), to: get('to') };
}

// GET path?params, deduped per refresh cycle by its URL; errors throw (the renderer's error state).
function fwGet(ctx, path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `${path}?${q}`;
  return ctx.shared(url, () => mxGet(url));
}

// One ranged /metrics/flow read with the previous period, shared by cycle-breakdown,
// throughput-trend and escalation (same URL → one fetch per refresh cycle).
function fwFlow(ctx) {
  const f = fwFilters(ctx);
  return fwGet(ctx, '/metrics/flow', { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: f.from, to: f.to, compare: 'previous' });
}

// The board's stuck thresholds + WIP limits.
const fwSettings = (ctx, board) => fwGet(ctx, `/project/${encodeURIComponent(board)}/settings`, {});

function fwStatus(kind, text) {
  const el = node('div', `fw-status fw-${kind}`);
  const ico = node('span', 'fw-ico', FW_ICONS[kind]);
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'fw-status-text', text));
  return el;
}

// The headline: a big value (+ unit) over a quiet label.
function fwMain(value, unit, label) {
  const el = node('div', 'fw-main');
  const line = node('span', 'fw-line');
  line.append(node('span', 'fw-value', value));
  if (unit) line.append(node('span', 'fw-unit', unit));
  el.append(line);
  if (label) el.append(node('span', 'fw-label', label));
  return el;
}

// A period-over-period chip for a compare=previous read r ("vs prev 14 d"; grey for all time).
function fwPrevChip(r, subject, polarity, fmt, cur, prev, short = false) {
  const days = dwPrevDays(r.previousWindow);
  return dwDeltaChip({
    cur,
    prev,
    polarity,
    fmt,
    subject,
    has: !!r.previous,
    label: short ? '' : `vs prev ${days} d`,
    labelLong: `vs the previous ${days} days`,
    none: short ? '—' : undefined,
  });
}

function fwDeltaRow(chip, caption) {
  const row = node('div', 'fw-delta-row');
  if (caption) row.append(node('span', 'fw-delta-cap', caption));
  row.append(chip);
  return row;
}

const fwSwatch = (color) => {
  const s = node('span', 'fw-sw');
  s.style.background = color;
  s.setAttribute('aria-hidden', 'true');
  return s;
};

// An SVG that stretches to its box (rects only: no text, so a non-uniform scale is fine).
function fwSvg(w, h, cls, label) {
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', class: cls });
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  return svg;
}

// ── cycle-breakdown: "Where does the time go?" ──
// Stacked p50 time per stage (queued / building / in review) of the cards done in range; blocked
// time overlaps those stages, so it's its own bar below on the same scale ("of which blocked").
function fwStageBar(times, label) {
  const total = FW_STAGES.reduce((s, st) => s + (times[st.k] ?? 0), 0);
  const svg = fwSvg(100, 10, 'fw-stage-svg', label);
  svg.append(svgEl('rect', { x: 0, y: 0, width: 100, height: 10, fill: 'rgba(255,255,255,0.06)' }));
  let x = 0;
  for (const st of FW_STAGES) {
    const w = total ? ((times[st.k] ?? 0) / total) * 100 : 0;
    if (w > 0) svg.append(svgEl('rect', { x: x.toFixed(2), y: 0, width: Math.max(0.4, w - 0.4).toFixed(2), height: 10, fill: st.color }));
    x += w;
  }
  return { svg, total };
}

function fwBlockedBar(blocked, scale) {
  const svg = fwSvg(100, 10, 'fw-blocked-svg');
  svg.append(svgEl('rect', { x: 0, y: 0, width: 100, height: 10, fill: 'rgba(255,255,255,0.04)' }));
  const w = scale ? Math.min(100, ((blocked ?? 0) / scale) * 100) : 0;
  if (w > 0) svg.append(svgEl('rect', { x: 0, y: 0, width: Math.max(0.6, w).toFixed(2), height: 10, fill: FW_BLOCKED, 'fill-opacity': 0.75 }));
  return svg;
}

function fwStageLabel(pct, times) {
  return `${pct} time per stage: ${FW_STAGES.map((st) => `${st.name} ${mxSpan(times[st.k])}`).join(', ')}; of which blocked ${mxSpan(times.blocked)} (overlapping those stages)`;
}

// One labelled bar block: "p50" bar, then the blocked bar on the same scale.
function fwStageBlock(pct, times, ctx) {
  const box = node('div', 'fw-stage-block');
  const { svg, total } = fwStageBar(times, fwStageLabel(pct, times));
  const head = node('div', 'fw-stage-head');
  head.append(node('span', 'fw-k', `${pct} per stage`), node('span', 'fw-stage-sum', `${mxSpan(total)} in stages`));
  box.append(head, svg);
  const b = node('div', 'fw-blocked');
  const txt = node('span', 'fw-blocked-text');
  txt.append(fwSwatch(FW_BLOCKED), node('span', '', `of which blocked ${mxSpan(times.blocked)}`));
  if (ctx.size === 'L') txt.append(node('span', 'fw-dim', '\u00a0· overlaps the stages above'));
  b.append(fwBlockedBar(times.blocked, total), txt);
  box.append(b);
  return box;
}

async function fwCycleLoad(ctx) {
  const flow = await fwFlow(ctx);
  if (!flow.throughput.total) return { empty: 'No cards done in this range, so there is no cycle time to break down' };
  return { flow };
}

function fwCycleRender(el, d, ctx) {
  const r = d.flow;
  const sb = r.stageBreakdown;
  const n = r.throughput.total;
  el.append(fwMain(mxSpan(r.cycleTime.p50), 'p50 cycle', `${mxPlural(n, 'card')} done · queued → done`));
  el.append(fwDeltaRow(fwPrevChip(r, 'p50 cycle time', -1, mxSpan, r.cycleTime.p50, r.previous?.cycleTime?.p50 ?? null)));
  el.append(fwStageBlock('p50', sb.p50, ctx));
  const prevSb = r.previous?.stageBreakdown?.p50 ?? null;
  // the stage legend: name + p50 (L: + p85, and per-stage deltas when the previous period has them)
  const table = node('div', `fw-legend-grid${ctx.size === 'L' ? ' fw-legend-l' : ''}`);
  if (ctx.size === 'L') {
    const days = dwPrevDays(r.previousWindow);
    table.append(node('span', 'fw-k', 'Stage'), node('span', 'fw-k fw-num', 'p50'), node('span', 'fw-k fw-num', 'p85'), node('span', 'fw-k', prevSb ? `vs prev ${days} d` : ''));
  }
  for (const st of FW_STAGES) {
    const name = node('span', 'fw-lg-name');
    name.append(fwSwatch(st.color), node('span', '', st.name));
    table.append(name, node('span', 'fw-num', mxSpan(sb.p50[st.k])));
    if (ctx.size === 'L') {
      table.append(node('span', 'fw-num fw-dim', mxSpan(sb.p85[st.k])));
      table.append(prevSb ? fwPrevChip(r, `${st.name} p50`, -1, mxSpan, sb.p50[st.k], prevSb[st.k], true) : node('span'));
    }
  }
  el.append(table);
  if (ctx.size === 'L') el.append(fwStageBlock('p85', sb.p85, ctx));
}

// ── wip: "Are we overloaded?" ──
// Now (no range, board-wide: a WIP limit is the board's) vs the board's WIP limits.
async function fwWipLoad(ctx) {
  const f = fwFilters(ctx);
  const [sum, settings] = await Promise.all([fwGet(ctx, '/metrics/summary', { project: f.project, tz: MX_LOCAL_TZ }), fwSettings(ctx, f.project)]);
  const wip = sum.wip;
  if (!sum.cards && !Object.values(wip).some(Boolean)) return { empty: 'No cards on this board yet' };
  return { wip, limits: settings.wip };
}

function fwSettingsHint(text) {
  const hint = node('div', 'fw-hint');
  if (!EMBED && typeof openSettings === 'function') {
    const btn = node('button', 'fw-link', text);
    btn.type = 'button';
    btn.title = 'Open Settings → Board';
    btn.onclick = () => openSettings('board');
    hint.append(btn);
  } else hint.append(node('span', '', text));
  return hint;
}

function fwWipRender(el, d, ctx) {
  const lanes = FW_WIP_LANES.map((l) => {
    const n = d.wip[l.k] ?? 0;
    const limit = d.limits?.[l.k] ?? null;
    return { ...l, n, limit, over: limit !== null && n > limit };
  });
  const anyLimit = lanes.some((l) => l.limit !== null);
  const over = lanes.filter((l) => l.over);
  const rows = node('div', 'fw-wip');
  for (const l of lanes) {
    const row = node('div', `fw-wip-row${l.over ? ' fw-over' : ''}`);
    const head = node('div', 'fw-wip-head');
    const val = node('span', 'fw-wip-val');
    val.append(node('span', 'fw-wip-n', String(l.n)), node('span', 'fw-wip-lim', l.limit === null ? ' · no limit' : ` / ${l.limit}`));
    head.append(node('span', 'fw-wip-name', l.name), val);
    row.append(head);
    if (ctx.size === 'M') {
      const scale = Math.max(l.n, l.limit ?? 0, 1) * 1.1;
      const label = `${l.name}: ${l.n} card${l.n === 1 ? '' : 's'}${l.limit === null ? ', no limit' : `, limit ${l.limit}${l.over ? ', over the limit' : ''}`}`;
      const svg = fwSvg(100, 10, 'fw-wip-svg', label);
      svg.append(svgEl('rect', { x: 0, y: 0, width: 100, height: 10, fill: 'rgba(255,255,255,0.06)' }));
      if (l.n) svg.append(svgEl('rect', { x: 0, y: 0, width: ((l.n / scale) * 100).toFixed(2), height: 10, fill: l.over ? '#e5c07b' : l.limit === null ? '#8b93a7' : '#5dd3a8' }));
      if (l.limit !== null) svg.append(svgEl('rect', { x: ((l.limit / scale) * 100 - 0.4).toFixed(2), y: 0, width: 0.8, height: 10, fill: '#e8eaf0' }));
      row.append(svg);
    }
    rows.append(row);
  }
  el.append(rows);
  if (over.length) el.append(fwStatus('warn', `Over limit: ${over.map((l) => l.name).join(', ')}`));
  else if (anyLimit) el.append(fwStatus('ok', 'Within limits'));
  else {
    el.append(fwStatus('none', 'No limit set'));
    el.append(fwSettingsHint(ctx.size === 'S' ? 'Set limits in Settings' : 'Set WIP limits in Settings → Board'));
  }
  if (ctx.size === 'M') el.append(node('div', 'fw-foot', 'Cards in each lane now, board-wide'));
}

// ── review-queue: "Is review the bottleneck?" ──
// Cards in review now, oldest first; past the board's stuck_hours.in_review is amber.
async function fwReviewLoad(ctx) {
  const params = fbNoRange(ctx.filters);
  const url = `/workspace/cards?project=${encodeURIComponent(ctx.projectId)}${params ? `&${params}` : ''}`;
  const r = await ctx.shared(url, () => mxGet(url));
  const cards = r.cards.filter((c) => c.lane === 'in_review');
  if (!cards.length) return { empty: 'Nothing is waiting for review right now' };
  const boards = [...new Set(cards.map((c) => c.board))];
  const settings = await Promise.all(boards.map((b) => fwSettings(ctx, b)));
  const hours = new Map(boards.map((b, i) => [b, settings[i].stuck_hours.in_review]));
  const now = Date.now();
  const items = cards
    .map((c) => {
      const age = Math.max(0, now - (c.lane_since ?? now));
      const limitH = hours.get(c.board);
      return { id: c.id, board: c.board, title: c.title, age, limitH, stuck: age > limitH * 3_600_000 };
    })
    .sort((a, b) => b.age - a.age); // oldest first
  return { items };
}

function fwReviewRender(el, d, ctx) {
  const items = d.items;
  const ages = items.map((i) => i.age).sort((a, b) => a - b);
  const median = ages[Math.ceil(ages.length / 2) - 1];
  const stuck = items.filter((i) => i.stuck);
  el.append(fwMain(String(items.length), 'in review', `median age ${mxWait(median)} · oldest ${mxWait(items[0].age)}`));
  const limits = [...new Set(items.map((i) => i.limitH))];
  const past = limits.length === 1 ? `past ${mxNum(limits[0])}h` : 'past the stuck threshold';
  el.append(stuck.length ? fwStatus('warn', `${stuck.length} ${past}`) : fwStatus('ok', ctx.size === 'S' ? 'None stuck' : `None ${past}`));
  if (ctx.size === 'S') return;
  const list = node('ul', 'fw-list');
  const max = ctx.size === 'L' ? 10 : 4;
  for (const it of items.slice(0, max)) {
    const li = node('li');
    const row = node('button', `fw-item${it.stuck ? ' fw-over' : ''}`);
    row.type = 'button';
    row.title = 'Open the card';
    row.onclick = () => ctx.openCard(it.id, it.board);
    const age = node('span', 'fw-item-age');
    if (it.stuck) {
      const ico = node('span', 'fw-ico fw-ico-sm', FW_ICONS.warn);
      ico.setAttribute('aria-hidden', 'true');
      age.append(ico);
    }
    age.append(node('span', '', it.stuck ? `${mxWait(it.age)} · stuck` : mxWait(it.age)));
    row.append(node('span', 'fw-item-title', it.title), age);
    li.append(row);
    list.append(li);
  }
  el.append(list);
  if (items.length > max) el.append(node('div', 'fw-foot', `+ ${items.length - max} more in review`));
}

// ── throughput-trend: "Is delivery speeding up?" ──
// Weekly done bars over the range (ISO weeks, the window's cut weeks marked partial), stacked by
// work type: flow's points joined to the cards' work_type (a point with no card left: unclassified).
async function fwTrendLoad(ctx) {
  const params = ctx.filters;
  const url = `/workspace/cards?project=${encodeURIComponent(ctx.projectId)}${params ? `&${params}` : ''}`;
  const [flow, cards] = await Promise.all([fwFlow(ctx), ctx.shared(url, () => mxGet(url))]);
  if (!flow.throughput.total) return { empty: 'No cards done in this range' };
  const typeOf = new Map(cards.cards.map((c) => [c.id, c.work_type ?? 'none']));
  const tz = MX_LOCAL_TZ;
  const first = mxDayKey(flow.range.from, tz);
  const last = mxDayKey(flow.range.to, tz);
  const weeks = flow.throughput.weekly.map((w) => {
    const end = mxAddDays(w.start, 6);
    return { start: w.start, end, count: w.count, partial: w.start < first || end > last, byType: Object.fromEntries(FW_TYPES.map((t) => [t.k, 0])) };
  });
  for (const p of flow.points) {
    const day = mxDayKey(p.doneAt, tz);
    const w = weeks.find((x) => day >= x.start && day <= x.end);
    if (w) w.byType[typeOf.get(p.id) ?? 'none']++;
  }
  return { flow, weeks };
}

function fwTrendRender(el, d, ctx) {
  const r = d.flow;
  const weeks = d.weeks;
  const full = weeks.filter((w) => !w.partial);
  const avg = full.length ? full.reduce((s, w) => s + w.count, 0) / full.length : null;
  el.append(fwMain(String(r.throughput.total), 'done', avg === null ? 'no complete week in range' : `avg ${mxNum(Math.round(avg * 10) / 10)} / week over ${mxPlural(full.length, 'full week')}`));
  el.append(fwDeltaRow(fwPrevChip(r, 'Cards done', 1, (x) => mxNum(Math.round(x * 10) / 10), r.throughput.total, r.previous?.throughput ?? null)));

  // bars: one 10-unit slot per week (the HTML label rows below use the same equal columns)
  const SLOT = 10;
  const H = 100;
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const yOf = (v) => (v / max) * (H - 4);
  const summary = weeks.map((w) => `week of ${mxShortDay(w.start)}: ${w.count}${w.partial ? ' (partial week)' : ''}`).join(', ');
  const chart = node('div', 'fw-tt');
  chart.style.setProperty('--n', String(weeks.length));
  const svg = fwSvg(weeks.length * SLOT, H, 'fw-tt-svg', `Cards done per week, by work type: ${summary}`);
  weeks.forEach((w, i) => {
    const g = svgEl('g', w.partial ? { 'fill-opacity': 0.45 } : {});
    const t = svgEl('title');
    const parts = FW_TYPES.filter((ty) => w.byType[ty.k]).map((ty) => `${ty.name} ${w.byType[ty.k]}`);
    t.textContent = `Week of ${mxShortDay(w.start)}: ${w.count} done${w.partial ? ' (partial week)' : ''}${parts.length ? ` · ${parts.join(', ')}` : ''}`;
    g.append(t);
    const x = i * SLOT + SLOT * 0.18;
    const bw = SLOT * 0.64;
    if (!w.count) g.append(svgEl('rect', { x, y: H - 1, width: bw, height: 1, fill: 'rgba(255,255,255,0.18)' }));
    let y = H;
    for (const ty of FW_TYPES) {
      const v = w.byType[ty.k];
      if (!v) continue;
      const h = yOf(v);
      y -= h;
      g.append(svgEl('rect', { x, y: y.toFixed(2), width: bw, height: Math.max(0.5, h - 0.6).toFixed(2), fill: ty.color }));
    }
    svg.append(g);
  });
  if (ctx.size === 'XL' && avg !== null) {
    const ya = (H - yOf(avg)).toFixed(2);
    svg.append(svgEl('line', { x1: 0, x2: weeks.length * SLOT, y1: ya, y2: ya, stroke: '#e8eaf0', 'stroke-opacity': 0.55, 'stroke-width': 1, 'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke' }));
  }
  chart.append(svg);
  if (ctx.size === 'XL') {
    const vals = node('div', 'fw-tt-row fw-tt-vals');
    for (const w of weeks) vals.append(node('span', w.partial ? 'fw-dim' : '', String(w.count)));
    chart.append(vals);
  }
  const every = Math.max(1, Math.ceil(weeks.length / (ctx.size === 'M' ? 4 : ctx.size === 'L' ? 6 : 10)));
  const xs = node('div', 'fw-tt-row fw-tt-x');
  xs.setAttribute('aria-hidden', 'true');
  weeks.forEach((w, i) => xs.append(node('span', '', i % every === 0 ? mxShortDay(w.start) : '')));
  chart.append(xs);
  el.append(chart);

  const legend = node('div', 'fw-legend');
  for (const ty of FW_TYPES) {
    const n = r.throughputByWorkType[ty.k] ?? 0;
    if (!n) continue;
    const it = node('span', 'fw-lg');
    it.append(fwSwatch(ty.color), node('span', '', `${ty.name} ${n}`));
    legend.append(it);
  }
  if (weeks.some((w) => w.partial)) legend.append(node('span', 'fw-lg fw-dim', 'faded: partial week'));
  if (ctx.size === 'XL' && avg !== null) legend.append(node('span', 'fw-lg fw-dim', `dashed: avg ${mxNum(Math.round(avg * 10) / 10)} / full week`));
  el.append(legend);
}

// ── escalation: "How often do agents need a human?" ──
// Blockers (raised or open in range) per card done in range, and the median time to resolve one.
const fwRatio = (x) => String(Math.round(x * 100) / 100);

async function fwEscalationLoad(ctx) {
  const f = fwFilters(ctx);
  const [flow, wait] = await Promise.all([
    fwFlow(ctx),
    fwGet(ctx, '/metrics/wait', { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, workType: f.workType, from: f.from, to: f.to, compare: 'previous' }),
  ]);
  if (!flow.throughput.total && !wait.blocked.count) return { empty: 'No cards done and no blockers in this range' };
  return { flow, wait };
}

function fwEscalationRender(el, d, ctx) {
  const { flow, wait } = d;
  const done = flow.throughput.total;
  const nb = wait.blocked.count;
  const per = (b, n) => (n ? b / n : null);
  const cur = per(nb, done);
  const prev = flow.previous && wait.previous ? per(wait.previous.blocked.count, flow.previous.throughput) : null;
  el.append(fwMain(cur === null ? '—' : fwRatio(cur), 'blockers / card done', `${mxPlural(nb, 'blocker')} · ${mxPlural(done, 'card')} done`));
  // both reads share the window; previous exists only when both have it
  const r = { previous: flow.previous && wait.previous, previousWindow: flow.previousWindow };
  el.append(fwDeltaRow(fwPrevChip(r, 'Blockers per card done', -1, fwRatio, cur, prev)));
  // the current period's is blocked.resolution; previous carries the picked blocked.p50
  const p50 = wait.blocked.resolution.p50;
  const res = node('div', 'fw-resolve');
  res.append(node('span', 'fw-k', 'Median time to resolve'), node('span', 'fw-resolve-v', p50 === null ? 'no blocker resolved in range' : mxWait(p50)));
  el.append(res);
  if (ctx.size === 'S') return;
  const wr = { previous: wait.previous, previousWindow: wait.previousWindow };
  el.append(fwDeltaRow(fwPrevChip(wr, 'Median time to resolve a blocker', -1, mxWait, p50, wait.previous?.blocked?.p50 ?? null)));
  el.append(node('div', 'fw-foot', nb ? `${mxWait(wait.blocked.totalMs)} spent blocked in range` : 'No blockers in range'));
}

// ── registration ──
const FW_WIDGETS = [
  { type: 'cycle-breakdown', title: 'Where does the time go?', sizes: ['M', 'L'], load: fwCycleLoad, render: fwCycleRender },
  { type: 'wip', title: 'Are we overloaded?', sizes: ['S', 'M'], load: fwWipLoad, render: fwWipRender },
  { type: 'review-queue', title: 'Is review the bottleneck?', sizes: ['S', 'M', 'L'], load: fwReviewLoad, render: fwReviewRender },
  { type: 'throughput-trend', title: 'Is delivery speeding up?', sizes: ['M', 'L', 'XL'], load: fwTrendLoad, render: fwTrendRender },
  { type: 'escalation', title: 'How often do agents need a human?', sizes: ['S', 'M'], load: fwEscalationLoad, render: fwEscalationRender },
];

for (const w of FW_WIDGETS) {
  dwRegister({
    type: w.type,
    title: w.title,
    sizes: w.sizes,
    load: w.load,
    render(el, data, ctx) {
      if (data.empty) return { empty: data.empty };
      const box = node('div', `fw fw-${w.type}`);
      box.dataset.size = ctx.size;
      w.render(box, data, ctx);
      el.append(box);
    },
  });
}
