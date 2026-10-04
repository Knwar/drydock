// ── Dashboard widgets: Agentic cost (rework-cost, decision-latency-cost, cost-anomaly, usage-runway) ──
//   rework-cost (S, M, L)             "What does rework cost?"   $ + share of spend on failed review rounds
//   decision-latency-cost (S, M, L)   "What does waiting on me cost?"   $ of idle agent time + days of slip
//   cost-anomaly (S, M, L)            "Is any spend unusual?"   days over their phase's trailing mean + 2σ
//   usage-runway (S, M, L, unranged)  "Will we hit the usage limits?"   5-hour / weekly run-out vs the phase p85
// One GET /metrics/agentic-cost (Home's filters, compare=previous) per refresh cycle, deduped by URL through
// ctx.shared, for the three ranged widgets; usage-runway is live (no range) and reads it without range or compare.
// Uses app.js globals read-only (node, svgEl, mx*, MX_LOCAL_TZ, homeMeta) and dashboard.js's dwDeltaChip / dwVs /
// dwDay / dwFirstActivity, and widget-agentic.js's agExpNote (its AG_WIDGETS lists these four types: every widget head
// carries the small muted "Experimental" note). Status is always an icon + text, its thresholds written out.

const AC_ICONS = { ok: '✓', warn: '!', bad: '✕', none: '–' };
const AC_REWORK_RULE = 'Rework share of spend: green under 10%, amber 10–25%, red over 25%';
const AC_ANOMALY_ROWS = { M: 3, L: 6 }; // cost-anomaly: the newest unusual days listed (M) / in the table (L)
const AC_NO_USAGE = 'no usage-limit data'; // the start of usage-burn's NO_USAGE_REASON

// Home's filters (fbParams: scope / phase / tag / agent / workType / from / to as epoch ms).
function acFilters(ctx) {
  const q = new URLSearchParams(ctx.filters);
  const get = (k) => q.get(k) || '';
  return { project: get('scope') || ctx.projectId, phase: get('phase'), tag: get('tag'), agent: get('agent'), workType: get('workType'), from: get('from'), to: get('to') };
}
const acFiltered = (f) => !!(f.phase || f.tag || f.agent || f.workType);

// GET /metrics/agentic-cost, deduped per refresh cycle by its URL; errors throw (the renderer's error state).
function acRead(ctx, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const url = `/metrics/agentic-cost?${q}`;
  return ctx.shared(url, () => mxGet(url));
}
// the ranged read the three ranged widgets share
const acRanged = (ctx, f) =>
  acRead(ctx, { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase, tag: f.tag, agent: f.agent, workType: f.workType, from: f.from, to: f.to, compare: 'previous' });

function acStatus(kind, text, title) {
  const el = node('div', `ac-status ac-${kind}`);
  const ico = node('span', 'ac-ico', AC_ICONS[kind]);
  ico.setAttribute('aria-hidden', 'true');
  el.append(ico, node('span', 'ac-status-text', text));
  if (title) el.title = title;
  return el;
}

// One money format for a whole widget: cents on every figure when any needs them ($15.00 beside $6.04),
// else whole dollars (mxMoney's). → fmt(usd)
function acMoneyFmt(values) {
  const cents = values.some((v) => v !== null && v !== undefined && Math.abs(v) > 0 && Math.abs(v) < 10);
  if (!cents) return mxMoney;
  return (usd) => (usd === null || usd === undefined ? '—' : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
}

const acPct = (share) => (share === null || share === undefined ? '—' : share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);
const acHours = (h) => mxWait(h * 3_600_000);

// One headline figure: value + unit over a quiet label, then its delta chip (optional).
function acFigure(value, unit, label, chip) {
  const el = node('div', 'ac-fig');
  const line = node('span', 'ac-line');
  line.append(node('span', 'ac-value', value), node('span', 'ac-unit', unit));
  el.append(line);
  // label: one quiet line, or several (the first a wrapping caption)
  if (Array.isArray(label)) label.forEach((t, i) => el.append(node('span', i ? 'ac-label' : 'ac-label ac-caption', t)));
  else if (label) el.append(node('span', 'ac-label', label));
  if (chip) el.append(chip);
  return el;
}

// The chip comparison for a ranged read: "vs previous 4 weeks"; a previous period before the board's first activity greys out.
const acCmp = (ctx, r, since) => ({ ...dwVs(ctx.range, r.previousWindow, r.window), since, previousWindow: r.previousWindow });

// Open a card on its own board (the read covers a workspace's verticals: resolve the board from Home's meta).
async function acOpenCard(ctx, id, board) {
  let b = board;
  if (!b) {
    const meta = await homeMeta().catch(() => null);
    b = meta?.cards.get(id)?.board;
  }
  ctx.openCard(id, b);
}

// A row in a list: a button when it opens something, else a plain row.
function acItem(title, value, onClick, hint) {
  const li = node('li');
  const row = node(onClick ? 'button' : 'div', 'ac-item');
  if (onClick) {
    row.type = 'button';
    row.title = hint;
    row.onclick = onClick;
  }
  row.append(node('span', 'ac-item-title', title), node('span', 'ac-item-val', value));
  li.append(row);
  return li;
}

// ── rework-cost: "What does rework cost?" ──
async function acReworkLoad(ctx) {
  const f = acFilters(ctx);
  const [r, since] = await Promise.all([acRanged(ctx, f), dwFirstActivity(ctx).catch(() => null)]);
  if (!r.reworkCost.totalCost) return { empty: acFiltered(f) ? 'No priced agent runs match these filters' : f.from ? 'No priced agent runs in this range' : 'No priced agent runs yet' };
  return { r, since };
}

// [kind, text] for a rework share (the written thresholds), judged on the shown whole percent so the label and
// colour agree with the figure (25.4% shows 25%: amber; 9.6% shows 10%: amber)
function acReworkKind(pct) {
  if (pct === null) return ['none', 'No spend to compare'];
  const shown = Math.round(pct * 100);
  return shown > 25 ? ['bad', 'Red: over 25% of spend'] : shown >= 10 ? ['warn', 'Amber: 10–25% of spend'] : ['ok', 'Green: under 10% of spend'];
}

function acReworkRender(el, d, ctx) {
  const rc = d.r.reworkCost;
  const prev = d.r.previous?.reworkCost ?? null;
  const has = !!d.r.previous && !!d.r.previousWindow;
  const cmp = acCmp(ctx, d.r, d.since);
  const S = ctx.size === 'S';
  // the chip's change counts too: "$57" beside "+$3.27" would be two formats
  const money = acMoneyFmt([rc.cost, rc.totalCost, prev?.cost == null ? null : Math.abs(rc.cost - prev.cost), ...(ctx.size === 'L' ? rc.top.map((c) => c.cost) : [])]);
  const figs = node('div', 'ac-figs');
  figs.append(
    acFigure(
      money(rc.cost),
      'on rework',
      S ? `${acPct(rc.pct)} of spend` : `${mxPlural(rc.runs, 'run')} before a failed review`,
      dwDeltaChip({ cur: rc.cost, prev: prev?.cost ?? null, polarity: -1, fmt: money, subject: 'Rework cost', has, ...cmp }),
    ),
  );
  if (!S)
    figs.append(
      acFigure(
        acPct(rc.pct),
        'of spend',
        `of ${money(rc.totalCost)} spent`,
        dwDeltaChip({ cur: rc.pct === null ? null : rc.pct * 100, prev: prev?.pct == null ? null : prev.pct * 100, polarity: -1, fmt: (m) => `${Math.round(m)} pts`, kind: 'pts', subject: 'Rework share of spend', has, ...cmp }),
      ),
    );
  el.append(figs);
  const [kind, text] = acReworkKind(rc.pct);
  el.append(acStatus(kind, text, AC_REWORK_RULE));
  if (ctx.size !== 'L') return;
  const top = node('div', 'ac-detail');
  if (!rc.top.length) {
    top.append(node('span', 'ac-note', 'No failed review rounds in range'));
    return void el.append(top);
  }
  top.append(node('span', 'ac-k', `most rework · top ${rc.top.length}`));
  const list = node('ul', 'ac-list');
  for (const c of rc.top) {
    const title = `${c.title ?? c.id}${c.failedRounds > 1 ? ` · ${c.failedRounds} failed rounds` : ''}`;
    list.append(acItem(title, money(c.cost), () => acOpenCard(ctx, c.id), 'Open the card'));
  }
  top.append(list);
  el.append(top);
}

// ── decision-latency-cost: "What does waiting on me cost?" ──
async function acLatencyLoad(ctx) {
  const f = acFilters(ctx);
  const [r, since] = await Promise.all([acRanged(ctx, f), dwFirstActivity(ctx).catch(() => null)]);
  return { r, since };
}

// The Needs-you drill: everything waiting on the human now, as cards (oldest first).
async function acDrillQueue(ctx, queue) {
  const meta = await homeMeta().catch(() => null);
  const cards = queue.map((q) => {
    const c = q.task_id ? meta?.cards.get(q.task_id) : null;
    const title = q.kind === 'blocker' ? (q.title ?? 'Blocked card') : q.title ? `${q.title} · needs you` : q.reason ? `Session waiting: ${q.reason}` : 'A session is waiting on you';
    return { ...(c ?? {}), id: q.task_id ?? undefined, title, board: c?.board ?? q.project_id, lane: c?.lane ?? '', lane_since: q.since, blocked: q.kind === 'blocker' || c?.blocked };
  });
  await ctx.drillCards({ kicker: 'WHAT NEEDS A HUMAN', title: `${cards.length} waiting on you`, cards });
}

function acLatencyRender(el, d, ctx) {
  const dl = d.r.decisionLatencyCost;
  const prev = d.r.previous?.decisionLatencyCost ?? null;
  const has = !!d.r.previous && !!d.r.previousWindow;
  const cmp = acCmp(ctx, d.r, d.since);
  const S = ctx.size === 'S';
  const money = acMoneyFmt([dl.idleCost, dl.idleCost === null || prev?.idleCost == null ? null : Math.abs(dl.idleCost - prev.idleCost), dl.costPerAgentHour]);
  const slip = dl.slip;
  const figs = node('div', 'ac-figs');
  figs.append(
    acFigure(
      dl.idleCost === null ? '—' : money(dl.idleCost),
      '',
      [
        'of idle agent time waiting on you',
        dl.costPerAgentHour === null
          ? 'no timed agent runs in range: no hourly rate'
          : S
            ? `${acHours(dl.humanWaitHours)} waiting`
            : `${acHours(dl.humanWaitHours)} waiting × ${money(dl.costPerAgentHour)}/agent-hour`,
      ],
      dwDeltaChip({ cur: dl.idleCost, prev: prev?.idleCost ?? null, polarity: -1, fmt: money, subject: 'Cost of waiting on you', has, ...cmp }),
    ),
  );
  if (slip?.phase) {
    const days = Math.round(slip.days * 10) / 10;
    const fig = acFigure(`${slip.approximation ? '≈' : ''}${mxNum(days)}`, '', [days === 1 ? 'day of slip' : 'days of slip', ...(S ? [] : [slip.phase.title])]);
    if (slip.approximation) {
      const note = node('span', 'ac-approx', 'approximation');
      note.title = `Approximation: ${slip.reason}`;
      fig.append(note);
    } else fig.title = `Blocked time on ${slip.phase.title}’s critical path (${mxPlural(slip.cards.length, 'card')})`;
    figs.append(fig);
  } else figs.append(acFigure('—', '', ['days of slip', ...(S ? [] : ['no active phase'])]));
  el.append(figs);

  const queue = dl.queue ?? [];
  const now = Date.now();
  if (!queue.length) el.append(acStatus('ok', 'Nothing is waiting on you now'));
  else {
    const st = acStatus('warn', `${mxPlural(queue.length, 'item')} waiting on you · oldest ${mxWait(now - queue[0].since)}`);
    el.append(st);
  }
  if (S || !queue.length) return;
  const box = node('div', 'ac-detail');
  const head = node('div', 'ac-detail-head');
  head.append(node('span', 'ac-k', 'waiting now · oldest first'));
  const all = node('button', 'ac-link', 'Needs you');
  all.type = 'button';
  all.title = 'List everything waiting on you';
  all.onclick = () => acDrillQueue(ctx, queue);
  head.append(all);
  box.append(head);
  const list = node('ul', 'ac-list');
  const max = ctx.size === 'L' ? 5 : 2;
  for (const q of queue.slice(0, max)) {
    const kind = q.kind === 'blocker' ? 'blocked' : 'needs you';
    const title = q.title ?? q.reason ?? 'A session is waiting on you';
    const li = acItem(title, `${kind} · ${mxWait(now - q.since)}`, q.task_id ? () => acOpenCard(ctx, q.task_id, q.project_id) : () => acDrillQueue(ctx, queue), q.task_id ? 'Open the card' : 'Open Needs you');
    li.firstChild.classList.add(q.kind === 'blocker' ? 'ac-q-blocked' : 'ac-q-needs');
    if (q.reason && q.title) li.firstChild.title = `${li.firstChild.title}: ${q.reason}`;
    list.append(li);
  }
  box.append(list);
  if (queue.length > max) {
    const more = node('button', 'ac-link ac-more', `+${queue.length - max} more`);
    more.type = 'button';
    more.onclick = () => acDrillQueue(ctx, queue);
    box.append(more);
  }
  el.append(box);
  if (ctx.size === 'L')
    el.append(node('div', 'ac-note', `Needs you ${acHours(dl.needsYouHours)} · blocked ${acHours(dl.blockedHours)} in range (overlap counted once in the total)`));
}

// ── cost-anomaly: "Is any spend unusual?" ──
async function acAnomalyLoad(ctx) {
  const f = acFilters(ctx);
  const [r, since] = await Promise.all([acRanged(ctx, f), dwFirstActivity(ctx).catch(() => null)]);
  const a = r.costAnomaly;
  if (!a.series.length) return { empty: acFiltered(f) ? 'No spend matches these filters' : f.from ? 'No spend in this range' : 'No spend yet' };
  return { r, since };
}

// The API's rule, written out: "trailing 14-day mean + 2σ", and the tooltip with its history minimum
const acAnomalyRule = (a) => `trailing ${a.trailingDays}-day mean + ${a.sigmas}σ`;
const acAnomalyTitle = (a) => `A day is unusual when its spend is over its phase’s ${acAnomalyRule(a)} (needs ≥ ${a.minDays} days of history)`;

// The range's daily spend (all phases) as a sparkline, flagged days marked with a dot. viewBox stretched to the
// box's width; markers are zero-length round-capped lines, so they stay round at any scale.
function acAnomalySpark(days, flagged, money) {
  const W = 300;
  const H = 40;
  const values = days.map((x) => x.spend);
  const max = Math.max(...values) || 1;
  const x = (i) => (days.length === 1 ? W / 2 : 4 + (i * (W - 8)) / (days.length - 1));
  const y = (v) => H - 4 - (v / max) * (H - 10);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'ac-spark-svg' });
  svg.setAttribute('role', 'img');
  const marks = days.filter((x) => flagged.has(x.date));
  svg.setAttribute('aria-label', `Daily spend, ${dwDay(days[0].date)} to ${dwDay(days[days.length - 1].date)}, peak ${money(Math.max(...values))}${marks.length ? `; unusual: ${marks.map((m) => dwDay(m.date)).join(', ')}` : ''}`);
  svg.append(svgEl('polyline', { points: values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), class: 'ac-spark-line', 'vector-effect': 'non-scaling-stroke' }));
  days.forEach((dd, i) => {
    if (!flagged.has(dd.date)) return;
    const [cx, cy] = [x(i).toFixed(1), y(dd.spend).toFixed(1)];
    svg.append(svgEl('line', { x1: cx, y1: cy, x2: cx, y2: cy, class: 'ac-spark-flag', 'vector-effect': 'non-scaling-stroke' }));
  });
  return svg;
}

function acAnomalyRender(el, d, ctx) {
  const a = d.r.costAnomaly;
  const n = a.flagged.length;
  const prev = d.r.previous?.costAnomaly ?? null;
  const has = !!d.r.previous && !!d.r.previousWindow;
  const title = acAnomalyTitle(a);
  // no in-range day had enough trailing history to judge (the API counts them)
  if (a.judgedDays === 0) {
    el.append(acFigure('—', 'unusual days', null), acStatus('none', `Needs ≥ ${a.minDays} days of history`, title));
    return;
  }
  el.append(
    acFigure(
      String(n),
      n === 1 ? 'unusual spend day' : 'unusual spend days',
      ctx.size === 'S' ? null : [`over the phase’s ${acAnomalyRule(a)}`],
      dwDeltaChip({ cur: n, prev: prev?.flagged ?? null, polarity: -1, fmt: (m) => String(Math.round(m)), subject: 'Unusual spend days', has, ...acCmp(ctx, d.r, d.since) }),
    ),
  );
  el.append(n ? acStatus('warn', `${mxPlural(n, 'day')} over mean + ${a.sigmas}σ`, title) : acStatus('ok', 'No unusual spend day', title));
  if (ctx.size === 'S') return;

  // the range's days, all phases summed
  const byDay = new Map();
  for (const s of a.series) for (const x of s.days) if (x.date >= a.range.from) byDay.set(x.date, (byDay.get(x.date) ?? 0) + x.spend);
  const days = [...byDay.entries()].sort((p, q) => p[0].localeCompare(q[0])).map(([date, spend]) => ({ date, spend }));
  const money = acMoneyFmt([...days.map((x) => x.spend), ...a.flagged.flatMap((f) => [f.spend, f.mean, f.sigma])]);
  const flagged = new Set(a.flagged.map((f) => f.date));
  const spark = node('div', 'ac-detail ac-spark');
  spark.append(node('span', 'ac-k', `daily spend · ${dwDay(days[0].date)} – ${dwDay(days[days.length - 1].date)}`), acAnomalySpark(days, flagged, money));
  el.append(spark);
  if (!n) return;
  const rows = AC_ANOMALY_ROWS[ctx.size];
  const more = () => (n > rows ? el.append(node('div', 'ac-note', `+${n - rows} more`)) : null);
  if (ctx.size === 'M') {
    // the newest flagged days as a short text list: "Oct 3 · Checkout · $41" (the dots mark them on the line)
    const list = node('ul', 'ac-flags');
    for (const f of [...a.flagged].reverse().slice(0, rows)) {
      const li = node('li', '', `${dwDay(f.date)} · ${f.title ?? 'No phase'} · ${money(f.spend)}`);
      li.title = `mean ${money(f.mean)}, σ ${money(f.sigma)}`;
      list.append(li);
    }
    el.append(list);
    return void more();
  }
  // L: the flagged days, newest first: phase, spend, mean and σ
  const table = node('table', 'ac-table');
  const hr = node('tr');
  for (const [t, cls] of [['Day', ''], ['Phase', ''], ['Spend', 'ac-num'], ['Mean', 'ac-num'], ['σ', 'ac-num']]) {
    const th = node('th', cls, t);
    th.scope = 'col';
    hr.append(th);
  }
  const thead = node('thead');
  thead.append(hr);
  const tbody = node('tbody');
  for (const f of [...a.flagged].reverse().slice(0, rows)) {
    const tr = node('tr');
    const day = node('th', '', dwDay(f.date));
    day.scope = 'row';
    tr.append(day, node('td', 'ac-phase', f.title ?? 'No phase'), node('td', 'ac-num', money(f.spend)), node('td', 'ac-num', money(f.mean)), node('td', 'ac-num', money(f.sigma)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  el.append(table);
  more();
}

// ── usage-runway: "Will we hit the usage limits?" (live: no range) ──
async function acRunwayLoad(ctx) {
  const f = acFilters(ctx);
  const r = await acRead(ctx, { project: f.project, tz: MX_LOCAL_TZ, phase: f.phase });
  return { u: r.usageRunway };
}

const AC_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// "Tue Oct 6" (and ", 08:54" for the 5-hour window)
function acWhen(ms, time) {
  const t = new Date(ms);
  const day = `${AC_WEEKDAYS[t.getDay()]} ${dwDay(ms)}`;
  return time ? `${day}, ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}` : day;
}

// A limit's short state: "runs out Tue Oct 6", "resets first", ...
function acLimitText(l) {
  const five = l.window === 'five_hour';
  switch (l.state) {
    case 'projected':
      return `runs out ${acWhen(l.hitsAt, five)}`;
    case 'at_risk':
      return 'running out now';
    case 'reached':
      return 'reached';
    case 'resets_first':
      return `resets first (${acWhen(l.resetsAt, five)})`;
    case 'not_burning':
      return 'not burning measurably';
    case 'no_rate':
      return 'burn rate not measurable yet';
    default:
      return l.staleReason === 'reset' ? 'window reset since the last update' : 'last update too old';
  }
}

// [kind, text, title] for the weekly limit vs the active phase's p85
function acRunwayKind(u) {
  const w = u.weekly;
  const p85 = u.forecast?.status === 'ok' ? u.forecast.p85.date : null;
  if (u.weeklyBeforeP85 === true) {
    const gap = u.gapDays ?? 0;
    return ['bad', gap > 0 ? `Red: weekly limit runs out ${mxPlural(gap, 'day')} before p85` : 'Red: weekly limit runs out by the p85 day', `Red when the weekly limit runs out on or before the active phase’s 85% finish (${dwDay(p85)})`];
  }
  if (u.weeklyBeforeP85 === false) return ['ok', 'Green: weekly limit lasts past p85', `Red when the weekly limit runs out on or before the active phase’s 85% finish (${dwDay(p85)})`];
  // null: no projection, no forecast, or the window resets first
  if (w && (w.state === 'resets_first' || w.state === 'not_burning')) return ['ok', 'Won’t run out this week', 'At this rate the weekly window resets before the limit is reached'];
  if (!w) return ['none', 'Weekly limit: unknown', 'No weekly usage sample yet'];
  if (w.state === 'no_rate') return ['none', 'Weekly limit: unknown', 'Burn rate not measurable yet: no recent samples to measure it from'];
  if (u.forecast?.status !== 'ok') return ['none', 'Weekly vs p85: unknown', u.forecast?.reason ?? 'No phase forecast'];
  return ['none', 'Weekly vs p85: unknown', w.message];
}

function acRunwayRender(el, d, ctx) {
  const u = d.u;
  if (!u) return { empty: 'Usage limits unavailable' };
  if (u.status === 'unavailable') {
    const none = u.reason.startsWith(AC_NO_USAGE);
    el.append(acStatus('none', none ? 'No usage samples yet' : 'Usage limits unavailable'));
    if (ctx.size !== 'S' || !none) el.append(node('div', 'ac-note', `${u.reason[0].toUpperCase()}${u.reason.slice(1)}`));
    return;
  }
  const [kind, text, title] = acRunwayKind(u);
  const S = ctx.size === 'S';
  const w = u.weekly;
  el.append(acFigure(w ? `${Math.round(w.usedPct)}%` : '—', 'of the weekly limit used', w ? `weekly: ${acLimitText(w)}` : 'no weekly sample'));
  el.append(acStatus(kind, text, title));
  if (S) return;
  const rows = node('ul', 'ac-limits');
  for (const l of [u.fiveHour, u.weekly]) {
    if (!l) continue;
    const li = node('li', 'ac-limit');
    const head = node('div', 'ac-limit-head');
    head.append(node('span', 'ac-limit-name', l.label === 'weekly' ? 'Weekly' : '5-hour'), node('span', 'ac-limit-when', acLimitText(l)));
    const bar = node('div', 'ac-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${l.label} limit ${Math.round(l.usedPct)}% used`);
    const fill = node('span', `ac-bar-fill${l.usedPct >= 80 ? ' ac-bar-hot' : ''}`);
    fill.style.width = `${Math.min(100, Math.max(0, l.usedPct))}%`;
    bar.append(fill);
    li.title = l.message;
    li.append(head, bar);
    rows.append(li);
  }
  el.append(rows);
  const f = u.forecast;
  // the forecast the weekly limit is judged against
  if (f?.status === 'ok') el.append(node('div', 'ac-note', `${f.phase.title} forecast: 50% ${acWhen(Date.parse(`${f.p50.date}T12:00`))} · 85% ${acWhen(Date.parse(`${f.p85.date}T12:00`))}`));
  else el.append(node('div', 'ac-note', `No phase forecast: ${f?.reason ?? 'no active phase'}`));
  if (ctx.size === 'L') for (const m of u.messages) el.append(node('div', 'ac-note', m));
}

// ── registration ──
function acWidget(type, title, load, render, ranged = true) {
  dwRegister({
    type,
    title,
    sizes: ['S', 'M', 'L'],
    ranged,
    load,
    render(el, data, ctx) {
      if (data.empty) return { empty: data.empty };
      const box = node('div', `ac ac-${type}`);
      const r = render(box, data, ctx);
      if (r?.empty) return r;
      el.append(box);
    },
  });
}

acWidget('rework-cost', 'What does rework cost?', acReworkLoad, acReworkRender);
acWidget('decision-latency-cost', 'What does waiting on me cost?', acLatencyLoad, acLatencyRender);
acWidget('cost-anomaly', 'Is any spend unusual?', acAnomalyLoad, acAnomalyRender);
acWidget('usage-runway', 'Will we hit the usage limits?', acRunwayLoad, acRunwayRender, false); // live: no range
// registered after widget-agentic.js ran agExpNote: note these widgets already on screen too (it dedupes)
agExpNote(document);
