// Dashboard widget: active-agents. Who is on what right now, from Home's GET /home
// (agents[] + now_building to join agent → current card). Live status messages
// (onStatus) update activity and session state in place, without a refetch.
// Uses app.js globals read-only: node, avatarEl, teamByName, openAgentEditor,
// openModal, svModal, fmtElapsed, LANE_NAME, home, tick, hctx, cards, projectId,
// mxSparkline, mxMoney, mxPlural, MX_MONTHS, fmtTokens, setView, setKanbanHighlight; and
// dashboard.js' dwDeltaChip, dwVs, dwDays, dwFirstActivity.

const AA_STATES = {
  blocked: { icon: '⚠', text: 'Blocked', rank: 0 },
  working: { icon: '▶', text: 'Working', rank: 1 },
  reviewing: { icon: '◎', text: 'Reviewing', rank: 1 },
  idle: { icon: '○', text: 'Idle', rank: 2 },
};
const AA_MAX_STACK = 5;
const aaPanel = { close: null, agentId: null, paint: null }; // the open side panel (one at a time)

// board id → SessionView: /home's verticals carry them; standalone Home reads its
// own (app.js home.sessions); status messages overwrite them (onStatus).
function aaSessions(data) {
  if (!data._aaSessions) {
    const m = new Map(typeof home !== 'undefined' ? home.sessions : []);
    for (const v of data.verticals ?? []) if (v.session) m.set(v.project.id, v.session);
    Object.defineProperty(data, '_aaSessions', { value: m, enumerable: false, writable: true });
  }
  return data._aaSessions;
}

const aaOwns = (a, nb) => !!nb.agent && (nb.agent === a.name || nb.agent === a.id);

// The agent's current card: a blocked one first, else the one that most recently moved.
function aaCard(data, a) {
  const mine = (data.now_building ?? []).filter((nb) => aaOwns(a, nb));
  mine.sort((x, y) => Number(y.blocked) - Number(x.blocked) || y.since - x.since);
  return mine[0] ?? null;
}

// Reviewer role: no role field on team members, so the persona (name/skill) or a live
// reviewer subagent on the agent's card says so.
function aaIsReviewer(a, card, sessions) {
  if (/review/i.test(a.skill ?? '') || /review/i.test(a.name ?? '')) return true;
  if (!card) return false;
  const s = sessions.get(card.board.id);
  return !!s?.agents?.some((e) => e.task_id === card.id && /review/i.test(e.agent));
}

function aaInfo(data, a) {
  const sessions = aaSessions(data);
  const card = aaCard(data, a);
  const needsYou = !!card && sessions.get(card.board.id)?.state === 'needs_you';
  let state = 'idle';
  if (card?.blocked) state = 'blocked'; // only its own card's blocker: a needs_you board shows in the header
  else if (card?.lane === 'in_review' || (aaIsReviewer(a, card, sessions) && (card || a.now))) state = 'reviewing';
  else if (card || a.now) state = 'working';
  return { a, card, state, needsYou };
}

function aaRows(data) {
  return (data.agents ?? [])
    .map((a) => aaInfo(data, a))
    .sort((x, y) => AA_STATES[x.state].rank - AA_STATES[y.state].rank || x.a.name.localeCompare(y.a.name));
}

function aaPill(state) {
  const s = AA_STATES[state];
  const p = node('span', `aa-pill aa-${state}`);
  const icon = node('span', 'aa-pill-icon', s.icon);
  icon.setAttribute('aria-hidden', 'true');
  p.append(icon, node('span', 'aa-pill-text', s.text));
  return p;
}

function aaSince(since, cls) {
  const el = node('span', cls, fmtElapsed(since));
  el.dataset.since = String(since); // app.js's Home tick keeps it current
  return el;
}

// Boards whose session waits on the human: one quiet line each (max 2, then +N).
function aaWaiting(data) {
  const names = new Map((data.verticals ?? []).map((v) => [v.project.id, v.project]));
  if (data.project) names.set(data.project.id, names.get(data.project.id) ?? data.project);
  for (const nb of data.now_building ?? []) if (!names.has(nb.board.id)) names.set(nb.board.id, nb.board);
  const waiting = [];
  for (const [id, s] of aaSessions(data)) {
    if (s?.state !== 'needs_you') continue;
    const b = names.get(id);
    if (!b) continue; // not a board this Home shows
    waiting.push(typeof homeBoardName === 'function' ? homeBoardName(b) : b.name);
  }
  if (!waiting.length) return null;
  const box = node('div', 'aa-waiting');
  for (const name of waiting.slice(0, 2)) box.append(node('div', 'aa-waiting-line', `${name} is waiting on you`));
  if (waiting.length > 2) box.append(node('div', 'aa-waiting-line', `+${waiting.length - 2}`));
  return box;
}

function aaSummary(rows) {
  const n = (st) => rows.filter((r) => st.includes(r.state)).length;
  const el = node('div', 'aa-summary');
  el.append(
    node('span', 'aa-sum-n', `${n(['working', 'reviewing'])} active`),
    node('span', 'aa-sum-sep', '·'),
    node('span', `aa-sum-n${n(['blocked']) ? ' aa-sum-blocked' : ''}`, `${n(['blocked'])} blocked`),
    node('span', 'aa-sum-sep', '·'),
    node('span', 'aa-sum-n', `${n(['idle'])} idle`),
  );
  return el;
}

function aaStack(rows) {
  const stack = node('div', 'aa-stack');
  for (const r of rows.slice(0, AA_MAX_STACK)) {
    const av = avatarEl(r.a, 32);
    av.classList.add('aa-stack-av', `aa-${r.state}`);
    av.title = `${r.a.name} · ${AA_STATES[r.state].text}`;
    stack.append(av);
  }
  const more = rows.length - AA_MAX_STACK;
  if (more > 0) stack.append(node('span', 'aa-stack-more', `+${more}`));
  stack.setAttribute('aria-label', rows.map((r) => `${r.a.name}, ${AA_STATES[r.state].text}`).join('; '));
  stack.setAttribute('role', 'img');
  return stack;
}

function aaRow(r, data, ctx, el) {
  const { a, card } = r;
  const row = node('button', `aa-row aa-row-${r.state}`);
  row.type = 'button';
  row.dataset.agent = a.id;
  row.setAttribute('aria-label', `${a.name}, ${AA_STATES[r.state].text}${card ? `, ${card.title}` : ''}. Open details`);
  const main = node('div', 'aa-main');
  const top = node('div', 'aa-top');
  const id = node('div', 'aa-id');
  id.append(node('span', 'aa-name', a.name), node('span', 'aa-skill', a.skill ?? 'no skill'));
  top.append(id, aaPill(r.state));
  const line = node('div', 'aa-line');
  if (card) {
    line.append(node('span', 'aa-card', card.title), node('span', 'aa-lane', LANE_NAME(card.lane)), aaSince(card.since, 'aa-elapsed'));
  } else {
    line.append(node('span', 'aa-card aa-muted', a.now ?? 'No current card'));
  }
  main.append(top, line);
  if (ctx.size === 'L') main.append(node('div', 'aa-quiet', `${a.cards} card${a.cards === 1 ? '' : 's'} · ${a.hours} h all-time`));
  row.append(avatarEl(a, 30), main);
  row.onclick = () => aaOpenPanel(a.id, data, ctx, el);
  return row;
}

function aaPaint(el, data, ctx) {
  const rows = aaRows(data);
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.agent : null;
  el.replaceChildren();
  if (ctx.size === 'S') {
    const wrap = node('div', 'aa-s');
    wrap.append(aaSummary(rows));
    const waitingS = aaWaiting(data);
    if (waitingS) wrap.append(waitingS);
    wrap.append(aaStack(rows));
    el.append(wrap);
    return;
  }
  const list = node('div', 'aa-list');
  list.setAttribute('role', 'list');
  for (const r of rows) {
    const item = node('div', 'aa-item');
    item.setAttribute('role', 'listitem');
    item.append(aaRow(r, data, ctx, el));
    list.append(item);
  }
  el.append(aaSummary(rows));
  const waiting = aaWaiting(data);
  if (waiting) el.append(waiting);
  el.append(list);
  // a live repaint keeps keyboard focus on the same agent's row
  if (focused) list.querySelector(`[data-agent="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

// ── side panel ──
// Now (live, repainted on every status ping) over the agent's history for the dashboard's
// range (GET /agents/:name/history, compare=previous; fetched once per range, not per ping).
const AA_HIST_PAGE = 20;
const AA_DAY = 86_400_000;
const AA_OUTCOME = { done: 'Done', reassigned: 'Reassigned', redirected: 'Redirected' };

// Durations in human units: 45 m, 5.5 h, 3.2 d. ref: format in the unit ref would get (a delta in
// its value's unit: "2.4 d ▼ −1.2 d", not "−28 h").
function aaDur(ms, ref = ms) {
  if (ms === null || ms === undefined) return '—';
  const v = Math.abs(ms);
  const r = Math.abs(ref ?? ms);
  const n = (x) => (x < 10 ? x.toFixed(1).replace(/\.0$/, '') : String(Math.round(x)));
  if (r < 3_600_000) return `${Math.round(v / 60_000)} m`;
  if (r < 48 * 3_600_000) return `${n(v / 3_600_000)} h`;
  return `${n(v / AA_DAY)} d`;
}

// Tokens in the unit ref would get (fmtTokens' units): "2.0M ▼ −0.4M", not "−450.0k".
const aaTok = (n, ref = n) => (ref >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : ref >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n | 0));

// pol: 1 = up is good, -1 = down is good, 0 = neutral. diff(magnitude, cur): the change in the value's units.
const AA_STATS = [
  { key: 'cardsDone', label: 'Cards done', pol: 1, fmt: (v) => String(v), diff: (d) => String(d) },
  { key: 'firstPassRate', label: 'First pass', pol: 1, kind: 'pts', fmt: (v) => (v === null ? '—' : `${Math.round(v * 100)}%`), diff: (d) => `${Math.round(d * 100)} pts` },
  { key: 'medianCycleMs', label: 'Median cycle', pol: -1, fmt: aaDur, diff: aaDur },
  { key: 'cost', label: 'Cost', pol: -1, fmt: mxMoney, diff: mxMoney },
  { key: 'tokens', label: 'Tokens', pol: 0, fmt: fmtTokens, diff: aaTok },
];

// The history read for the widget's range: Home's filters (ctx.filters), only what the endpoint takes.
function aaHistoryUrl(name, ctx) {
  const f = new URLSearchParams(ctx.filters);
  const q = new URLSearchParams({ project: f.get('scope') || ctx.projectId });
  for (const k of ['from', 'to', 'workType']) if (f.get(k)) q.set(k, f.get(k));
  const tz = typeof hctx !== 'undefined' ? hctx.f?.tz : null;
  if (tz) q.set('tz', tz);
  q.set('compare', 'previous');
  return `/agents/${encodeURIComponent(name)}/history?${q}`;
}

// "▲ +3 · +50% vs previous 2 weeks" (dwDeltaChip): the range's name (a custom range "vs prev 14 d"),
// the exact dates as the tooltip, grey when there's nothing (or no full period, since) to compare.
function aaDelta(s, h, range, since) {
  return dwDeltaChip({
    cur: h.totals?.[s.key],
    prev: h.previous?.[s.key],
    has: !!h.previous && !!h.previousWindow,
    polarity: s.pol,
    fmt: s.diff,
    kind: s.kind,
    subject: s.label,
    ...dwVs(range, h.previousWindow, h.window),
    since,
    previousWindow: h.previousWindow,
  });
}

function aaDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${MX_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function aaOpenPanel(agentId, data, ctx, el) {
  if (svModal || aaPanel.close) return;
  const { backdrop, dlg, close, mount } = openModal({
    labelledBy: 'aa-panel-title',
    describedBy: 'aa-panel-sub',
    busy: () => false,
    // a live repaint replaced the opening row: focus its successor (else the first row)
    fallbackFocus: () => el.querySelector(`[data-agent="${CSS.escape(agentId)}"]`) ?? el.querySelector('.aa-row'),
    onClose: () => Object.assign(aaPanel, { close: null, agentId: null, paint: null }),
  });
  backdrop.classList.add('aa-backdrop');
  dlg.classList.add('aa-panel');
  const top = node('div', 'aa-p-part'); // identity + Now: repainted live
  const hist = node('div', 'aa-p-part'); // stats, trend, history: repainted only when the history loads
  // a short summary is announced on load (not the whole block): a dedicated, visually hidden region
  const live = node('div', 'aa-sr');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  dlg.append(top, hist, live);
  let taskFor = null; // `${card id}:${blocked}` whose task (branch, blocker reason) is loaded / loading
  let task = null;
  let branch = null; // { id, value }: the card's last known branch, kept visible while its task refetches
  let agentName = null;
  // since: the board's first activity (a previous period starting before it isn't a full one)
  const hs = { url: null, seq: 0, status: 'loading', data: null, since: null, error: '', shown: AA_HIST_PAGE };
  const isOpen = () => aaPanel.close === close;
  const focusClose = () => dlg.querySelector('[data-k="close"]')?.focus();

  function loadHistory(url) {
    const seq = ++hs.seq;
    Object.assign(hs, { url, status: 'loading', data: null, since: null, error: '', shown: AA_HIST_PAGE });
    renderHist();
    const hist = fetch(url).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      return body;
    });
    // without it the chips still compare (as before), they just can't tell a partial period
    const since = dwFirstActivity(ctx).catch(() => null);
    Promise.all([hist, since])
      .then(([d, first]) => {
        if (!isOpen() || seq !== hs.seq) return;
        Object.assign(hs, { status: 'ok', data: d, since: first });
        renderHist();
        live.textContent = `Loaded ${mxPlural(d.cards.length, 'card')}`;
      })
      .catch((err) => {
        if (!isOpen() || seq !== hs.seq) return;
        Object.assign(hs, { status: 'error', error: err.message });
        renderHist();
        live.textContent = 'Couldn’t load the history';
      });
  }

  function statsSection(h) {
    const range = ctx.range;
    const sec = node('section', 'aa-p-sec');
    const label = node('h3', 'aa-p-label', 'Stats');
    // a rolling range by its name, a custom one by its dates ("Sep 14 – 27")
    label.append(node('span', 'aa-p-range', !h.window ? ' · all time' : range.name ? ` · last ${range.name}` : ` · ${dwDays(h.window.from, h.window.to)}`));
    const grid = node('dl', 'aa-p-stats');
    for (const s of AA_STATS) {
      const box = node('div', 'aa-p-stat');
      const dd = node('dd');
      dd.append(node('span', 'aa-p-val', s.fmt(h.totals[s.key])), aaDelta(s, h, range, hs.since));
      box.append(node('dt', null, s.label), dd);
      grid.append(box);
    }
    const added = h.cards.reduce((n, c) => n + (c.lines_added ?? 0), 0);
    const removed = h.cards.reduce((n, c) => n + (c.lines_removed ?? 0), 0);
    sec.append(label, grid, node('p', 'aa-p-note', `+${added.toLocaleString('en-US')} / −${removed.toLocaleString('en-US')} lines changed in range`));
    return sec;
  }

  function trendSection(h) {
    const sec = node('section', 'aa-p-sec');
    sec.append(node('h3', 'aa-p-label', 'Cards done per week'));
    const vals = (h.weekly ?? []).map((w) => w.cardsDone);
    if (vals.length < 2) {
      sec.append(node('div', 'aa-p-muted', 'Not enough weeks for a trend yet'));
      return sec;
    }
    const fig = node('div', 'aa-p-spark');
    fig.setAttribute('role', 'img');
    fig.setAttribute('aria-label', `Cards done per week, oldest first: ${vals.join(', ')}`);
    const cap = node('div', 'aa-p-spark-cap');
    // the last bucket is "this week" only when the range runs to today (all time / a rolling range)
    const endsToday = !h.window || new Date(h.window.to).toDateString() === new Date().toDateString();
    cap.append(node('span', null, mxPlural(vals.length, 'week')), node('span', null, `peak ${Math.max(...vals)} · ${endsToday ? 'this week' : `week to ${aaDay(h.window.to)}`} ${vals[vals.length - 1]}`));
    fig.append(mxSparkline(vals), cap);
    sec.append(fig);
    return sec;
  }

  function historyRow(c) {
    const li = node('li', 'aa-h-row');
    const t = node('button', 'aa-h-title', c.title);
    t.type = 'button';
    t.dataset.k = `card:${c.id}`;
    t.title = c.title;
    t.onclick = () => {
      close();
      ctx.openCard(c.id, c.board.id);
    };
    const meta = node('div', 'aa-h-meta');
    const outcome = AA_OUTCOME[c.outcome] ?? LANE_NAME(c.lane);
    meta.append(node('span', `aa-h-out aa-h-out-${c.outcome in AA_OUTCOME ? c.outcome : 'open'}`, outcome));
    meta.append(node('span', null, mxPlural(c.rounds, 'round')));
    const fp = c.first_pass === true ? ['✓', 'yes', 'aa-h-pass'] : c.first_pass === false ? ['✗', 'no', 'aa-h-fail'] : ['–', 'not reviewed', ''];
    const fpEl = node('span', `aa-h-fp ${fp[2]}`);
    const fpMark = node('span', null, fp[0]);
    fpMark.setAttribute('aria-hidden', 'true');
    fpEl.append('First pass ', fpMark, node('span', 'aa-sr', fp[1]));
    meta.append(fpEl);
    meta.append(node('span', c.blockers ? 'aa-h-blk' : null, c.blockers ? `${mxPlural(c.blockers, 'blocker')} · ${aaDur(c.blocked_ms)}` : 'No blockers'));
    const when = node('span', 'aa-h-when', aaDay(c.last_worked_at));
    const head = node('div', 'aa-h-head');
    head.append(t, when);
    li.append(head, meta);
    return li;
  }

  function historySection(h) {
    const sec = node('section', 'aa-p-sec');
    const headRow = node('div', 'aa-p-sec-head');
    headRow.append(node('h3', 'aa-p-label', `History · ${mxPlural(h.cards.length, 'card')}`));
    const kb = node('button', 'home-btn aa-p-kanban', 'Open in Kanban');
    kb.type = 'button';
    kb.dataset.k = 'kanban';
    kb.disabled = !h.cards.length;
    // Where the highlight lands: this board's Kanban when any of the cards are on it; else the board
    // holding the most of them (?cards=, like Metrics' "Open all"). Never an empty highlight.
    const here = h.cards.filter((c) => cards.has(c.id));
    const byBoard = new Map();
    for (const c of h.cards) {
      if (!byBoard.has(c.board.id)) byBoard.set(c.board.id, { board: c.board, ids: [] });
      byBoard.get(c.board.id).ids.push(c.id);
    }
    const target = here.length ? null : [...byBoard.values()].sort((x, y) => y.ids.length - x.ids.length)[0];
    const shownN = here.length || target?.ids.length || 0;
    kb.onclick = () => {
      close();
      if (target) {
        location.search = `?project=${encodeURIComponent(target.board.id)}&cards=${encodeURIComponent(target.ids.join(','))}&view=kanban`;
        return;
      }
      setView('kanban');
      setKanbanHighlight(here.map((c) => c.id));
    };
    headRow.append(kb);
    sec.append(headRow);
    const hidden = h.cards.length - shownN;
    if (h.cards.length && (target || hidden)) {
      const where = target ? `Opens ${target.board.name}. ` : '';
      const rest = hidden ? `${mxPlural(hidden, 'card')} on other boards ${hidden === 1 ? 'isn’t' : 'aren’t'} shown there.` : '';
      sec.append(node('p', 'aa-p-note', `${where}${rest}`.trim()));
    }
    if (!h.cards.length) {
      sec.append(node('div', 'aa-p-muted', `${agentName} worked no cards in this range.`));
      return sec;
    }
    const list = node('ul', 'aa-h-list');
    for (const c of h.cards.slice(0, hs.shown)) list.append(historyRow(c));
    sec.append(list);
    const rest = h.cards.length - hs.shown;
    if (rest > 0) {
      const n = Math.min(AA_HIST_PAGE, rest);
      const more = node('button', 'home-link aa-h-more', `Show ${n} more`);
      more.type = 'button';
      more.dataset.k = 'more';
      more.onclick = () => {
        const first = h.cards[hs.shown];
        hs.shown += n;
        renderHist();
        dlg.querySelector(`[data-k="card:${CSS.escape(first.id)}"]`)?.focus();
      };
      sec.append(more);
    }
    return sec;
  }

  function renderHist() {
    const hadFocus = hist.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    if (hs.status === 'loading') {
      const sk = node('section', 'aa-p-sec');
      sk.setAttribute('aria-label', 'Loading history');
      const grid = node('div', 'aa-p-skel-grid');
      for (let i = 0; i < 4; i++) grid.append(node('div', 'dw-skel-bar aa-p-skel-stat'));
      const lines = node('div', 'dw-skel');
      for (const w of ['w90', 'w75', 'w90', 'w60']) lines.append(node('div', `dw-skel-bar ${w}`));
      sk.append(node('h3', 'aa-p-label', 'Stats'), grid, node('div', 'dw-skel-bar aa-p-skel-spark'), lines);
      hist.replaceChildren(sk);
    } else if (hs.status === 'error') {
      const sec = node('section', 'aa-p-sec');
      const box = node('div', 'aa-p-error');
      box.setAttribute('role', 'alert');
      const retry = node('button', 'home-btn', 'Retry');
      retry.type = 'button';
      retry.dataset.k = 'retry';
      retry.onclick = () => loadHistory(hs.url);
      box.append(node('span', null, `Couldn’t load the history: ${hs.error}`), retry);
      sec.append(box);
      hist.replaceChildren(sec);
    } else {
      const h = hs.data;
      hist.replaceChildren(statsSection(h), trendSection(h), historySection(h));
    }
    // keep focus on the same control; if it's gone (retry → loading), the close button
    if (!hadFocus) return;
    const same = hist.querySelector(`[data-k="${CSS.escape(hadFocus)}"]`);
    if (same) same.focus();
    else focusClose();
  }

  // internal: a repaint from the task fetch itself (a failure then doesn't retry right away)
  const paint = (d, internal = false) => {
    const a = (d.agents ?? []).find((x) => x.id === agentId);
    if (!a) return close();
    agentName = a.name;
    const r = aaInfo(d, a);
    const card = r.card;

    const head = node('div', 'aa-p-head');
    const id = node('div', 'aa-p-id');
    const title = node('h2', 'aa-p-name', a.name);
    title.id = 'aa-panel-title';
    const sub = node('div', 'aa-p-skill', a.skill ?? 'no skill');
    sub.id = 'aa-panel-sub';
    id.append(title, sub);
    const x = node('button', 'aa-p-close', '✕');
    x.type = 'button';
    x.dataset.k = 'close';
    x.setAttribute('aria-label', 'Close');
    x.onclick = close;
    head.append(avatarEl(a, 48), id, x);
    const edit = node('button', 'home-btn aa-p-edit', 'Edit');
    edit.type = 'button';
    edit.dataset.k = 'edit';
    edit.setAttribute('aria-label', `Edit ${a.name}`);
    edit.onclick = () => {
      close(); // the editor runs its own focus trap / Esc
      openAgentEditor(teamByName.get(a.name) ?? a);
    };
    const ident = node('div', 'aa-p-actions');
    ident.append(aaPill(r.state), edit);

    const now = node('section', 'aa-p-sec');
    now.append(node('h3', 'aa-p-label', 'Now'));
    if (card) {
      // the card's task (branch, blocker reason): once per card, again when it becomes blocked
      const key = `${card.id}:${card.blocked}`;
      // a failed fetch is retried on the next outside repaint (status ping, refresh): once per repaint
      if (taskFor !== key || (task?.failed && !internal)) {
        taskFor = key;
        task = null;
        fetch(`/task/${encodeURIComponent(card.id)}`)
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
          .then((t) => {
            if (taskFor !== key) return;
            task = t ?? {};
            branch = { id: card.id, value: task.branch ?? null };
            if (aaPanel.paint === paint) paint(aaPanel.data, true);
          })
          .catch(() => {
            if (taskFor !== key) return;
            task = { failed: true };
            if (aaPanel.paint === paint) paint(aaPanel.data, true);
          });
      }
      now.append(node('div', 'aa-p-card', card.title));
      const meta = node('div', 'aa-p-meta');
      meta.append(node('span', 'aa-lane', LANE_NAME(card.lane)), node('span', 'aa-sum-sep', '·'), 'in this state for ', aaSince(card.since, 'aa-elapsed'));
      now.append(meta);
      if (branch?.id === card.id && branch.value) {
        const br = node('div', 'aa-p-branch');
        br.append(node('span', 'aa-p-branch-k', 'Branch'), node('code', 'aa-p-branch-v', branch.value));
        now.append(br);
      }
      if (a.now) now.append(node('div', 'aa-p-activity', a.now));
      if (card.blocked) {
        const why = node('div', 'aa-p-reason');
        why.append(node('span', 'aa-p-reason-k', 'Blocker'));
        const reason = !task ? 'Loading…' : task.failed ? 'Couldn’t load the reason' : task.blocked_reason || 'No reason given';
        why.append(node('span', 'aa-p-reason-v', reason));
        now.append(why);
      } else if (r.needsYou) {
        now.append(node('div', 'aa-p-reason', 'The session is waiting for a decision from you.'));
      }
      const open = node('button', 'home-btn aa-p-open', 'Open card');
      open.type = 'button';
      open.dataset.k = 'open';
      open.onclick = () => {
        close();
        ctx.openCard(card.id, card.board.id);
      };
      now.append(open);
    } else {
      taskFor = null;
      task = null;
      now.append(node('div', 'aa-p-muted', a.now ?? 'No current card'));
    }

    const hadFocus = top.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    top.replaceChildren(head, ident, now);
    // a live repaint keeps focus on the same control (else the close button)
    if (hadFocus) (top.querySelector(`[data-k="${hadFocus}"]`) ?? x).focus();
    // the history follows the range: a new range refetches, a status ping doesn't
    const url = aaHistoryUrl(a.name, ctx);
    if (url !== hs.url) loadHistory(url);
    return x;
  };

  Object.assign(aaPanel, { close, agentId, paint, data });
  const closeBtn = paint(data);
  mount();
  closeBtn?.focus();
}

// keep the open panel's elapsed time current (it lives outside Home's view)
tick.add(() => {
  if (!aaPanel.close) return;
  for (const el of document.querySelectorAll('.aa-panel [data-since]')) el.textContent = fmtElapsed(Number(el.dataset.since));
});

dwRegister({
  type: 'active-agents',
  title: 'Active agents',
  sizes: ['S', 'M', 'L'],
  ranged: false, // the rows are live; the side panel follows Home's range itself
  load(ctx) {
    return ctx.shared('home', async () => {
      const f = fbNoRange(ctx.filters); // the rows are live: the range shapes the panel's history only
      const res = await fetch(`/home?project=${encodeURIComponent(ctx.projectId)}${f ? `&${f}` : ''}`);
      if (!res.ok) throw new Error(`Couldn’t load agents (HTTP ${res.status})`);
      return res.json();
    });
  },
  render(el, data, ctx) {
    if (!data?.agents?.length) return { empty: 'No agents yet. Agents appear once a card is assigned.' };
    el._aaData = data;
    aaPaint(el, data, ctx);
    if (aaPanel.paint) {
      aaPanel.data = data;
      aaPanel.paint(data);
    }
  },
  // live: session state + activity text, applied to this widget's data, then repaint
  onStatus(msg, el, ctx) {
    const data = el._aaData;
    if (!data || !msg.status) return;
    if (msg.session && msg.project_id) aaSessions(data).set(msg.project_id, msg.session);
    const st = msg.status;
    const act = `${st.verb} ${st.detail ?? ''}`.trim();
    for (const nb of data.now_building ?? []) {
      if (nb.id !== st.task_id) continue;
      nb.activity = act;
      for (const a of data.agents) if (aaOwns(a, nb)) a.now = act;
    }
    const scroll = el.querySelector('.aa-list')?.scrollTop ?? 0;
    aaPaint(el, data, ctx);
    const list = el.querySelector('.aa-list');
    if (list) list.scrollTop = scroll;
    if (aaPanel.paint && aaPanel.data === data) aaPanel.paint(data);
  },
});
