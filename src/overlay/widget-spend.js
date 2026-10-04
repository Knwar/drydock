// ── Dashboard widgets: Spend (ai-spend, investment-mix, budget-burn) ──
//   ai-spend (S, M, L)          "Is the AI spend paying off?"   spend + cost per card done, with deltas
//   investment-mix (M, L)       "Are we investing in the right things?"   shares of spend / cards done by work type
//   budget-burn (M, L, XL)      "Will we finish within budget?"   per phase actual vs budget vs projected
// One /metrics/cost and one /metrics/flow read (Home's filters, compare=previous), deduped by URL through
// ctx.shared, so the three widgets share them per refresh cycle. Uses app.js globals read-only (node, svgEl,
// mx*, MX_LOCAL_TZ) and dashboard.js's dwDeltaChip / dwPrevDays. Status is always an icon + text.

const SP_ICONS = { ok: '✓', warn: '!', bad: '✕', none: '–', info: 'i' };
const SP_TOP = 5; // ai-spend L: the most expensive cards

// Home's filters (fbParams: scope / phase / tag / agent / workType / from / to as epoch ms).
function spFilters(ctx) {
  const q = new URLSearchParams(ctx.filters);
  const get = (k) => q.get(k) || '';
  return { project: get('scope') || ctx.projectId, phase: get('phase'), tag: get('tag'), agent: get('agent'), workType: get('workType'), from: get('from'), to: get('to') };
}

// GET path?params, deduped per refresh cycle by its URL; errors throw (the renderer's error state).
function spGet(ctx, path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `${path}?${q}`;
  return ctx.shared(url, () => mxGet(url));
}

// A metrics read over Home's filters; extra overrides (e.g. another from / to).
const spQuery = (f, extra) => ({ project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: f.from, to: f.to, ...extra });
const spCost = (ctx, f) => spGet(ctx, '/metrics/cost', spQuery(f, { limit: SP_TOP, compare: 'previous' }));
const spFlow = (ctx, f) => spGet(ctx, '/metrics/flow', spQuery(f, { compare: 'previous' }));

// A phase / tag / agent / type filter narrows the read (an empty result may be the filter's doing).
const spFiltered = (f) => !!(f.phase || f.tag || f.agent || f.workType);

// The comparison labels for a compare=previous read ("vs prev 14 d"); empty for all time (no previous).
function spCmp(r) {
  const days = dwPrevDays(r.previousWindow);
  return days === null ? { label: '', labelLong: '' } : { label: `vs prev ${days} d`, labelLong: `vs previous ${days} days` };
}

function spStatus(kind, text, title) {
  const el = node('div', `sp-status sp-${kind}`);
  const ico = node('span', 'sp-ico', SP_ICONS[kind]);
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'sp-status-text', text));
  if (title) el.title = title;
  return el;
}

// A share as a percentage: "45%", "<1%" for a sliver, "0%".
const spPct = (share) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);

// ── ai-spend: "Is the AI spend paying off?" ──
async function spSpendLoad(ctx) {
  const f = spFilters(ctx);
  const [cost, flow] = await Promise.all([spCost(ctx, f), spFlow(ctx, f)]);
  if (!cost.totals.runs) return { empty: spFiltered(f) ? 'No priced agent runs match these filters' : f.from ? 'No priced agent runs in this range' : 'No priced agent runs yet' };
  return { cost, flow };
}

// One headline figure: value + unit over a quiet label, then its delta chip.
function spFigure(value, unit, label, chip) {
  const el = node('div', 'sp-fig');
  const line = node('span', 'sp-line');
  line.append(node('span', 'sp-value', value), node('span', 'sp-unit', unit));
  el.append(line);
  if (label) el.append(node('span', 'sp-label', label));
  el.append(chip);
  return el;
}

function spSpendRender(el, d, ctx) {
  const { cost, flow } = d;
  const S = ctx.size === 'S';
  const cmp = spCmp(cost);
  const spend = cost.totals.cost;
  const figs = node('div', 'sp-figs');
  figs.append(
    spFigure(
      mxMoney(spend),
      'spent',
      S ? null : `${mxPlural(cost.totals.runs, 'run')} on ${mxPlural(cost.totals.cards, 'card')}`,
      dwDeltaChip({ cur: spend, prev: cost.previous?.totals.cost ?? null, polarity: -1, fmt: mxMoney, subject: 'AI spend', has: !!cost.previous, ...cmp }),
    ),
  );
  // cost per card done: the range's spend over the cards done in it (null with none done)
  const done = flow.throughput.total;
  const prevDone = flow.previous?.throughput ?? null;
  const per = done ? spend / done : null;
  const prevPer = cost.previous && prevDone ? cost.previous.totals.cost / prevDone : null;
  figs.append(
    spFigure(
      per === null ? '—' : mxMoney(per),
      'per card done',
      S ? null : done ? `${mxMoney(spend)} ÷ ${mxPlural(done, 'card')} done` : 'no cards done in range',
      dwDeltaChip({ cur: per, prev: prevPer, polarity: -1, fmt: mxMoney, subject: 'Cost per card done', has: !!cost.previous && !!flow.previous, ...cmp }),
    ),
  );
  el.append(figs);
  const est = cost.estimated;
  if (est.runs) {
    const caveat = cost.caveats.find((c) => c.startsWith('estimated')) ?? '';
    const share = est.share === null ? '' : `: ${spPct(est.share)} of spend`;
    el.append(spStatus('warn', S ? 'Partly estimated' : `Estimated${share}`, caveat ? `Figures are partly ${caveat}` : ''));
  }
  if (S) return;
  const weekly = cost.weekly.slice(-12);
  if (weekly.length >= 2) {
    const spark = node('div', 'sp-detail sp-spark');
    const peak = Math.max(...weekly.map((w) => w.cost));
    spark.append(node('span', 'sp-k', `weekly spend · last ${weekly.length} weeks · peak ${mxMoney(peak)}`), mxSparkline(weekly.map((w) => w.cost)));
    el.append(spark);
  }
  if (ctx.size !== 'L' || !cost.byCard.length) return;
  const top = node('div', 'sp-detail');
  top.append(node('span', 'sp-k', `most expensive cards · ${cost.byCard.length < SP_TOP ? cost.byCard.length : `top ${SP_TOP}`} of ${cost.cardCount}`));
  const list = node('ul', 'sp-list');
  for (const c of cost.byCard.slice(0, SP_TOP)) {
    const li = node('li');
    const row = node(c.deleted ? 'div' : 'button', 'sp-item');
    if (!c.deleted) {
      row.type = 'button';
      row.title = 'Open the card';
      row.onclick = () => ctx.openCard(c.id, c.project_id);
    }
    const title = node('span', 'sp-item-title', c.deleted ? 'Deleted card' : (c.title ?? c.id));
    if (c.deleted) title.classList.add('sp-muted');
    row.append(title, node('span', 'sp-item-val', `${c.estimated ? '~' : ''}${mxMoney(c.cost)}`));
    if (c.estimated) row.lastChild.title = 'Partly estimated';
    li.append(row);
    list.append(li);
  }
  top.append(list);
  el.append(top);
}

// ── investment-mix: "Are we investing in the right things?" ──
// Spend splits over every work type + unclassified + deleted cards; cards done over all but deleted.
const SP_TYPES = [
  ['feature', 'Feature'],
  ['defect', 'Defect'],
  ['debt', 'Debt'],
  ['risk', 'Risk'],
  ['none', 'Unclassified'],
  ['deleted', 'Deleted cards'],
];

async function spMixLoad(ctx) {
  const f = spFilters(ctx);
  if (f.workType) return { empty: `Filtered to one work type (${fbWorkTypeLabel(f.workType)}): clear the Type filter to see the mix` };
  const [cost, flow] = await Promise.all([spCost(ctx, f), spFlow(ctx, f)]);
  if (!cost.totals.cost && !flow.throughput.total)
    return { empty: spFiltered(f) ? 'No spend and no cards done match these filters' : f.from ? 'No spend and no cards done in this range' : 'No spend and no cards done yet' };
  // L: the previous period's mix, for the share deltas (compare=previous carries totals only)
  let prev = null;
  const pw = cost.previousWindow;
  if (ctx.size === 'L' && pw) {
    const [pc, pf] = await Promise.all([
      spGet(ctx, '/metrics/cost', spQuery(f, { from: pw.from, to: pw.to, limit: 1 })),
      spGet(ctx, '/metrics/flow', spQuery(f, { from: pw.from, to: pw.to })),
    ]);
    prev = { spend: spShares(pc.byWorkType.map((w) => [w.workType, w.cost])), cards: spShares(Object.entries(pf.throughputByWorkType)) };
  }
  return {
    cost,
    spend: spShares(cost.byWorkType.map((w) => [w.workType, w.cost])),
    cards: spShares(Object.entries(flow.throughputByWorkType)),
    done: flow.throughput.total,
    prev,
  };
}

// [[type, amount]] → { total, share: { type: 0..1 } } (shares empty with a zero total)
function spShares(pairs) {
  const total = pairs.reduce((s, [, v]) => s + v, 0);
  const share = {};
  if (total > 0) for (const [t, v] of pairs) share[t] = v / total;
  return { total, share };
}

// A 100% bar: one nested <svg> per segment (it clips its own label), the label shown where it fits.
function spMixBar(name, mix, types) {
  const svg = svgEl('svg', { class: 'sp-mix-bar', width: '100%', height: 24 });
  svg.setAttribute('role', 'img');
  const parts = [];
  let x = 0;
  for (const [t, label] of types) {
    const s = mix.share[t] ?? 0;
    if (!s) continue;
    parts.push(`${label} ${spPct(s)}`);
    const seg = svgEl('svg', { x: `${x * 100}%`, width: `${s * 100}%`, height: 24 });
    seg.append(svgEl('rect', { class: `sp-seg sp-seg-${t}`, x: 0, y: 0, width: '100%', height: 24 }));
    // the type and share where there's room, the share alone in a narrower segment
    const text = s >= 0.22 ? `${label} ${spPct(s)}` : s >= 0.08 ? spPct(s) : '';
    if (text) {
      const tx = svgEl('text', { class: 'sp-seg-text', x: '50%', y: 16, 'text-anchor': 'middle' });
      tx.textContent = text;
      seg.append(tx);
    }
    svg.append(seg);
    x += s;
  }
  svg.setAttribute('aria-label', `${name} by work type: ${parts.join(', ')}`);
  return svg;
}

// "▲ +5 pts": a share's change in percentage points (no relative %: a % of a share misleads).
// pol: 1 up is good, -1 down is good, 0 neutral. Reuses dashboard.css's delta chip look.
function spPtsChip(cur, prev, pol, subject) {
  const chip = node('span', 'dw-delta sp-pts');
  chip.setAttribute('role', 'img');
  if (cur === null || prev === null) {
    chip.classList.add('dw-d-flat');
    chip.append(node('span', 'dw-d-chg', '—'));
    chip.setAttribute('aria-label', `${subject}: no comparison`);
    return chip;
  }
  const d = Math.round(cur * 100) - Math.round(prev * 100);
  if (d === 0) {
    chip.classList.add('dw-d-flat');
    chip.append(node('span', 'dw-d-chg', '±0'));
    chip.setAttribute('aria-label', `${subject} unchanged`);
    return chip;
  }
  const tone = pol === 0 ? 'flat' : d * pol > 0 ? 'good' : 'bad';
  chip.classList.add(`dw-d-${tone}`);
  const arrow = node('span', 'dw-d-arrow', d > 0 ? '▲' : '▼');
  arrow.setAttribute('aria-hidden', 'true');
  const val = `${d > 0 ? '+' : '−'}${Math.abs(d)} pts`;
  const chg = node('span', 'dw-d-chg');
  chg.append(arrow, node('span', 'dw-d-val', val));
  chip.append(chg);
  const verdict = tone === 'good' ? ', better' : tone === 'bad' ? ', worse' : '';
  chip.setAttribute('aria-label', `${subject} ${d > 0 ? 'up' : 'down'} ${Math.abs(d)} points${verdict}`);
  return chip;
}

function spMixRender(el, d, ctx) {
  const L = ctx.size === 'L';
  const cardTypes = SP_TYPES.filter(([t]) => t !== 'deleted');
  const bars = node('div', 'sp-bars');
  const barRow = (name, caption, mix, types) => {
    const row = node('div', 'sp-bar-row');
    const head = node('div', 'sp-bar-head');
    head.append(node('span', 'sp-k', name), node('span', 'sp-bar-cap', caption));
    row.append(head, mix.total ? spMixBar(name, mix, types) : node('div', 'sp-bar-none', `No ${name.toLowerCase()} in range`));
    return row;
  };
  bars.append(barRow('Spend', mxMoney(d.spend.total), d.spend, SP_TYPES), barRow('Cards done', String(d.done), d.cards, cardTypes));
  el.append(bars);

  // unclassified, called out: work nobody typed hides what the mix really is
  const us = d.spend.share.none ?? 0;
  const uc = d.cards.share.none ?? 0;
  if (us || uc) {
    const parts = [];
    if (us) parts.push(`${spPct(us)} of spend`);
    if (uc) parts.push(`${spPct(uc)} of cards done`);
    el.append(spStatus('warn', `Unclassified: ${parts.join(' and ')}`, 'Cards without a work type: set one on the card to see where the effort goes'));
  } else el.append(spStatus('ok', 'Everything is classified'));

  // the legend as a table: type, share of spend, share of cards (L: each with its change in points)
  const cmp = spCmp(d.cost);
  const table = node('table', 'sp-mix-table');
  const thead = node('thead');
  const hr = node('tr');
  const th = (text, cls) => {
    const c = node('th', cls ?? '', text);
    c.scope = 'col';
    return c;
  };
  hr.append(th('Type', 'sp-col-type'), th('Spend'));
  if (L) hr.append(th(cmp.label ? `Δ ${cmp.label}` : 'Δ', 'sp-col-d'));
  hr.append(th('Cards'));
  if (L) hr.append(th(cmp.label ? `Δ ${cmp.label}` : 'Δ', 'sp-col-d'));
  thead.append(hr);
  const tbody = node('tbody');
  const prev = d.prev;
  for (const [t, label] of SP_TYPES) {
    const s = d.spend.share[t] ?? 0;
    const c = d.cards.share[t] ?? 0;
    const ps = prev?.spend.share[t] ?? 0;
    const pc = prev?.cards.share[t] ?? 0;
    if (!s && !c && !ps && !pc && t !== 'none') continue; // unclassified always gets its row
    const tr = node('tr');
    if (t === 'none') tr.className = 'sp-row-none';
    const name = node('th', 'sp-col-type');
    name.scope = 'row';
    const sw = node('span', `sp-swatch sp-sw-${t}`);
    sw.setAttribute('aria-hidden', 'true');
    name.append(sw, node('span', '', label));
    tr.append(name, node('td', '', d.spend.total ? spPct(s) : '—'));
    const pol = t === 'none' ? -1 : 0; // less unclassified is better; the rest is a judgment call
    if (L) {
      const cell = node('td', 'sp-col-d');
      cell.append(spPtsChip(d.spend.total && prev?.spend.total ? s : null, prev?.spend.total ? ps : null, pol, `${label} share of spend`));
      tr.append(cell);
    }
    tr.append(node('td', '', t === 'deleted' ? '' : d.done ? spPct(c) : '—'));
    if (L) {
      const cell = node('td', 'sp-col-d');
      if (t !== 'deleted') cell.append(spPtsChip(d.done && prev?.cards.total ? c : null, prev?.cards.total ? pc : null, pol, `${label} share of cards done`));
      tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  el.append(table);
  if (L && !d.prev) el.append(node('div', 'sp-note', d.cost.previousWindow ? 'No previous period to compare' : 'All time: no previous period to compare'));
}

// ── budget-burn: "Will we finish within budget?" ──
async function spBurnLoad(ctx) {
  const f = spFilters(ctx);
  const cost = await spCost(ctx, f);
  const phases = cost.budgets;
  if (!phases.length) return { empty: f.phase ? 'The filtered phase isn’t on this board' : 'No phases yet: budgets are set per phase' };
  if (!phases.some((p) => p.budget !== null)) return { empty: 'No phase has a budget yet: set one in the phase’s details' };
  return { cost };
}

// [kind, label] of a budgeted phase
const spBurnStatus = (b) => (b.overBudget ? ['bad', 'Over'] : b.projectedOverBudget ? ['warn', 'Projected over'] : ['ok', 'Within']);

// A bullet bar: the budget as a band + marker, projected (estimate at completion) as a wide faint bar,
// actual as a narrow solid bar on top. One scale per phase (its largest figure).
function spBullet(b, kind) {
  const max = Math.max(b.budget, b.actual, b.projected ?? 0) * 1.06 || 1;
  const p = (v) => `${Math.min(100, (v / max) * 100).toFixed(2)}%`;
  const svg = svgEl('svg', { class: 'sp-bullet', width: '100%', height: 18 });
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${b.title}: actual ${mxMoney(b.actual)}${b.projected === null ? '' : `, projected ${mxMoney(b.projected)}`}, budget ${mxMoney(b.budget)}`);
  svg.append(
    svgEl('rect', { class: 'sp-bl-track', x: 0, y: 2, width: '100%', height: 14, rx: 3 }),
    svgEl('rect', { class: 'sp-bl-band', x: 0, y: 2, width: p(b.budget), height: 14, rx: 3 }),
  );
  if (b.projected !== null) svg.append(svgEl('rect', { class: `sp-bl-proj sp-bl-${kind}`, x: 0, y: 5, width: p(b.projected), height: 8, rx: 2 }));
  svg.append(
    svgEl('rect', { class: `sp-bl-act sp-bl-${kind}`, x: 0, y: 7, width: p(b.actual), height: 4, rx: 1 }),
    svgEl('rect', { class: 'sp-bl-cap', x: p(b.budget), y: 0, width: 2, height: 18, transform: 'translate(-1 0)' }),
  );
  return svg;
}

function spBurnRender(el, d, ctx) {
  const size = ctx.size;
  const cost = d.cost;
  const budgeted = cost.budgets.filter((b) => b.budget !== null);
  if (size !== 'M') {
    const counts = { ok: 0, warn: 0, bad: 0 };
    for (const b of budgeted) counts[spBurnStatus(b)[0]]++;
    const parts = [];
    if (counts.bad) parts.push(`${counts.bad} over`);
    if (counts.warn) parts.push(`${counts.warn} projected over`);
    if (counts.ok) parts.push(`${counts.ok} within`);
    const kind = counts.bad ? 'bad' : counts.warn ? 'warn' : 'ok';
    el.append(spStatus(kind, `${mxPlural(budgeted.length, 'budgeted phase')}: ${parts.join(' · ')}`));
  }
  // a tag / agent / type filter never narrows a budget: say so before the figures
  if (cost.budgetsUnfiltered) el.append(spStatus('info', 'Budgets cover all work in the phase: the Type, Tag and Agent filters don’t narrow them'));
  const list = node('ul', 'sp-burn');
  for (const b of cost.budgets) {
    const li = node('li', 'sp-phase');
    const head = node('div', 'sp-phase-head');
    head.append(node('span', 'sp-phase-title', b.title));
    if (b.budget === null) {
      li.classList.add('sp-phase-none');
      head.append(spStatus('none', 'No budget set'));
      li.append(head);
      if (size !== 'M') li.append(node('div', 'sp-phase-nums', `${mxMoney(b.actual)} spent`));
      list.append(li);
      continue;
    }
    const [kind, text] = spBurnStatus(b);
    head.append(spStatus(kind, text));
    li.append(head, spBullet(b, kind));
    const nums = node('div', 'sp-phase-nums');
    const proj = b.projected === null ? 'no projection yet' : `projected ${mxMoney(b.projected)}`;
    nums.append(node('span', '', `${mxMoney(b.actual)} of ${mxMoney(b.budget)}`), node('span', '', proj));
    if (size !== 'M') nums.append(node('span', '', b.remainingCards ? `${mxPlural(b.remainingCards, 'card')} left` : 'no cards left'));
    if (size === 'XL') {
      const used = b.budget > 0 ? `${Math.round((b.actual / b.budget) * 100)}% used` : null;
      const end = b.projected ?? b.actual;
      const gap = end - b.budget;
      if (used) nums.append(node('span', '', used));
      nums.append(node('span', '', gap > 0 ? `${mxMoney(gap)} over at completion` : `${mxMoney(-gap)} headroom at completion`));
    }
    li.append(nums);
    list.append(li);
  }
  el.append(list);
  if (size !== 'M') {
    const legend = node('div', 'sp-legend');
    legend.append(node('span', 'sp-lg-act', 'actual'), node('span', 'sp-lg-proj', 'projected at completion'), node('span', 'sp-lg-cap', 'budget'));
    el.append(legend);
  }
  if (size === 'XL' && cost.medianCardCost !== null)
    el.append(node('div', 'sp-note', `Projected = actual + cards left × median done-card cost (${mxMoney(cost.medianCardCost)})`));
}

// ── registration ──
function spWidget(type, title, sizes, load, render) {
  dwRegister({
    type,
    title,
    sizes,
    load,
    render(el, data, ctx) {
      if (data.empty) return { empty: data.empty };
      const box = node('div', `sp sp-${type}`);
      render(box, data, ctx);
      el.append(box);
    },
  });
}

spWidget('ai-spend', 'Is the AI spend paying off?', ['S', 'M', 'L'], spSpendLoad, spSpendRender);
spWidget('investment-mix', 'Are we investing in the right things?', ['M', 'L'], spMixLoad, spMixRender);
spWidget('budget-burn', 'Will we finish within budget?', ['M', 'L', 'XL'], spBurnLoad, spBurnRender);
