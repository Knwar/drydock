// ── Dashboard widgets: Agentic (autonomy-index, agent-stops, batch-size, spec-adherence, governance-posture) ──
// Classic script; uses app.js / dashboard.js globals read-only (node, svgEl, mxGet, mxPlural, MX_LOCAL_TZ,
// mxDayKey, mxAddDays, homeMeta, dwRegister, dwAfterRender, dwDeltaChip, dwVs, dwDay, dwFirstActivity).
// All five read one GET /metrics/agentic?compare=previous per refresh (ctx.shared, keyed by its URL; a
// batch-size widget with a non-default threshold reads its own). Each title states the question; status
// is always an icon + text with its thresholds written in the tooltip, never colour alone. Every widget
// head carries a small "Experimental" note. Sizes: S = headline + chip; M = + trend / split; L = + breakdown.
//   autonomy-index      % of done cards that needed no human (no blocker raised, no redirect)
//   agent-stops         agent self-stops (blockers) vs human interrupts (redirects + reopens)
//   batch-size          % of done cards over N lines changed (param threshold, default 200) + the median
//   spec-adherence      % of done cards with every criterion checked AND a first-pass review
//   governance-posture  tool events tied to a card, done cards linked to a decision, risky commands that ran

const AG_ICONS = { ok: '✓', warn: '!', bad: '✕', none: '–' };
const AG_DEFAULT_BATCH = 200;
const AG_MAX_BATCH = 100_000;
// the widgets whose head carries the "Experimental" note (agExpNote): these five + widget-agentic-cost.js's four
const AG_WIDGETS = ['autonomy-index', 'agent-stops', 'batch-size', 'spec-adherence', 'governance-posture', 'rework-cost', 'decision-latency-cost', 'cost-anomaly', 'usage-runway'];

// Home's filters (the widget's ctx.filters: scope / phase / tag / agent / workType / from / to as epoch ms).
function agFilters(ctx) {
  const q = new URLSearchParams(ctx.filters);
  const get = (k) => q.get(k) || '';
  return { project: get('scope') || ctx.projectId, phase: get('phase'), tag: get('tag'), agent: get('agent'), workType: get('workType'), from: get('from'), to: get('to') };
}

// The one /metrics/agentic read (with the previous period) + the board's first activity (pre-history).
async function agLoad(ctx, batchLines = AG_DEFAULT_BATCH) {
  const f = agFilters(ctx);
  const params = { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: f.from, to: f.to, compare: 'previous' };
  if (batchLines !== AG_DEFAULT_BATCH) params.batchLines = batchLines; // the default keeps the URL the other four share
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `/metrics/agentic?${q}`;
  const [r, since] = await Promise.all([ctx.shared(url, () => mxGet(url)), dwFirstActivity(ctx).catch(() => null)]);
  return { r, since };
}

const agPct = (r) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);
const agPts = (m) => `${Math.round(m * 100)} pts`;
const agRound = (r) => Math.round(r * 100); // thresholds judge the shown (rounded) percent
const agLines = (n) => `${Math.round(n).toLocaleString()} lines`;

// "vs previous 4 weeks" chip for the read's previous period (grey for all time; "No full previous
// period" when that period starts before the board's first activity). kind 'pts': no % (a change in
// points, or in a ratio, where a % of the ratio would be noise).
function agChip(d, ctx, subject, polarity, fmt, cur, prev, kind) {
  const r = d.r;
  const vs = dwVs(ctx.range, r.previousWindow, r.window);
  return dwDeltaChip({ cur, prev, polarity, fmt, subject, ...vs, has: !!r.previous && !!r.previousWindow, since: d.since, previousWindow: r.previousWindow, kind });
}

function agStatus(kind, text, title) {
  const el = node('div', `ag-status ag-${kind}`);
  const ico = node('span', 'ag-ico', AG_ICONS[kind]);
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'ag-status-text', text));
  if (title) el.title = title;
  return el;
}

// A big value over a quiet label, its chip under it.
function agFigure(value, label, chip, cls = '') {
  const el = node('div', `ag-fig ${cls}`);
  el.append(node('span', 'ag-value', value), node('span', 'ag-label', label));
  if (chip) el.append(chip);
  return el;
}

function agDetail() {
  return node('div', 'ag-detail');
}

// Weeks wholly before the board's first activity (since) are pre-history: drawn grey, never as zero work.
function agPre(weeks, since) {
  return weeks.map((w) => since != null && new Date(`${mxAddDays(w.start, 7)}T00:00`).getTime() <= since);
}

function agWeekHead(label, weeks) {
  const head = node('div', 'ag-k-row');
  head.append(node('span', 'ag-k', label));
  if (weeks.length) head.append(node('span', 'ag-sub', `${mxPlural(weeks.length, 'week')} from ${dwDay(weeks[0].start)}`));
  return head;
}

function agPreNote(pre) {
  return pre.some(Boolean) ? node('div', 'ag-axis', 'grey: before the board’s first activity') : null;
}

// Inline SVG sparkline over 0..1 rates; null weeks are gaps, pre-history weeks a grey band.
function agRateSpark(values, pre, { tall = false } = {}) {
  const W = 240;
  const H = tall ? 56 : 36;
  const pad = 4;
  const n = values.length;
  const step = n > 1 ? (W - 2 * pad) / (n - 1) : 0;
  const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : i * step);
  const y = (v) => H - pad - v * (H - 2 * pad);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: tall ? 'ag-spark ag-spark-tall' : 'ag-spark', 'aria-hidden': 'true' });
  const lastPre = pre.lastIndexOf(true);
  if (lastPre >= 0) svg.append(svgEl('rect', { x: 0, y: 0, width: Math.min(W, x(lastPre) + step / 2).toFixed(1), height: H, class: 'ag-pre-band' }));
  svg.append(svgEl('line', { x1: pad, x2: W - pad, y1: y(1), y2: y(1), class: 'ag-grid' }), svgEl('line', { x1: pad, x2: W - pad, y1: y(0), y2: y(0), class: 'ag-grid' }));
  let run = [];
  const flush = () => {
    if (run.length > 1) svg.append(svgEl('polyline', { points: run.join(' '), class: 'ag-spark-line' }));
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null) return flush();
    run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  flush();
  values.forEach((v, i) => {
    if (v === null) return;
    const [cx, cy] = [x(i).toFixed(1), y(v).toFixed(1)];
    svg.append(svgEl('line', { x1: cx, y1: cy, x2: cx, y2: cy, class: i === n - 1 ? 'ag-spark-last' : 'ag-spark-dot', 'vector-effect': 'non-scaling-stroke' }));
  });
  return svg;
}

// Paired weekly bars (agent | human) on one count scale; pre-history weeks are grey stubs.
function agPairBars(weeks, pre, { tall = false } = {}) {
  const W = 240;
  const H = tall ? 64 : 36;
  const n = weeks.length;
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.agent, w.human)));
  const slot = W / Math.max(1, n);
  const bw = Math.max(1, slot * 0.36);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: tall ? 'ag-bars ag-bars-tall' : 'ag-bars', 'aria-hidden': 'true' });
  svg.append(svgEl('line', { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, class: 'ag-grid' }));
  weeks.forEach((w, i) => {
    const x0 = i * slot + (slot - 2 * bw) / 2;
    if (pre[i]) {
      svg.append(svgEl('rect', { x: x0.toFixed(1), y: H - 3, width: (2 * bw).toFixed(1), height: 3, class: 'ag-bar-pre' }));
      return;
    }
    const bar = (v, dx, cls) => {
      const h = v ? Math.max(2, (v / max) * (H - 2)) : 0;
      if (h) svg.append(svgEl('rect', { x: (x0 + dx).toFixed(1), y: (H - h).toFixed(1), width: bw.toFixed(1), height: h.toFixed(1), class: cls }));
    };
    bar(w.agent, 0, 'ag-bar-agent');
    bar(w.human, bw, 'ag-bar-human');
  });
  return svg;
}

// Done cards ({ id, title, doneAt }) → drill rows (the card list's fields when the card is known to Home).
async function agDrill(ctx, items, kicker, title, btn) {
  if (btn) btn.disabled = true;
  try {
    const meta = await homeMeta();
    const project = agFilters(ctx).project;
    const cards = items.map((it) => {
      const c = meta?.cards.get(it.id);
      // lane_since: when it was done (in the read's window), never the card list's latest move
      return { ...(c ?? {}), id: it.id, title: it.title, board: c?.board ?? project, lane: c?.lane ?? 'done', lane_since: it.doneAt };
    });
    await ctx.drillCards({ kicker, title, cards });
  } catch (e) {
    console.error('agentic drill', e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function agOpenCard(ctx, id) {
  const meta = await homeMeta().catch(() => null);
  ctx.openCard(id, meta?.cards.get(id)?.board);
}

function agLinkBtn(text, title, onclick) {
  const b = node('button', 'ag-link', text);
  b.type = 'button';
  b.title = title;
  b.onclick = onclick;
  return b;
}

// ── autonomy-index: "How autonomous are the agents?" ──
const AG_AUTONOMY_RULE =
  'Thresholds: Green ≥ 70% · Amber 50–70% · Red < 50% of done cards needing no human. A card needed a human when a blocker was raised on it or it was redirected, at any point in its life.';

function agAutonomyRender(el, d, ctx) {
  const a = d.r.autonomy;
  if (!a.done) return { empty: 'No cards done in this period: autonomy is measured on done cards' };
  const p = agRound(a.pct);
  el.append(agFigure(agPct(a.pct), `of ${mxPlural(a.done, 'done card')} needed no human`, agChip(d, ctx, 'Autonomy index', 1, agPts, a.pct, d.r.previous?.autonomy?.pct, 'pts')));
  const [kind, text] = p >= 70 ? ['ok', 'Green: 70% or more autonomous'] : p >= 50 ? ['warn', 'Amber: 50–70% autonomous'] : ['bad', 'Red: under 50% autonomous'];
  el.append(agStatus(kind, text, AG_AUTONOMY_RULE));
  if (ctx.size === 'S') return;

  const det = agDetail();
  const weeks = a.weekly.slice(ctx.size === 'L' ? -12 : -8);
  const pre = agPre(weeks, d.since);
  const box = node('div', 'ag-chart');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `Weekly autonomy: ${weeks.map((w, i) => `week of ${dwDay(w.start)} ${pre[i] ? 'before the board’s first activity' : w.pct === null ? 'no cards done' : agPct(w.pct)}`).join(', ')}`);
  box.append(agWeekHead('weekly autonomy', weeks), agRateSpark(weeks.map((w) => w.pct), pre, { tall: ctx.size === 'L' }));
  const note = agPreNote(pre);
  if (note) box.append(note);
  det.append(box);

  if (ctx.size === 'L') {
    const human = a.done - a.autonomous;
    const row = node('div', 'ag-human');
    row.append(node('span', 'ag-v', `${a.autonomous} autonomous ·`));
    // the drill: the cards that had a blocker or a redirect (the server lists the newest, capped)
    const list = a.needsHuman;
    if (list.length) {
      const title = list.length < human ? `newest ${list.length} of ${human} cards` : mxPlural(list.length, 'card');
      const open = agLinkBtn(`${human} needed a human`, 'Open the cards that needed a human (a blocker raised or a redirect)', () => agDrill(ctx, list, 'NEEDED A HUMAN', title, open));
      row.append(open);
    } else row.append(node('span', 'ag-v', `${human} needed a human`));
    det.append(row);
  }
  el.append(det);
}

// ── agent-stops: "Who stops the agents?" ──
const AG_STOPS_RULE =
  'Healthy when agent self-stops (blockers raised) are at least as many as human interrupts (redirects, and reopens from review or done that don’t follow a failed review): agents that stop to ask need fewer course corrections.';

function agStopsRender(el, d, ctx) {
  const s = d.r.stops;
  if (!s.agent && !s.human) return { empty: 'No stops in this period: no blockers raised, no redirects or reopens' };
  const prev = d.r.previous?.stops;
  const value = s.ratio === null ? String(s.agent) : `${s.ratio.toFixed(1)}×`;
  const label = s.ratio === null ? `${s.agent === 1 ? 'self-stop' : 'self-stops'}, no human interrupts` : 'agent self-stops per human interrupt';
  el.append(agFigure(value, label, agChip(d, ctx, 'Self-stops per interrupt', 1, (m) => m.toFixed(1), s.ratio, prev?.ratio ?? null, 'pts')));
  el.append(s.agent >= s.human ? agStatus('ok', 'Healthy: self-stops ≥ interrupts', AG_STOPS_RULE) : agStatus('warn', 'Interrupts outnumber self-stops', AG_STOPS_RULE));
  if (ctx.size === 'S') return;

  const det = agDetail();
  const counts = node('div', 'ag-figs');
  counts.append(
    agFigure(String(s.agent), 'agent self-stops', agChip(d, ctx, 'Agent self-stops', 0, String, s.agent, prev?.agent ?? null), 'ag-fig-sm'),
    agFigure(String(s.human), 'human interrupts', agChip(d, ctx, 'Human interrupts', -1, String, s.human, prev?.human ?? null), 'ag-fig-sm'),
  );
  det.append(counts);
  const weeks = s.weekly.slice(ctx.size === 'L' ? -12 : -8);
  const pre = agPre(weeks, d.since);
  const box = node('div', 'ag-chart');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `Weekly stops: ${weeks.map((w, i) => `week of ${dwDay(w.start)} ${pre[i] ? 'before the board’s first activity' : `${w.agent} self-stops, ${w.human} interrupts`}`).join('; ')}`);
  box.append(agWeekHead('weekly stops', weeks), agPairBars(weeks, pre, { tall: ctx.size === 'L' }));
  const legend = node('div', 'ag-legend');
  legend.append(node('span', 'ag-lg ag-lg-agent', 'Self-stops'), node('span', 'ag-lg ag-lg-human', 'Interrupts'));
  const note = agPreNote(pre);
  if (note) legend.append(note);
  box.append(legend);
  det.append(box);
  if (ctx.size === 'L') det.append(node('div', 'ag-sub', `Interrupts: ${mxPlural(s.redirects, 'redirect')} · ${mxPlural(s.reopens, 'reopen')} (not after a failed review)`));
  el.append(det);
}

// ── batch-size: "Are changes small enough to review?" ──
// the param as a whole line count in 1..AG_MAX_BATCH; unset or not a number → the default
const agThreshold = (ctx) => {
  const raw = ctx.params.threshold;
  const n = Math.round(Number(raw));
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return AG_DEFAULT_BATCH;
  return Math.min(AG_MAX_BATCH, Math.max(1, n));
};
const agBatchRule = (t) => `Thresholds: Green under 20% · Amber 20–40% · Red over 40% of done cards changing more than ${t} lines (added + removed). Large changes are harder to review.`;

function agBatchRender(el, d, ctx) {
  const b = d.r.batch;
  const done = d.r.autonomy.done;
  if (!done) return { empty: 'No cards done in this period: batch size is measured on done cards' };
  if (!b.cards) return { empty: `No line data for the ${mxPlural(done, 'done card')} in this period` };
  const prev = d.r.previous?.batch;
  const figs = node('div', 'ag-figs');
  figs.append(
    agFigure(agPct(b.pctOver), `of ${mxPlural(b.cards, 'card')} over ${b.threshold} lines`, agChip(d, ctx, `Share of cards over ${b.threshold} lines`, -1, agPts, b.pctOver, prev?.pctOver ?? null, 'pts')),
    agFigure(b.median === null ? '—' : String(Math.round(b.median)), 'median lines changed', agChip(d, ctx, 'Median lines changed', -1, (m) => String(Math.round(m)), b.median, prev?.median ?? null)),
  );
  el.append(figs);
  const p = agRound(b.pctOver);
  const [kind, text] = p < 20 ? ['ok', 'Green: under 20% oversized'] : p <= 40 ? ['warn', 'Amber: 20–40% oversized'] : ['bad', 'Red: over 40% oversized'];
  el.append(agStatus(kind, text, agBatchRule(b.threshold)));
  if (b.noData) el.append(node('div', 'ag-note', `${mxPlural(b.noData, 'done card')} had no line data (left out)`));
  if (ctx.size === 'S') return;

  const det = agDetail();
  const split = node('div', 'ag-chart');
  split.append(node('span', 'ag-k', `${b.over} over · ${b.cards - b.over} at or under ${b.threshold} lines`));
  const bar = node('div', 'ag-split');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${b.over} of ${b.cards} cards over ${b.threshold} lines`);
  const over = node('span', 'ag-split-over');
  over.style.flexGrow = String(b.over);
  const under = node('span', 'ag-split-under');
  under.style.flexGrow = String(b.cards - b.over);
  bar.append(over, under);
  split.append(bar);
  if (!b.noData) split.append(node('span', 'ag-sub', 'Every done card had line data'));
  det.append(split);

  if (ctx.size === 'L' && b.top.length) {
    const head = node('div', 'ag-k-row');
    head.append(node('span', 'ag-k', `largest ${b.top.length === 1 ? 'card' : `${b.top.length} cards`}`));
    const open = agLinkBtn('Open list', 'Open these cards in a list', () => agDrill(ctx, b.top, 'LARGEST CHANGES', mxPlural(b.top.length, 'card'), open));
    head.append(open);
    const list = node('ul', 'ag-list');
    for (const c of b.top) {
      const li = node('li');
      const btn = node('button', 'ag-item');
      btn.type = 'button';
      btn.title = `${c.title}: open the card`;
      btn.onclick = () => agOpenCard(ctx, c.id);
      btn.append(node('span', 'ag-item-title', c.title), node('span', `ag-item-v${c.lines > b.threshold ? ' ag-over' : ''}`, agLines(c.lines)));
      li.append(btn);
      list.append(li);
    }
    det.append(head, list);
  }
  el.append(det);
}

// ── spec-adherence: "Do agents build to spec?" ──
const AG_SPEC_RULE =
  'Thresholds: Green ≥ 80% · Amber 60–80% · Red < 60% of done cards built to spec: at least one acceptance criterion, all of them checked, and a first review that passed.';

function agSpecRender(el, d, ctx) {
  const s = d.r.specAdherence;
  if (!s.done) return { empty: 'No cards done in this period: spec adherence is measured on done cards' };
  el.append(agFigure(agPct(s.pct), `of ${mxPlural(s.done, 'done card')} met spec`, agChip(d, ctx, 'Spec adherence', 1, agPts, s.pct, d.r.previous?.specAdherence?.pct, 'pts')));
  const p = agRound(s.pct);
  const [kind, text] = p >= 80 ? ['ok', 'Green: 80% or more to spec'] : p >= 60 ? ['warn', 'Amber: 60–80% to spec'] : ['bad', 'Red: under 60% to spec'];
  el.append(agStatus(kind, text, AG_SPEC_RULE));
  if (ctx.size === 'S') return;

  const det = agDetail();
  const crit = s.byPhase.reduce((t, ph) => ({ total: t.total + ph.criteria.total, checked: t.checked + ph.criteria.checked }), { total: 0, checked: 0 });
  const reviewed = s.byPhase.reduce((t, ph) => t + ph.reviewed, 0);
  const passed = s.byPhase.reduce((t, ph) => t + (ph.firstPassRate === null ? 0 : Math.round(ph.firstPassRate * ph.reviewed)), 0);
  const figs = node('div', 'ag-figs');
  figs.append(
    agFigure(crit.total ? agPct(crit.checked / crit.total) : '—', crit.total ? `criteria checked · ${crit.checked} of ${crit.total}` : 'no acceptance criteria', null, 'ag-fig-sm'),
    agFigure(reviewed ? agPct(passed / reviewed) : '—', reviewed ? `first-pass · ${mxPlural(reviewed, 'card')} reviewed` : 'no reviews', null, 'ag-fig-sm'),
  );
  det.append(figs);

  if (ctx.size === 'L') {
    const table = node('table', 'ag-table');
    const thead = node('thead');
    const hr = node('tr');
    for (const h of ['Phase', 'Cards', 'Criteria', 'First-pass', 'To spec']) hr.append(node('th', '', h));
    thead.append(hr);
    const tbody = node('tbody');
    for (const ph of s.byPhase) {
      const tr = node('tr');
      tr.append(
        node('td', 'ag-td-name', ph.phase_id === null ? 'No phase' : (ph.title ?? 'Unknown phase')),
        node('td', '', String(ph.cards)),
        node('td', '', ph.criteria.total ? `${ph.criteria.checked}/${ph.criteria.total}` : '—'),
        node('td', '', agPct(ph.firstPassRate)),
        node('td', '', agPct(ph.cards ? ph.adherent / ph.cards : null)),
      );
      tbody.append(tr);
    }
    table.append(thead, tbody);
    det.append(table);
  }
  el.append(det);
}

// ── governance-posture: "Is agent work governed?" ──
const AG_RISKY_RULE = 'Thresholds: Green with no risky command · Red with any (rm -rf, git push --force, git reset --hard, DROP TABLE, chmod 777, curl | sh).';

function agGovRender(el, d, ctx) {
  const g = d.r.governance;
  const prev = d.r.previous?.governance;
  if (!g.decisionLinked.done && !g.toolEvents.total) return { empty: 'No done cards or agent tool events in this period' };
  const figs = node('div', 'ag-figs');
  figs.append(
    agFigure(agPct(g.toolEvents.tiedPct), g.toolEvents.total ? `agent actions tied to a card · ${g.toolEvents.tied} of ${g.toolEvents.total}` : 'no agent actions recorded', agChip(d, ctx, 'Agent actions tied to a card', 1, agPts, g.toolEvents.tiedPct, prev?.tiedPct ?? null, 'pts')),
    agFigure(agPct(g.decisionLinked.pct), g.decisionLinked.done ? `done cards linked to a decision · ${g.decisionLinked.linked} of ${g.decisionLinked.done}` : 'no cards done', agChip(d, ctx, 'Done cards linked to a decision', 1, agPts, g.decisionLinked.pct, prev?.decisionLinkedPct ?? null, 'pts')),
  );
  el.append(figs);

  const risky = g.risky;
  const row = node('div', 'ag-risky');
  if (risky.count === null) row.append(agStatus('none', `Risky commands: not measured. ${risky.reason ?? ''}`.trim(), AG_RISKY_RULE));
  else {
    const st = risky.count ? agStatus('bad', `Red: ${mxPlural(risky.count, 'risky command')} ran`, `${AG_RISKY_RULE}\n${risky.caveat ?? ''}`) : agStatus('ok', 'Green: no risky commands', `${AG_RISKY_RULE}\n${risky.caveat ?? ''}`);
    row.append(st);
    if (ctx.size !== 'S') row.append(agChip(d, ctx, 'Risky commands', -1, String, risky.count, prev?.risky ?? null));
  }
  el.append(row);
  if (ctx.size === 'S') return;

  const det = agDetail();
  if (ctx.size === 'L' && risky.byPattern) {
    const list = node('ul', 'ag-patterns');
    for (const [name, n] of Object.entries(risky.byPattern)) {
      const li = node('li', n ? 'ag-pat ag-pat-hit' : 'ag-pat');
      li.append(node('code', '', name), node('span', '', String(n)));
      list.append(li);
    }
    det.append(list);
  }
  det.append(node('p', 'ag-note', g.toolEvents.note));
  if (ctx.size === 'L' && risky.caveat) det.append(node('p', 'ag-note ag-caveat', risky.caveat)); // also in the status tooltip
  el.append(det);
}

const agRender = (fn, cls) => (el, data, ctx) => {
  const box = node('div', `ag ${cls}`);
  const r = fn(box, data, ctx);
  if (r?.empty) return r;
  el.append(box);
};

// "Experimental" in every agentic widget's head (all states: loading, error, empty), next to the title
function agExpNote(root) {
  for (const head of root.querySelectorAll(AG_WIDGETS.map((t) => `.dw-widget[data-widget-type="${t}"] > .dw-head`).join(','))) {
    if (head.querySelector('.ag-exp')) continue;
    const tag = node('span', 'ag-exp', 'Experimental');
    tag.title = 'Experimental metric: built only on what kankan already records; see each figure’s tooltip for its caveats.';
    head.querySelector('.dw-title')?.after(tag);
  }
}
dwAfterRender(agExpNote);
// this script may register after the layout has rendered: note the widgets already on screen once
agExpNote(document);

const AG_DEFS = [
  { type: 'autonomy-index', title: 'How autonomous are the agents?', render: agAutonomyRender, cls: 'ag-autonomy' },
  { type: 'agent-stops', title: 'Who stops the agents?', render: agStopsRender, cls: 'ag-stops' },
  {
    type: 'batch-size',
    title: 'Are changes small enough to review?',
    render: agBatchRender,
    cls: 'ag-batch',
    params: [{ key: 'threshold', label: 'Line threshold', type: 'number', default: AG_DEFAULT_BATCH, min: 1, max: AG_MAX_BATCH }],
    load: (ctx) => agLoad(ctx, agThreshold(ctx)),
  },
  { type: 'spec-adherence', title: 'Do agents build to spec?', render: agSpecRender, cls: 'ag-spec' },
  { type: 'governance-posture', title: 'Is agent work governed?', render: agGovRender, cls: 'ag-gov' },
];

for (const w of AG_DEFS) {
  dwRegister({
    type: w.type,
    title: w.title,
    sizes: ['S', 'M', 'L'],
    ranged: true,
    ...(w.params ? { params: w.params } : {}),
    load: w.load ?? ((ctx) => agLoad(ctx)),
    render: agRender(w.render, w.cls),
  });
}
