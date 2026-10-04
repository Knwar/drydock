// ── Dashboard widgets: Agentic report (steering-pack, agent-hourly-rate, perception-gap) ──
// Classic script; uses app.js / dashboard.js / widget-agentic.js / widget-delivery.js globals read-only
// (node, mxGet, mxPlural, mxMoney, mxDayKey, mxAddDays, MX_LOCAL_TZ, dwRegister, dwDay, dwDays, dwVs,
// dwDeltaChip, dwFirstActivity, agFilters, agFigure, agDetail, agDrill, agOpenCard, agLinkBtn, dlRag, dlText).
// The "Experimental" head note comes from widget-agentic.js (agExpNote; these types are in AG_WIDGETS).
//   steering-pack      a one-page pre-read from GET /report (+ /report.md for the copy): overall RAG, decisions
//                      (what was decided + the rationale: the options weighed), top risks, milestones moved
//                      (from the daily milestone snapshots, /metrics/history). Unranged: its own period param.
//                      M = headline RAG + counts; L = + short lists; XL = the full one-pager.
//   agent-hourly-rate  human-equivalent hours delivered per $ (GET /metrics/estimates); L = per-agent table
//   perception-gap     median measured / estimated ratio; L = the top 5 misses (drill)
// Both estimate widgets are gated on coverage: under 30% of done cards with an estimate they show a grey
// "Add estimates to cards to see this" (with the coverage line) instead of a figure.

const AR_PERIODS = [
  { value: 'week', label: 'Last week' },
  { value: '2weeks', label: 'Last 2 weeks' },
  { value: 'steering', label: 'Since last steering date' },
];
const AR_DAYS = { week: 7, '2weeks': 14 }; // report.html's own ranges (days=7|14)
const AR_COVERAGE_MIN = 0.3;
const AR_GATED = 'Add estimates to cards to see this';

// ── shared ──

// A real calendar day YYYY-MM-DD (rejects 2026-02-30).
const arIsDay = (s) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

// The steering pack's period: { from: day, days?, label } or { error } (a missing / bad steering date).
function arPeriod(params) {
  const today = mxDayKey(Date.now(), MX_LOCAL_TZ);
  if (params.period === 'steering') {
    const day = String(params.steeringDate ?? '').trim();
    if (!arIsDay(day)) return { error: 'Set the last steering date (YYYY-MM-DD) in this widget’s settings' };
    if (day > today) return { error: `The last steering date (${dwDay(day)}) is in the future` };
    return { from: day, label: 'Since last steering' };
  }
  const days = AR_DAYS[params.period] ?? 7;
  return { from: mxAddDays(today, -(days - 1)), days, label: AR_PERIODS.find((p) => AR_DAYS[p.value] === days).label };
}

// GET path?params (empty values left out), deduped per refresh cycle by its URL.
function arGet(ctx, path, params, read = mxGet) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `${path}?${q}`;
  return ctx.shared(url, () => read(url));
}

const arText = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const arPct = (r) => `${Math.round(r * 100)}%`;
const arNum = (n, digits = 1) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(digits).replace(/\.0+$/, ''));
const arHours = (h) => `${arNum(h, h < 1 ? 2 : 1)} h`;

// "based on N of M done cards with estimates" (+ the %).
function arCoverage(e) {
  const c = e.coverage;
  const el = node('div', 'ar-coverage', `Based on ${c.estimated} of ${mxPlural(e.done, 'done card')} with estimates (${arPct(c.pct ?? 0)})`);
  el.title = `Coverage: the share of the done cards in this period that carry an estimate. Under ${arPct(AR_COVERAGE_MIN)} the figure is not shown.`;
  return el;
}

// Under the coverage minimum: a grey note instead of the figure (the coverage line says how far off).
function arGatedBody(el, e) {
  const box = node('div', 'ar-gated');
  box.append(node('span', 'ar-gated-value', '—'), node('span', 'ar-gated-text', AR_GATED));
  el.append(box, arCoverage(e));
}

// The one /metrics/estimates read (with the previous period) per refresh + the board's first activity.
async function arEstimatesLoad(ctx) {
  const f = agFilters(ctx);
  const params = { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: f.from, to: f.to, compare: 'previous' };
  const [e, since] = await Promise.all([arGet(ctx, '/metrics/estimates', params), dwFirstActivity(ctx).catch(() => null)]);
  return { e, since };
}

function arChip(d, ctx, subject, polarity, fmt, cur, prev, kind) {
  const e = d.e;
  const vs = dwVs(ctx.range, e.previousWindow, e.window);
  return dwDeltaChip({ cur, prev, polarity, fmt, subject, ...vs, has: !!e.previous && !!e.previousWindow, since: d.since, previousWindow: e.previousWindow, kind });
}

// No done cards → the standard empty state; under the coverage minimum → gated (returns true).
function arGate(el, e) {
  if (!e.done) return { empty: 'No cards done in this period: estimates are compared on done cards' };
  if ((e.coverage.pct ?? 0) < AR_COVERAGE_MIN) {
    arGatedBody(el, e);
    return true;
  }
  return false;
}

// ── agent-hourly-rate: "How much work does a dollar buy?" ──
const AR_RATE_RULE =
  'Human-equivalent hours per dollar: the estimates (how long a human engineer would take) of the done cards with recorded AI spend, over that spend. Up is good: each dollar buys more work.';

function arRateRender(el, d, ctx) {
  const e = d.e;
  const gate = arGate(el, e);
  if (gate) return gate === true ? undefined : gate;
  const h = e.hourlyRate;
  const prev = e.previous?.hourlyRate;
  const fig = agFigure(
    h.hoursPerDollar === null ? '—' : arHours(h.hoursPerDollar),
    h.hoursPerDollar === null ? 'no recorded spend on the estimated cards' : 'human-equivalent work per $1',
    arChip(d, ctx, 'Hours per dollar', 1, (m) => arHours(m), h.hoursPerDollar, prev?.hoursPerDollar ?? null),
  );
  fig.title = AR_RATE_RULE;
  el.append(fig, arCoverage(e));
  if (ctx.size === 'S') return;

  const det = agDetail();
  const figs = node('div', 'ag-figs');
  figs.append(
    agFigure(arHours(h.estimateHours), `estimated over ${mxPlural(h.cards, 'card')}`, null, 'ag-fig-sm'),
    agFigure(mxMoney(h.cost), 'AI spend on them', null, 'ag-fig-sm'),
    agFigure(h.dollarsPerHour === null ? '—' : mxMoney(h.dollarsPerHour), 'per human-equivalent hour', null, 'ag-fig-sm'),
  );
  det.append(figs);
  if (h.noSpend) det.append(node('p', 'ag-note', `${mxPlural(h.noSpend, 'estimated card')} had no recorded spend (left out of the rate)`));

  if (ctx.size === 'L' && h.byAgent.length) {
    const table = node('table', 'ag-table ar-agents');
    const thead = node('thead');
    const hr = node('tr');
    for (const t of ['Agent', 'Cards', 'Hours', 'Spend', 'Hours / $']) hr.append(node('th', '', t));
    thead.append(hr);
    const tbody = node('tbody');
    for (const a of h.byAgent) {
      const tr = node('tr');
      const name = node('td', 'ag-td-name', a.agent ?? 'Unassigned');
      name.title = a.agent ?? 'Cards with no assigned agent';
      tr.append(name, node('td', '', String(a.cards)), node('td', '', arNum(a.estimateHours)), node('td', '', mxMoney(a.cost)), node('td', '', a.hoursPerDollar === null ? '—' : arNum(a.hoursPerDollar, a.hoursPerDollar < 1 ? 2 : 1)));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    det.append(table);
  }
  el.append(det);
}

// ── perception-gap: "Are our estimates realistic?" ──
const AR_GAP_RULE =
  'Median of measured ÷ estimated: each done card’s cycle time over its estimate. A ratio above 1× means the work took longer than estimated (slower); below 1× it was faster. 1× is spot on.';

const arRatio = (r) => `${r >= 10 ? Math.round(r) : r.toFixed(r >= 1 ? 1 : 2).replace(/\.?0+$/, '')}×`;
const arRatioWord = (r) => (r > 1 ? 'slower than estimated' : r < 1 ? 'faster than estimated' : 'as estimated');

function arGapRender(el, d, ctx) {
  const e = d.e;
  const gate = arGate(el, e);
  if (gate) return gate === true ? undefined : gate;
  const p = e.perception;
  const m = p.medianRatio;
  const fig = agFigure(
    m === null ? '—' : arRatio(m),
    m === null ? 'no measured cycle time yet' : `median measured ÷ estimated · ${arRatioWord(m)}`,
    arChip(d, ctx, 'Median measured ÷ estimated', 0, (x) => arNum(x, x < 10 ? 2 : 0), m, e.previous?.perception?.medianRatio ?? null, 'pts'),
  );
  fig.title = AR_GAP_RULE;
  fig.classList.add('ar-help');
  el.append(fig, arCoverage(e));
  if (ctx.size === 'S') return;

  const det = agDetail();
  const rated = p.cards.filter((c) => c.ratio !== null);
  const slower = rated.filter((c) => c.ratio > 1).length;
  const faster = rated.filter((c) => c.ratio < 1).length;
  const split = node('div', 'ag-chart');
  split.append(node('span', 'ag-k', `${slower} slower · ${faster} faster · ${rated.length - slower - faster} as estimated`));
  const bar = node('div', 'ag-split');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${slower} of ${rated.length} cards slower than estimated, ${faster} faster`);
  for (const [n, cls] of [
    [slower, 'ar-split-slow'],
    [rated.length - slower - faster, 'ar-split-even'],
    [faster, 'ar-split-fast'],
  ]) {
    const s = node('span', cls);
    s.style.flexGrow = String(n);
    bar.append(s);
  }
  split.append(bar);
  det.append(split);

  if (ctx.size === 'L' && p.topMisses.length) {
    const head = node('div', 'ag-k-row');
    head.append(node('span', 'ag-k', `top ${p.topMisses.length === 1 ? 'miss' : `${p.topMisses.length} misses`}`));
    const open = agLinkBtn('Open list', 'Open these cards in a list', () => agDrill(ctx, p.topMisses, 'ESTIMATE MISSES', mxPlural(p.topMisses.length, 'card'), open));
    head.append(open);
    const list = node('ul', 'ag-list');
    for (const c of p.topMisses) {
      const li = node('li');
      const btn = node('button', 'ag-item');
      btn.type = 'button';
      btn.title = `${c.title}: estimated ${arHours(c.estimateHours)}, took ${arHours(c.cycleHours)} (${arRatio(c.ratio)}, ${arRatioWord(c.ratio)}). Open the card`;
      btn.onclick = () => agOpenCard(ctx, c.id);
      btn.append(node('span', 'ag-item-title', c.title), node('span', `ag-item-v${c.ratio > 1 ? ' ag-over' : ''}`, `${arHours(c.estimateHours)} → ${arHours(c.cycleHours)} · ${arRatio(c.ratio)}`));
      li.append(btn);
      list.append(li);
    }
    det.append(head, list);
  }
  el.append(det);
}

// ── steering-pack: "Steering pack" ──

// Milestones whose date moved in the period, from the daily snapshots: the date as it stood before the
// period (else on its first snapshot in it) vs the latest snapshot. days > 0 = later.
function arMoves(hist, fromDay) {
  const out = [];
  for (const m of hist?.milestones ?? []) {
    const s = m.series;
    if (!s.length) continue;
    const before = s.filter((x) => x.date < fromDay).at(-1);
    const base = before ?? s.find((x) => x.date >= fromDay);
    const last = s.at(-1);
    if (!base || last.date < fromDay || base.milestone_date === last.milestone_date) continue;
    const days = Math.round((Date.parse(`${last.milestone_date}T00:00:00Z`) - Date.parse(`${base.milestone_date}T00:00:00Z`)) / 86_400_000);
    out.push({ id: m.milestone_id, title: m.title ?? 'Removed milestone', fromDate: base.milestone_date, toDate: last.milestone_date, days });
  }
  return out.sort((a, b) => Math.abs(b.days) - Math.abs(a.days) || a.title.localeCompare(b.title));
}

async function arSteeringLoad(ctx) {
  const period = arPeriod(ctx.params);
  if (period.error) return { period };
  const f = agFilters(ctx);
  const q = { project: f.project, tz: MX_LOCAL_TZ, from: period.from, workType: f.workType };
  const [r, md, hist] = await Promise.all([
    arGet(ctx, '/report', q),
    // the Markdown, ready before a click so the copy happens within it (null: fetched again on click)
    arGet(ctx, '/report.md', q, arText).catch(() => null),
    arGet(ctx, '/metrics/history', { project: f.project }).catch(() => null),
  ]);
  const page = new URLSearchParams({ project: f.project, tz: MX_LOCAL_TZ });
  if (period.days) page.set('days', String(period.days));
  else page.set('from', period.from);
  const mdUrl = `/report.md?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`;
  return { period, r, md, mdUrl, moves: hist ? arMoves(hist, period.from) : null, reportHref: `/report.html?${page}` };
}

/** Copy without the async Clipboard API: a hidden textarea + execCommand. */
function arExecCopy(text) {
  const ta = node('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  document.body.append(ta);
  ta.select();
  let done = false;
  try {
    done = document.execCommand('copy');
  } catch {
    done = false;
  }
  ta.remove();
  return done;
}

// Copy the report's Markdown: the Clipboard API, else a promise-fed ClipboardItem (not loaded yet), else
// execCommand; the status line says what happened.
async function arCopy(d, status) {
  const flash = (text) => {
    status.textContent = text;
    setTimeout(() => status.textContent === text && (status.textContent = ''), 2500);
  };
  const fetchMd = () => arText(d.mdUrl).then((t) => (d.md = t));
  try {
    if (navigator.clipboard?.writeText && d.md !== null) {
      await navigator.clipboard.writeText(d.md); // synchronously in the click: keeps the user activation
      return flash('Copied');
    }
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const blob = fetchMd().then((t) => new Blob([t], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return flash('Copied');
    }
  } catch {
    /* fall through to the fallback */
  }
  let text;
  try {
    text = d.md ?? (await fetchMd());
  } catch (err) {
    return flash(`Copy failed: ${err.message}`);
  }
  flash(arExecCopy(text) ? 'Copied' : 'Copy failed: open the full report to copy it');
}

function arActions(d) {
  const row = node('div', 'ar-actions');
  const open = node('a', 'ar-btn', 'Open full report');
  open.href = d.reportHref;
  open.target = '_blank';
  open.rel = 'noopener';
  open.title = `The full status report for ${d.period.label.toLowerCase()}, in a new tab`;
  const copy = node('button', 'ar-btn', 'Copy as Markdown');
  copy.type = 'button';
  copy.title = 'Copy the full report as Markdown';
  const status = node('span', 'ar-copied');
  status.setAttribute('role', 'status');
  copy.onclick = () => arCopy(d, status);
  row.append(open, copy, status);
  return row;
}

const arRiskSort = (risks) => [...risks].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
const arSigned = (n) => (n === 0 ? '±0 d' : `${n > 0 ? '+' : '−'}${Math.abs(n)} d`);

function arSection(title, count) {
  const sec = node('section', 'ar-sec');
  const head = node('div', 'ag-k-row');
  head.append(node('span', 'ag-k', title));
  if (count !== undefined) head.append(node('span', 'ag-sub', String(count)));
  sec.append(head);
  return sec;
}

function arSteeringRender(el, d, ctx) {
  if (d.period.error) return { empty: d.period.error };
  const r = d.r;
  const xl = ctx.size === 'XL';
  const risks = arRiskSort(r.risks.open);
  const decisions = r.decisions.made;

  // headline: the overall RAG + the period
  const head = node('div', 'ar-head');
  const rag = node('div', 'ar-rag');
  rag.append(node('span', 'ag-k', 'Overall'), dlRag(r.overall.rag, 'ar-rag-st'));
  rag.title = `Overall: the worst RAG of the active phases (${dlText(r.overall.reason)})`;
  head.append(rag, node('span', 'ar-period', `${d.period.label} · ${dwDays(r.range.from, r.range.to)}`));
  el.append(head);
  if (ctx.size !== 'M') el.append(node('p', 'ag-note', dlText(r.overall.reason).replace(/^./, (c) => c.toUpperCase())));

  // counts
  const figs = node('div', 'ag-figs ar-counts');
  figs.append(
    agFigure(String(decisions.length), decisions.length === 1 ? 'decision made' : 'decisions made', null, 'ag-fig-sm'),
    agFigure(String(risks.length), risks.length === 1 ? 'open risk' : 'open risks', null, 'ag-fig-sm'),
    agFigure(d.moves === null ? '—' : String(d.moves.length), d.moves === null ? 'milestone moves unknown' : d.moves.length === 1 ? 'milestone moved' : 'milestones moved', null, 'ag-fig-sm'),
    agFigure(String(r.shipped.total), 'cards shipped', null, 'ag-fig-sm'),
  );
  el.append(figs, arActions(d));
  if (ctx.size === 'M') return;

  const det = agDetail();
  det.classList.add('ar-pack');
  const limit = xl ? 5 : 3;

  // phases: the active ones (XL: every phase not done), RAG + reason
  const phases = r.phases.filter((p) => (xl ? p.rag !== 'done' && p.phase_status !== 'done' : p.phase_status === 'active'));
  if (phases.length) {
    const sec = arSection('Status');
    const ul = node('ul', 'ar-rows');
    for (const p of phases) {
      const li = node('li', 'ar-row');
      li.append(node('span', 'ar-row-title', r.boards.length > 1 ? `${p.title} · ${p.board}` : p.title), dlRag(p.rag));
      if (xl) li.append(node('span', 'ar-row-note', dlText(p.reason)));
      else li.title = dlText(p.reason);
      ul.append(li);
    }
    sec.append(ul);
    det.append(sec);
  }

  // decisions: what was decided; XL adds the rationale (the options weighed) and who decided
  {
    const sec = arSection('Decisions', decisions.length);
    if (!decisions.length) sec.append(node('p', 'ag-note', 'No decisions in this period'));
    const ul = node('ul', 'ar-rows');
    for (const x of decisions.slice(0, xl ? decisions.length : limit)) {
      const li = node('li', 'ar-row');
      li.append(node('span', 'ar-row-title', x.title), node('span', 'ar-row-meta', dwDay(mxDayKey(x.decided_at, MX_LOCAL_TZ))));
      if (xl) {
        li.append(node('span', 'ar-row-note ar-row-decision', x.decision));
        if (x.rationale) li.append(node('span', 'ar-row-note', x.rationale));
        if (x.decided_by || x.status === 'superseded') li.append(node('span', 'ar-row-note', [x.decided_by && `Decided by ${x.decided_by}`, x.status === 'superseded' && 'since superseded'].filter(Boolean).join(' · ')));
      } else li.title = `${x.decision}${x.rationale ? `\n${x.rationale}` : ''}`;
      ul.append(li);
    }
    if (!xl && decisions.length > limit) ul.append(node('li', 'ar-more', `+${decisions.length - limit} more in the full report`));
    sec.append(ul);
    det.append(sec);
  }

  // top risks by score
  {
    const sec = arSection('Top risks', risks.length);
    if (!risks.length) sec.append(node('p', 'ag-note', 'No open risks'));
    const ul = node('ul', 'ar-rows');
    for (const x of risks.slice(0, limit)) {
      const li = node('li', 'ar-row');
      const score = node('span', 'ar-score', String(x.score));
      score.title = `Score ${x.score} = likelihood ${x.likelihood} × impact ${x.impact}`;
      li.append(score, node('span', 'ar-row-title', x.title), node('span', 'ar-row-meta', x.status));
      if (xl) {
        const meta = [x.owner && `Owner ${x.owner}`, x.mitigation && `Mitigation: ${x.mitigation}`].filter(Boolean).join(' · ');
        if (meta) li.append(node('span', 'ar-row-note', meta));
      }
      ul.append(li);
    }
    if (risks.length > limit) ul.append(node('li', 'ar-more', `+${risks.length - limit} more in the full report`));
    sec.append(ul);
    det.append(sec);
  }

  // milestones moved
  {
    const moves = d.moves ?? [];
    const sec = arSection('Milestones moved', d.moves === null ? '—' : moves.length);
    if (d.moves === null) sec.append(node('p', 'ag-note', 'Milestone history unavailable'));
    else if (!moves.length) sec.append(node('p', 'ag-note', 'No milestone moved in this period'));
    const ul = node('ul', 'ar-rows');
    for (const m of moves.slice(0, xl ? moves.length : limit)) {
      const li = node('li', 'ar-row');
      li.append(node('span', 'ar-row-title', m.title), node('span', `ar-row-meta${m.days > 0 ? ' ar-late' : ''}`, `${dwDay(m.fromDate)} → ${dwDay(m.toDate)} · ${arSigned(m.days)}`));
      li.title = `${m.title}: ${m.days > 0 ? 'later' : 'earlier'} by ${mxPlural(Math.abs(m.days), 'day')}`;
      ul.append(li);
    }
    if (!xl && moves.length > limit) ul.append(node('li', 'ar-more', `+${moves.length - limit} more`));
    sec.append(ul);
    det.append(sec);
  }
  el.append(det);
}

const arRender = (fn, cls) => (el, data, ctx) => {
  const box = node('div', `ag ar ${cls}`);
  const r = fn(box, data, ctx);
  if (r?.empty) return r;
  el.append(box);
};

dwRegister({
  type: 'steering-pack',
  title: 'Steering pack',
  sizes: ['M', 'L', 'XL'],
  ranged: false, // its own report period (a param), not Home's range
  params: [
    { key: 'period', label: 'Period', type: 'select', options: AR_PERIODS, default: 'week' },
    { key: 'steeringDate', label: 'Last steering date (YYYY-MM-DD, for “Since last steering date”)', type: 'text' },
  ],
  load: arSteeringLoad,
  render: arRender(arSteeringRender, 'ar-steering'),
});
dwRegister({
  type: 'agent-hourly-rate',
  title: 'How much work does a dollar buy?',
  sizes: ['S', 'M', 'L'],
  ranged: true,
  load: arEstimatesLoad,
  render: arRender(arRateRender, 'ar-rate'),
});
dwRegister({
  type: 'perception-gap',
  title: 'Are our estimates realistic?',
  sizes: ['S', 'M', 'L'],
  ranged: true,
  load: arEstimatesLoad,
  render: arRender(arGapRender, 'ar-gap'),
});
