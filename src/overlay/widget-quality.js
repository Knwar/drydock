// ── Dashboard widgets: Quality & risk (quality, speed-stability, top-risks) ──
// Classic script; uses app.js / dashboard.js globals read-only (node, svgEl, mxGet, mxPlural,
// MX_LOCAL_TZ, MX_MONTHS, mxUtc, mxAddDays, setView, gvReveal, dwRegister, dwDeltaChip, dwPrevDays).
// Each title states the question; status is always an icon + text, never colour alone.
//   quality          S M L  GET /metrics/quality?compare=previous
//   speed-stability    M L  /metrics/flow + /metrics/quality (compare=previous) + /metrics/flow over previousWindow
//   top-risks          M L  GET /risks (project-level), /phases + /metrics/history (the phase's snapshot baseline)

const WQ_ICONS = { ok: '✓', warn: '!', bad: '✕', none: '–' };

// Home's filters (the widget's ctx.filters: scope / phase / tag / agent / workType / from / to as epoch ms).
function wqFilters(ctx) {
  const q = new URLSearchParams(ctx.filters);
  const get = (k) => q.get(k) || '';
  return { project: get('scope') || ctx.projectId, phase: get('phase'), tag: get('tag'), agent: get('agent'), workType: get('workType'), from: get('from'), to: get('to') };
}

// GET path?params, deduped per refresh cycle by its URL; errors throw (the renderer's error state).
function wqGet(ctx, path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `${path}?${q}`;
  return ctx.shared(url, () => mxGet(url));
}

// The filtered, ranged metric params every read here shares (so the quality read is one request for both widgets).
const wqMetricParams = (f) => ({ project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: f.from, to: f.to });

function wqStatus(kind, text) {
  const el = node('div', `wq-status wq-${kind}`);
  const ico = node('span', 'wq-ico', WQ_ICONS[kind]);
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'wq-status-text', text));
  return el;
}

const wqPct = (r) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);
const wqPts = (m) => `${Math.round(m * 100)} pts`;
const wqDec = (m) => m.toFixed(1);
const wqDay = (day) => `${MX_MONTHS[mxUtc(day).getUTCMonth()]} ${mxUtc(day).getUTCDate()}`; // Oct 20

// "vs prev 14 d" for a compare=previous read r (null days: all time, the chip goes grey).
function wqChip(r, subject, polarity, fmt, cur, prev) {
  const days = dwPrevDays(r.previousWindow);
  return dwDeltaChip({ cur, prev, polarity, fmt, subject, has: !!r.previous && days !== null, label: `vs prev ${days} d`, labelLong: `vs the previous ${days} days` });
}

// One figure: a big value over a quiet label, its delta chip under it.
function wqFigure(value, label, chip, cls = '') {
  const el = node('div', `wq-fig ${cls}`);
  el.append(node('span', 'wq-value', value), node('span', 'wq-label', label));
  if (chip) el.append(chip);
  return el;
}

// Inline SVG sparkline over 0..1 rates; null weeks are gaps (no line through them).
function wqRateSpark(values, { tall = false } = {}) {
  const W = 240;
  const H = tall ? 56 : 36;
  const pad = 4;
  const n = values.length;
  const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (n - 1));
  const y = (v) => H - pad - v * (H - 2 * pad);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: tall ? 'wq-spark wq-spark-tall' : 'wq-spark', 'aria-hidden': 'true' });
  svg.append(svgEl('line', { x1: pad, x2: W - pad, y1: y(1), y2: y(1), class: 'wq-spark-grid' }), svgEl('line', { x1: pad, x2: W - pad, y1: y(0), y2: y(0), class: 'wq-spark-grid' }));
  let run = [];
  const flush = () => {
    if (run.length > 1) svg.append(svgEl('polyline', { points: run.join(' '), class: 'wq-spark-line' }));
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null) return flush();
    run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  flush();
  values.forEach((v, i) => {
    if (v !== null) svg.append(svgEl('circle', { cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: i === n - 1 ? 3 : 1.8, class: i === n - 1 ? 'wq-spark-last' : 'wq-spark-dot' }));
  });
  return svg;
}

// ── quality: "Is work right the first time?" ──
// First-pass fell in each of the last 2 weeks: the last 3 COMPLETE weeks with reviews (the week
// still running at the range's end is skipped, as are weeks without reviews), each rate lower.
// → { weeks, falling } (falling null: fewer than 3 such weeks).
function wqFalling(q) {
  const end = mxDayKey(q.range.to + 1, q.range.tz); // the first day after the range
  const weeks = q.weekly.filter((w) => mxAddDays(w.start, 7) <= end && w.firstPassRate !== null).slice(-3);
  if (weeks.length < 3) return { weeks, falling: null };
  const [a, b, c] = weeks.map((w) => w.firstPassRate);
  return { weeks, falling: c < b && b < a };
}

async function wqQualityLoad(ctx) {
  const f = wqFilters(ctx);
  const q = await wqGet(ctx, '/metrics/quality', { ...wqMetricParams(f), compare: 'previous' });
  if (!q.totals.reviewed) return { empty: q.totals.unreviewedDone ? `No reviews in this period: ${mxPlural(q.totals.unreviewedDone, 'card')} finished without one` : 'No reviewed cards in this period: first-pass needs a review verdict' };
  return { q };
}

function wqQualityRender(el, d, ctx) {
  const q = d.q;
  const t = q.totals;
  const p = q.previous;
  const figs = node('div', 'wq-figs');
  figs.append(
    wqFigure(wqPct(t.firstPassRate), `first-pass · ${mxPlural(t.reviewed, 'card')} reviewed`, wqChip(q, 'First-pass rate', 1, wqPts, t.firstPassRate, p?.firstPassRate)),
    wqFigure(t.avgRounds === null ? '—' : wqDec(t.avgRounds), 'avg review rounds', wqChip(q, 'Average review rounds', -1, wqDec, t.avgRounds, p?.avgRounds)),
  );
  el.append(figs);
  const { weeks: judged, falling } = wqFalling(q);
  const trend =
    falling === null ? wqStatus('none', 'Too few reviewed weeks for a trend') : wqStatus(falling ? 'warn' : 'ok', falling ? 'First-pass fell 2 weeks running' : 'No sustained first-pass drop');
  trend.title =
    falling === null
      ? `Needs 3 complete weeks with reviews (the current week is left out); ${judged.length ? `this range has ${judged.length}` : 'this range has none'}`
      : `Complete weeks compared: ${judged.map((w) => `week of ${wqDay(w.start)} ${wqPct(w.firstPassRate)}`).join(' → ')}`;
  el.append(trend);
  if (ctx.size === 'S') return;

  const det = node('div', 'wq-detail');
  const weeks = q.weekly.slice(ctx.size === 'L' ? -12 : -8);
  const spark = node('div', 'wq-spark-box');
  spark.setAttribute('role', 'img');
  spark.setAttribute('aria-label', `Weekly first-pass rate: ${weeks.map((w) => `week of ${wqDay(w.start)} ${w.firstPassRate === null ? 'no reviews' : wqPct(w.firstPassRate)}`).join(', ')}`);
  const head = node('div', 'wq-k-row');
  head.append(node('span', 'wq-k', `weekly first-pass · ${mxPlural(weeks.length, 'week')}`));
  if (weeks.length) head.append(node('span', 'wq-sub', `${wqDay(weeks[0].start)} – ${wqDay(mxAddDays(weeks[weeks.length - 1].start, 6))}`));
  spark.append(head, wqRateSpark(weeks.map((w) => w.firstPassRate), { tall: ctx.size === 'L' }));
  if (ctx.size === 'L') {
    const axis = node('div', 'wq-axis');
    axis.append(node('span', '', '0–100%'), node('span', '', weeks.some((w) => w.firstPassRate === null) ? 'gaps: weeks without reviews' : ''));
    spark.append(axis);
  }
  det.append(spark);

  const rw = node('div', 'wq-rework');
  const line = node('div', 'wq-k-row');
  line.append(node('span', 'wq-v', mxPlural(t.rework, 'rework loop')), node('span', 'wq-sub', 'fail → back to in progress'));
  rw.append(line, wqChip(q, 'Rework loops', -1, String, t.rework, p?.rework));
  det.append(rw);

  if (ctx.size === 'L') {
    const facts = node('div', 'wq-facts');
    const fact = (k, v) => {
      const c = node('div', 'wq-fact');
      c.append(node('span', 'wq-k', k), node('span', 'wq-v', v));
      return c;
    };
    facts.append(fact('Reviewed', String(t.reviewed)), fact('Escalated', String(t.capped)), fact('Done unreviewed', String(t.unreviewedDone)));
    det.append(facts);
  }
  el.append(det);
}

// ── speed-stability: "Are we buying speed with breakage?" ──
async function wqSpeedLoad(ctx) {
  const f = wqFilters(ctx);
  const base = wqMetricParams(f);
  const [flow, q] = await Promise.all([wqGet(ctx, '/metrics/flow', { ...base, compare: 'previous' }), wqGet(ctx, '/metrics/quality', { ...base, compare: 'previous' })]);
  // the flow compare's previous carries no per-type split: read the previous window itself
  const pw = flow.previous ? flow.previousWindow : null;
  const prevFlow = pw ? await wqGet(ctx, '/metrics/flow', { ...base, from: pw.from, to: pw.to }) : null;
  const prevDone = prevFlow?.throughput.total ?? 0;
  if (!flow.throughput.total && !prevDone && !q.totals.rework && !q.previous?.rework) return { empty: 'No cards done or reworked in this period or the one before' };
  return { flow, q, prevFlow, typed: !!f.workType };
}

function wqSpeedRender(el, d, ctx) {
  const { flow, q, prevFlow } = d;
  const share = (fl) => (fl && fl.throughput.total ? fl.throughputByWorkType.defect / fl.throughput.total : null);
  const thr = flow.throughput.total;
  const thrPrev = flow.previous?.throughput ?? null;
  const rw = q.totals.rework;
  const rwPrev = q.previous?.rework ?? null;
  const ds = d.typed ? null : share(flow);
  const dsPrev = d.typed ? null : share(prevFlow);

  const tiles = node('div', 'wq-tiles');
  const speed = node('div', 'wq-tile');
  speed.append(node('span', 'wq-k', 'Speed'), wqFigure(String(thr), 'cards done', wqChip(flow, 'Cards done', 1, String, thr, thrPrev)));
  const stab = node('div', 'wq-tile');
  stab.append(
    node('span', 'wq-k', 'Stability'),
    wqFigure(String(rw), rw === 1 ? 'rework loop' : 'rework loops', wqChip(q, 'Rework loops', -1, String, rw, rwPrev)),
    wqFigure(d.typed ? '—' : wqPct(ds), d.typed ? 'defect share: Type filter is on' : `defect share of done · ${flow.throughputByWorkType.defect} of ${thr}`, d.typed ? null : wqChip(flow, 'Defect share of done cards', -1, wqPts, ds, dsPrev), 'wq-fig-sm'),
  );
  tiles.append(speed, stab);
  el.append(tiles);

  // the verdict: only when there's a previous period to compare with
  const up = (a, b) => a !== null && b !== null && a > b;
  const thrUp = up(thr, thrPrev);
  // defect share at the chip's precision (whole points): a ±0 chip never reads as "stability down"
  const dsUp = ds !== null && dsPrev !== null && Math.round((ds - dsPrev) * 100) > 0;
  const stabDown = up(rw, rwPrev) || dsUp;
  if (!flow.previous || !q.previous) el.append(wqStatus('none', 'No previous period to compare'));
  else if (thrUp && stabDown) el.append(wqStatus('warn', 'Speed up, stability down'));
  else if (stabDown) el.append(wqStatus('warn', 'Stability down, speed not up'));
  else if (thrUp) el.append(wqStatus('ok', 'Speed up, stability held'));
  else el.append(wqStatus('ok', 'Stability held'));

  if (ctx.size === 'L') {
    const mix = node('div', 'wq-mix');
    mix.append(node('span', 'wq-k', 'done by type'));
    const bar = node('div', 'wq-mix-bar');
    bar.setAttribute('role', 'img');
    const types = [['feature', 'Feature'], ['defect', 'Defect'], ['debt', 'Debt'], ['risk', 'Risk'], ['none', 'Untyped']];
    const by = flow.throughputByWorkType;
    bar.setAttribute('aria-label', `Cards done by type: ${types.map(([k, l]) => `${l} ${by[k] ?? 0}`).join(', ')}`);
    const legend = node('div', 'wq-legend');
    for (const [k, l] of types) {
      const n = by[k] ?? 0;
      if (thr && n) {
        const seg = node('span', `wq-mix-seg wq-t-${k}`);
        seg.style.flexGrow = String(n);
        bar.append(seg);
      }
      legend.append(node('span', `wq-lg wq-t-${k}`, `${l} ${n}`));
    }
    mix.append(bar, legend);
    el.append(mix);
  }
  el.append(node('p', 'wq-note', 'Defects count only cards typed defect (work type); untyped cards are never counted as defects.'));
}

// ── top-risks: "What could hurt us, and is it managed?" ──
const wqSev = (score) => (score >= 15 ? 'hi' : score >= 8 ? 'mid' : 'low');
const wqMitigated = (r) => !!(r.mitigation && r.mitigation.trim());

async function wqRisksLoad(ctx) {
  const f = wqFilters(ctx);
  const [all, phases] = await Promise.all([wqGet(ctx, '/risks', { project: f.project }), wqGet(ctx, '/phases', { project: f.project })]);
  const live = all.filter((r) => r.status === 'open' || r.status === 'mitigating');
  if (!all.length) return { empty: 'No risks logged yet: add them in Governance' };
  if (!live.length) return { empty: `No open or mitigating risks (${mxPlural(all.length, 'risk')} closed or occurred)` };
  live.sort((a, b) => b.score - a.score || b.updated_at - a.updated_at);
  // the baseline: the (filtered or active) phase's own snapshot delta. Per-phase scores are never
  // summed across phases; with no phase or fewer than two snapshot days there is no baseline.
  const phase = f.phase ? { id: f.phase, title: phases.find((p) => p.id === f.phase)?.title ?? null } : (phases.find((p) => p.status === 'active') ?? null);
  let base = null;
  let baseErr = null;
  if (phase) {
    try {
      const hist = await wqGet(ctx, '/metrics/history', { project: f.project, phase: phase.id });
      const dl = hist.deltas;
      if (dl && dl.from !== dl.to && dl.riskScoreChange !== null) base = { change: dl.riskScoreChange, from: dl.from, title: phase.title };
    } catch (e) {
      baseErr = e?.message || String(e); // the list still shows; the chip says "No baseline"
    }
  }
  return { live, base, baseErr, phase };
}

// A short-lived notice (role=status) at the bottom of the page.
function wqToast(text) {
  const t = node('div', 'wq-toast', text);
  t.setAttribute('role', 'status');
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

// Open the risk register (Governance, Risks tab) and reveal the risk once its list has loaded.
const WQ_GOV_WAIT_MS = 5000;
function wqOpenRisk(id) {
  const url = new URL(location.href);
  url.searchParams.set('tab', 'risks'); // openGovernance reads ?tab
  history.replaceState(null, '', url);
  // openGovernance → gvLoad assigns a fresh gov.risks (or a gov.rErr) when the read lands
  const [risks0, err0] = [gov.risks, gov.rErr];
  setView('governance');
  const started = Date.now();
  const tick = () => {
    if (activeView !== 'governance') return; // the user moved on
    const loaded = gov.risks !== risks0 || gov.rErr !== err0;
    if (!loaded && Date.now() - started < WQ_GOV_WAIT_MS) return void setTimeout(tick, 50);
    gvReveal(id); // scrolls, focuses and flashes the row (clearing a search that hides it)
    if (!document.querySelector(`#gv-body [data-id="${CSS.escape(id)}"]`)) wqToast(gov.rErr ? `Couldn’t load the risks: ${gov.rErr}` : 'Risk not found in the register');
  };
  tick();
}

function wqRisksRender(el, d, ctx) {
  const unmitHigh = d.live.filter((r) => r.score >= 15 && !wqMitigated(r)).length;
  const exposure = d.live.reduce((s, r) => s + r.score, 0);
  const head = node('div', 'wq-risk-head');
  const lead = node('div', 'wq-fig');
  lead.append(node('span', 'wq-value', String(unmitHigh)), node('span', 'wq-label', 'unmitigated high risks (score ≥ 15, no mitigation)'));
  head.append(lead);
  const [kind, text] = unmitHigh === 0 ? ['ok', 'Green: none unmitigated'] : unmitHigh <= 2 ? ['warn', 'Amber: mitigate the high risks'] : ['bad', 'Red: 3+ high risks unmitigated'];
  head.append(wqStatus(kind, text));
  el.append(head);

  const exp = node('div', 'wq-exposure');
  exp.append(node('span', 'wq-sub', `open exposure ${exposure} across ${mxPlural(d.live.length, 'risk')}`));
  const chip = node('span', 'dw-delta');
  chip.setAttribute('role', 'img');
  if (d.base) {
    const c = d.base.change;
    chip.classList.add(c > 0 ? 'dw-d-bad' : c < 0 ? 'dw-d-good' : 'dw-d-flat');
    const chg = node('span', 'dw-d-chg');
    if (c) {
      const arrow = node('span', 'dw-d-arrow', c > 0 ? '▲' : '▼');
      arrow.setAttribute('aria-hidden', 'true');
      chg.append(arrow);
    }
    chg.append(node('span', 'dw-d-val', c ? `${c > 0 ? '+' : '−'}${Math.abs(c)}` : '±0'));
    const scope = d.base.title ? `phase ${d.base.title}` : 'phase';
    chip.append(chg, node('span', 'dw-d-vs', `${scope} vs ${wqDay(d.base.from)} baseline`));
    chip.setAttribute('aria-label', `Risk score of the ${scope} ${c ? `${c > 0 ? 'up' : 'down'} ${Math.abs(c)}` : 'unchanged'} since its ${wqDay(d.base.from)} baseline${c ? (c > 0 ? ', worse' : ', better') : ''}`);
  } else {
    chip.classList.add('dw-d-flat');
    chip.append(node('span', 'dw-d-chg', 'No baseline'));
    const why = d.baseErr ? `the phase history couldn’t load (${d.baseErr})` : d.phase ? 'fewer than two daily snapshots of the phase so far' : 'no active phase to take a snapshot baseline from';
    chip.setAttribute('aria-label', `Risk score change: no baseline, ${why}`);
    chip.title = `No baseline: ${why}`;
  }
  exp.append(chip);
  el.append(exp);

  const list = node('ul', 'wq-risks');
  const rows = d.live.slice(0, ctx.size === 'L' ? 10 : 5);
  for (const r of rows) {
    const li = node('li');
    const btn = node('button', 'wq-risk');
    btn.type = 'button';
    btn.title = 'Open in the risk register';
    btn.onclick = () => wqOpenRisk(r.id);
    const score = node('span', `wq-score ${wqSev(r.score)}`, String(r.score));
    score.title = `Score ${r.score}: likelihood ${r.likelihood} × impact ${r.impact}`;
    const main = node('span', 'wq-risk-main');
    main.append(node('span', 'wq-risk-title', r.title));
    const meta = node('span', 'wq-risk-meta');
    meta.append(node('span', r.owner ? '' : 'wq-dim', r.owner || 'No owner'));
    if (ctx.size === 'L') meta.append(node('span', 'wq-dim', `${r.likelihood}×${r.impact} · ${r.status}`));
    main.append(meta);
    const m = wqMitigated(r);
    const mit = node('span', `wq-mit ${m ? 'wq-ok' : r.score >= 15 ? 'wq-bad' : 'wq-warn'}`);
    const ico = node('span', 'wq-ico', m ? WQ_ICONS.ok : WQ_ICONS.warn);
    ico.setAttribute('aria-hidden', 'true');
    mit.append(ico, node('span', '', m ? 'Has mitigation' : 'No mitigation'));
    btn.append(score, main, mit);
    li.append(btn);
    list.append(li);
  }
  el.append(list);
  if (d.live.length > rows.length) el.append(node('div', 'wq-more', `+${d.live.length - rows.length} more in the register`));
}

const wqRender = (fn, cls) => (el, data, ctx) => {
  if (data.empty) return { empty: data.empty };
  const box = node('div', `wq ${cls}`);
  fn(box, data, ctx);
  el.append(box);
};

dwRegister({ type: 'quality', title: 'Is work right the first time?', sizes: ['S', 'M', 'L'], load: wqQualityLoad, render: wqRender(wqQualityRender, 'wq-quality') });
dwRegister({ type: 'speed-stability', title: 'Are we buying speed with breakage?', sizes: ['M', 'L'], load: wqSpeedLoad, render: wqRender(wqSpeedRender, 'wq-speed') });
dwRegister({ type: 'top-risks', title: 'What could hurt us, and is it managed?', sizes: ['M', 'L'], load: wqRisksLoad, render: wqRender(wqRisksRender, 'wq-top-risks') });
