// ── Dashboard: widget registry + layout renderer, mounted on Home (#dash-root) ──
// Classic script loaded after app.js: uses its globals (node, $, hctx, fbParams,
// fbDrillCards, homeMeta, homeView, openCardModal, currentProject, projectId, activeView).
//
// Widget contract (widget-*.js files call dwRegister):
//   dwRegister({ type, title: string | (params) => string, sizes: ['S','M','L','XL'] subset, load?(ctx) → Promise<data>,
//                render(el, data, ctx) → void | { empty: 'reason' }, onStatus?(msg, el, ctx),
//                params?: [{ key, label, type: 'select'|'text'|'number'|'toggle', options?: [{ value, label }], default?, min?, max? }],
//                ranged?: boolean | (params) => boolean })
//   ranged (default true): the widget's data follows the date range. false: the editor hides its Range
//   field, its override chip never names a range, and a stored range override is ignored (its filters
//   carry Home's range). Live widgets registered elsewhere default to false (DW_UNRANGED).
//   ctx = { id, size, params, projectId, filters, range, shared(key, fetcher), refresh(), drillCards(opts), openCard(id, boardId?) }
//   ctx.range: the widget's effective range (its override, else Home's), see dwRangeOf.
// shared() dedupes one fetch per refresh cycle; the 'home' key is pre-seeded with
// Home's own GET /home read (same filters), so widgets reading it cost no extra request.
// A widget's params.vars ({ phase?, tag?, agent?, workType?, scope?, from?, to?, range? }) override Home's
// filters for that widget alone: its ctx.filters differ, so its shared() keys do too.
// The renderer owns every widget's loading / error / empty / stale states.
//
// Hooks for the editor (dash-editor*.js):
//   dw.layout — the layout on screen; dw.editing — true while the editor owns it
//   dwRenderLayout(layout?) — render a layout without fetching (widgets repaint their last data at once)
//   dwAfterRender(fn) — fn(rootEl) after every layout render and every tab panel render
//   dwDef(type) — a widget type's registration (title, sizes, params schema)
//   DOM: [data-section-id], .dw-row[data-row-id][data-container-id], [data-slot-id],
//        .dw-widget[data-widget-id][data-widget-type], tab panels / tab buttons [data-tab-id]
//
// Shared helpers for widgets:
//   dwDeltaChip({ cur, prev, polarity, fmt, label, subject, has?, labelLong?, none?, title?, since?, previousWindow?, kind?, short? })
//     → the standard delta chip element ("▲ +3 · +50% vs previous 4 weeks"): arrow, signed value, %, the
//     explicit comparison label; colour by polarity (1 = up is good, -1 = down is good, 0 = neutral);
//     has: a previous period exists (default prev != null); widgets pass has: !!resp.previous, so a
//     previous period whose value is null still reads as one. has false → grey "No previous period"
//     (or none), no label; has true but cur or prev null → grey "—" + label ("<subject>: no comparison …");
//     ±0 when the change rounds to zero at fmt's display precision.
//     fmt(magnitude, cur) → string (unsigned), in cur's unit ("2.4 d ▼ −1.2 d", never "−28 h").
//     The % is left out for kind: 'pts' (a change in points is already relative: "−7 pts") and when
//     |prev| < 1 (a tiny base makes a meaningless %): the absolute change only.
//     since (epoch ms, e.g. dwFirstActivity) + previousWindow ({ from, to }): a previous period starting
//     before since (before the board had any activity) is partial → grey "No full previous period", no label
//     (short: a muted "—" with that text as its tooltip, for a compact cell).
//     label: the visible comparison ("vs previous 4 weeks", see dwVs); labelLong: the announced one
//     (default label); title: the chip's tooltip (the exact dates); subject: what's measured ("Cards
//     done"). role=img; its aria-label carries the better / worse verdict.
//   dwVs(range, previousWindow, window?) → { label, labelLong, title } for a ranged chip: a rolling range is
//     named ("vs previous 4 weeks"), a custom one by its previous period's dates ("vs Aug 31 – Sep 13",
//     labelLong "vs the previous 14 days, Aug 31 – Sep 13"); the title holds the exact
//     dates ("Sep 14 – 27 vs Aug 31 – Sep 13"). Empty strings for all time (no previousWindow).
//   dwFirstActivity(ctx) → Promise<epoch ms | null>: the board's first activity (/metrics/flow's
//     firstActivityAt, unfiltered), one read per refresh cycle.
//   dwDay(ms or 'YYYY-MM-DD') → "Oct 24"; dwDays(from, to) → "Sep 14 – 27" / "Aug 30 – Sep 12" (local dates).
//   dwPrevDays(previousWindow) → the comparison window's length in whole days, Math.round((to+1-from)/DAY)
//     (at least 1), or null when there's no previousWindow (all time: no comparison). Use previousWindow,
//     not window: window.to is "now" for a rolling range.
//   dwAgentState(card, activity, reviewer?) → { state, icon, text, rank, detail, label, live, attention }: an
//     agent's displayed state, the one rule Now building and Active agents share (see DW_AGENT_STATES);
//     dwAgentSessions(homeData) → Map board id → SessionView; dwIsReviewer(agent, card, sessions) → boolean;
//     dwNowCard(items) → the agent's now card; dwLive(activity) → is it real work.
//   dwKanbanTarget(cards, preferBoardId?) → { board, ids, rest } | null; dwOpenKanban(target, label): open
//     that board's Kanban with the cards highlighted (banner "N cards highlighted from <label>").

const DW_SIZES = ['S', 'M', 'L', 'XL'];
const DW_ROW_PX = 88;
const dwTypes = new Map(); // type → registration
const dw = {
  board: null, // the project the layout on screen belongs to
  layout: null,
  editing: false, // the editor owns dw.layout: live layout messages don't replace it
  layoutSeq: 0,
  instances: [], // every rendered widget (incl. ones inside tabs)
  last: new Map(), // widget id → { data, at, sig }: last good data (keeps refreshes / re-renders calm)
  cache: new Map(), // this refresh cycle's shared() fetches
  homeWait: null, // Home's first /home read, awaited by the opening cycle
};

// Live widgets (registered in other files) that show the present whatever the range: unranged
// unless their registration says otherwise.
const DW_UNRANGED = ['now-building', 'up-next', 'verticals', 'workspace-boards', 'send-to-agent'];

function dwRegister(def) {
  if (!def || typeof def.type !== 'string' || typeof def.render !== 'function') throw new Error('dwRegister: type and render are required');
  dwTypes.set(def.type, { title: '', sizes: DW_SIZES, params: [], ranged: !DW_UNRANGED.includes(def.type), ...def });
  // late registration: this type's widgets already on screen render for real now
  for (const inst of dw.instances) if (inst.w.type === def.type && inst.frame.isConnected) dwLoad(inst, dw.cache);
}

const dwDef = (type) => dwTypes.get(type) ?? null;

// Does widget w's data follow the date range? (its type's `ranged`, a function of its params or a flag)
function dwRanged(w) {
  const def = dwTypes.get(w?.type);
  if (!def) return true;
  return typeof def.ranged === 'function' ? !!def.ranged(w.params ?? {}) : def.ranged !== false;
}

const dwAfterRenderFns = [];
function dwAfterRender(fn) {
  dwAfterRenderFns.push(fn);
}
function dwRendered(root) {
  for (const fn of dwAfterRenderFns) {
    try {
      fn(root);
    } catch (e) {
      console.error('dashboard afterRender', e);
    }
  }
}

// ── shared delta chip ──
const DW_DAY = 86_400_000;

const dwPrevDays = (pw) => (pw ? Math.max(1, Math.round((pw.to + 1 - pw.from) / DW_DAY)) : null);

// ms, or a local day key 'YYYY-MM-DD' (that local day)
const dwDay = (t) => {
  const d = typeof t === 'string' ? new Date(`${t}T00:00`) : new Date(t);
  return `${MX_MONTHS[d.getMonth()]} ${d.getDate()}`;
};
function dwDays(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  if (a.toDateString() === b.toDateString()) return dwDay(from);
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() ? `${dwDay(from)} – ${b.getDate()}` : `${dwDay(from)} – ${dwDay(to)}`;
}

function dwVs(range, pw, win) {
  if (!pw) return { label: '', labelLong: '', title: '' };
  const prevDates = dwDays(pw.from, pw.to);
  const title = win ? `${dwDays(win.from, win.to)} vs ${prevDates}` : `vs ${prevDates}`;
  if (range?.name) return { label: `vs previous ${range.name}`, labelLong: `vs the previous ${range.name}, ${prevDates}`, title };
  // a custom range has no name: the short label names the previous period's dates ("vs Sep 1 – 14")
  const n = dwPrevDays(pw);
  return { label: `vs ${prevDates}`, labelLong: `vs the previous ${n} days, ${prevDates}`, title };
}

// The board's first activity: unfiltered (scope only) and from / to don't change it. Its URL is the
// throughput KPI's when Home has no filters (the same 8-week read), so they share one fetch.
function dwFirstActivity(ctx) {
  const project = new URLSearchParams(ctx.filters).get('scope') || ctx.projectId;
  const from = Math.floor((Date.now() - 56 * DW_DAY) / 60_000) * 60_000;
  const url = `/metrics/flow?${new URLSearchParams({ project, tz: MX_LOCAL_TZ, from: String(from) })}`;
  return ctx.shared(url, () => mxGet(url)).then((r) => r.firstActivityAt ?? null);
}

// ── agent state: one rule for Now building and Active agents (they must never disagree) ──
// card: the agent's now card (Active agents: dwNowCard over its in-flight cards; Now building: the card
// it shows), or null. activity: its latest status text ("<verb> <detail>"). Only real work ("Edit foo.js")
// is live activity (dwLive): null, "idle …" and "finished …" (a subagent stopped) are none; "needs you …"
// is the session waiting on the human: detail "Needs you", attention true (callers style it with .dw-attn).
// reviewer: a reviewer persona, or a reviewer subagent live on the card (dwIsReviewer).
//   1. the card is blocked                                            → Blocked
//   2. the card is in review: a reviewer on it                        → Reviewing
//                             its owner, with live work               → Working
//                             its owner, nothing live                 → Awaiting review
//   3. a reviewer with live work and no card                          → Reviewing
//   4. it has a card in flight, or any live activity                  → Working
//   5. neither                                                        → Idle
// A builder whose own card is in review is never "Reviewing", and Reviewing is never shown beside an
// In Progress card. An idle session never idles an agent with a card in flight: the card decides. The
// activity only adds detail: a card in progress with no activity reads "Working · waiting for next
// action", never "idle".
// Callers pass the agent's card from ALL its work (the unfiltered /home read), so no card filter (Type,
// Tag, Scope, Phase, Agent) can idle a busy agent.
// Now building labels each card (the card it shows, with that card's agent); Active agents labels each
// agent, by its now card (dwNowCard).
// live: real work is under way (Now building's pulsing dot); never set by an idle / finished ping.
const DW_AGENT_STATES = {
  blocked: { icon: '⚠', text: 'Blocked', rank: 0 },
  working: { icon: '▶', text: 'Working', rank: 1 },
  reviewing: { icon: '◎', text: 'Reviewing', rank: 1 },
  awaiting: { icon: '◷', text: 'Awaiting review', rank: 1 },
  idle: { icon: '○', text: 'Idle', rank: 2 },
};
const dwLive = (activity) => !!activity && !/^(idle|finished|needs you)\b/.test(activity);
function dwAgentState(card, activity, reviewer = false) {
  const verb = activity?.match(/^(idle|finished|needs you)\b/)?.[1] ?? null;
  const live = activity && !verb ? activity : null;
  const attention = verb === 'needs you';
  const busy = card || live || attention;
  let state = 'idle';
  if (card?.blocked) state = 'blocked';
  else if (card?.lane === 'in_review') state = reviewer ? 'reviewing' : live ? 'working' : 'awaiting';
  else if (reviewer && busy && !card) state = 'reviewing';
  else if (busy) state = 'working';
  const s = DW_AGENT_STATES[state];
  const detail = attention ? 'Needs you' : live || (card && state === 'working' ? 'waiting for next action' : null);
  return { state, ...s, detail, label: detail ? `${s.text} · ${detail}` : s.text, live: !!live, attention };
}

// An agent's now card among its in-flight /home items: a blocked one (Blocked wins the pill, and the row
// shows the card it's blocked on), then one with live activity, then in progress, then in review; the
// most recently moved first within each.
function dwNowCard(items) {
  const rank = (nb) => (nb.blocked ? 0 : dwLive(nb.activity) ? 1 : nb.lane === 'in_progress' ? 2 : 3);
  return [...items].sort((x, y) => rank(x) - rank(y) || y.since - x.since)[0] ?? null;
}

// The Kanban a set of cards ([{ id, board: { id, name } }]) opens in: the prefer board when it holds any
// of them, else the board holding the most. → { board, ids, rest } (rest: cards on other boards), or null.
function dwKanbanTarget(items, prefer = null) {
  const byBoard = new Map();
  for (const c of items) {
    if (!byBoard.has(c.board.id)) byBoard.set(c.board.id, { board: c.board, ids: [] });
    byBoard.get(c.board.id).ids.push(c.id);
  }
  const target = byBoard.get(prefer) ?? [...byBoard.values()].sort((x, y) => y.ids.length - x.ids.length)[0];
  return target ? { ...target, rest: items.length - target.ids.length } : null;
}
// Open the target's Kanban with its cards highlighted, the banner naming label ("from <label>"): this
// board in place (setKanbanHighlight), another one via ?cards=…&from=… (highlightCardsFromUrl).
function dwOpenKanban(target, label) {
  if (target.board.id === projectId) {
    setView('kanban');
    setKanbanHighlight(target.ids, label);
    return;
  }
  const e = encodeURIComponent;
  location.search = `?project=${e(target.board.id)}&cards=${e(target.ids.join(','))}&from=${e(label)}&view=kanban`;
}

// board id → SessionView: /home's verticals carry them; standalone Home reads its own
// (app.js home.sessions); widgets' onStatus overwrite them. Cached on the /home data.
function dwAgentSessions(data) {
  if (!data._dwSessions) {
    const m = new Map(typeof home !== 'undefined' ? home.sessions : []);
    for (const v of data.verticals ?? []) if (v.session) m.set(v.project.id, v.session);
    Object.defineProperty(data, '_dwSessions', { value: m, enumerable: false, writable: true });
  }
  return data._dwSessions;
}

// Reviewer role: no role field on team members, so the persona (name/skill) or a live
// reviewer subagent live on the agent's card says so. Owning a card that is in review never does.
function dwIsReviewer(a, card, sessions) {
  if (/review/i.test(a.skill ?? '') || /review/i.test(a.name ?? '')) return true;
  if (!card) return false;
  const s = sessions.get(card.board.id);
  // only while live on the card: a finished (or idle) reviewer subagent still listed doesn't count
  return !!s?.agents?.some((e) => e.task_id === card.id && /review/i.test(e.agent) && dwLive(`${e.verb ?? ''} ${e.detail ?? ''}`.trim()));
}

function dwDeltaChip({ cur, prev, polarity = 0, fmt, label, subject, has = prev != null, labelLong = label, none, title, since, previousWindow, kind, short = false }) {
  const chip = node('span', 'dw-delta');
  chip.setAttribute('role', 'img'); // its aria-label (with the better / worse verdict) is what's announced
  if (title) chip.title = title;
  if (has && since != null && previousWindow && previousWindow.from < since) {
    // the previous period starts before the board's first activity: comparing against it would flatter / alarm
    chip.classList.add('dw-d-flat');
    chip.append(node('span', 'dw-d-chg', short ? '—' : 'No full previous period'));
    if (short) chip.title = 'No full previous period';
    chip.setAttribute('aria-label', `${subject}: no full previous period ${labelLong}`);
    return chip;
  }
  const noneText = none ?? 'No previous period';
  if (!has || cur == null || prev == null) {
    chip.classList.add('dw-d-flat');
    chip.append(node('span', 'dw-d-chg', has ? '—' : noneText));
    if (has) chip.append(node('span', 'dw-d-vs', label));
    chip.setAttribute('aria-label', has ? `${subject}: no comparison ${labelLong}` : `${subject}: ${noneText.toLowerCase()}`);
    return chip;
  }
  // a change that rounds to zero at the display precision ("0 m", "$0.00", "0 pts") is no change
  const shown = fmt(Math.abs(cur - prev), cur);
  const d = Number(shown.replace(/[^\d.]/g, '')) === 0 ? 0 : cur - prev;
  if (d === 0) {
    chip.classList.add('dw-d-flat');
    chip.append(node('span', 'dw-d-chg', '±0'), node('span', 'dw-d-vs', label));
    chip.setAttribute('aria-label', `${subject} unchanged ${labelLong}`);
    return chip;
  }
  const tone = polarity === 0 ? 'flat' : d * polarity > 0 ? 'good' : 'bad';
  chip.classList.add(`dw-d-${tone}`);
  const sign = d > 0 ? '+' : '−';
  const pct = kind !== 'pts' && Math.abs(prev) >= 1 ? `${sign}${Math.abs(Math.round((d / Math.abs(prev)) * 100))}%` : null;
  const arrow = node('span', 'dw-d-arrow', d > 0 ? '▲' : '▼');
  arrow.setAttribute('aria-hidden', 'true');
  const val = `${sign}${shown}`;
  const chg = node('span', 'dw-d-chg');
  chg.append(arrow, node('span', 'dw-d-val', pct ? `${val} · ${pct}` : val));
  chip.append(chg, node('span', 'dw-d-vs', label));
  const verdict = tone === 'good' ? ', better' : tone === 'bad' ? ', worse' : '';
  chip.setAttribute('aria-label', `${subject} ${d > 0 ? 'up' : 'down'} ${val}${pct ? ` (${pct})` : ''} ${labelLong}${verdict}`);
  return chip;
}

// ── built-in types ──
dwRegister({
  type: 'placeholder',
  title: '',
  params: [{ key: 'text', label: 'Text', type: 'text' }],
  render(el, _data, ctx) {
    el.append(node('div', 'dw-placeholder', ctx.params.text || 'Nothing here yet'));
  },
});

// ── refresh cycles ──
function dwDeferred() {
  const d = {};
  d.promise = new Promise((res, rej) => Object.assign(d, { resolve: res, reject: rej }));
  d.promise.catch(() => {}); // a widget that never asks for 'home' leaves no unhandled rejection
  return d;
}
function dwNewCycle(home) {
  dw.cache = new Map();
  if (home) dw.cache.set('home', home);
}
// shared() keys of the live reads (/home, /workspace/summary): fetched without the range (fbNoRange)
const DW_LIVE_KEYS = ['home', 'workspace-summary'];
function dwShared(cache, key, fetcher) {
  if (!cache.has(key)) {
    const p = Promise.resolve().then(fetcher);
    p.catch(() => {});
    cache.set(key, p);
  }
  return cache.get(key);
}

// The /workspace/cards read Home's widgets and its filter meta (fbLoadCards) share: scope only, one
// fetch per refresh cycle under one key, its URL. Readers apply their own card filters (fbCardFilter).
const dwCardsUrl = (project, scope) => `/workspace/cards?project=${encodeURIComponent(project)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`;
function dwCards(ctx) {
  const url = dwCardsUrl(ctx.projectId, new URLSearchParams(ctx.filters).get('scope'));
  return ctx.shared(url, () => mxGet(url));
}
// Home's meta read (no widget ctx): the current cycle's entry, the same key a widget without overrides uses.
function dwCardsRead(project, scope) {
  const url = dwCardsUrl(project, scope);
  return dwShared(dw.cache, url, () => mxGet(url));
}

// Repaint the painted widgets of these types from their last data, no fetch (their render reads
// state that landed since: the board's cards / phases, Home's card meta).
function dwRepaint(types) {
  for (const inst of dw.instances) {
    const last = dw.last.get(inst.w.id);
    if (types.includes(inst.w.type) && inst.painted && inst.frame.isConnected && last?.sig === dwSig(inst.w)) dwPaint(inst, last.data);
  }
}

// Home opened: (re)load the layout; its widgets wait for Home's /home read.
function dwOpen() {
  dw.homeWait = dwDeferred();
  dwNewCycle(dw.homeWait.promise);
  dwLoadLayout();
}

// Home's /home read landed (data) or failed (err): a refresh cycle for every widget.
// Home's own triggers (HOME_REFETCH → scheduleDashboardRefetch → loadHome) debounce this.
function dwRefresh(data, err) {
  const home = err ? Promise.reject(err) : Promise.resolve(data);
  home.catch(() => {});
  if (dw.homeWait) {
    // the opening cycle is waiting on this read: hand it over, no second cycle
    const w = dw.homeWait;
    dw.homeWait = null;
    if (err) w.reject(err);
    else w.resolve(data);
    if (dw.board === currentProject()) return;
  }
  dwNewCycle(home);
  if (!dw.layout || dw.board !== currentProject()) return void dwLoadLayout();
  dwPrune();
  // a tabs widget re-rendering mid-loop replaces its children: skip the detached ones
  for (const inst of [...dw.instances]) if (inst.frame.isConnected) dwLoad(inst, dw.cache);
}

// Home's range changed, nothing else: this cycle's cache stays, so the live reads (keyed without
// the range) are hits and only the reads carrying the range (agent history, KPIs) fetch anew.
function dwRangeRefresh() {
  dwPrune();
  for (const inst of [...dw.instances]) if (inst.frame.isConnected) dwLoad(inst, dw.cache);
}

// Live messages for Home's boards (both sockets): status → onStatus; layout → refetch it.
function dwOnMessage(msg) {
  if (msg.type === 'layout' && msg.project_id && msg.project_id === dw.board) {
    // the editor's draft stays: it hears about the change instead
    if (dw.editing) return void (typeof deExternalChange === 'function' && deExternalChange());
    return void dwLoadLayout();
  }
  if (msg.type !== 'status') return;
  for (const inst of dw.instances) {
    const def = dwTypes.get(inst.w.type);
    if (!def?.onStatus || !inst.frame.isConnected || !inst.painted) continue;
    try {
      def.onStatus(msg, inst.body, inst.ctx);
    } catch (e) {
      console.error('widget onStatus', inst.w.type, e);
    }
  }
}

// ── layout ──
async function dwLoadLayout() {
  const root = $('dash-root');
  const board = currentProject();
  if (!root || !board) return; // no project yet: the first /home read (dwRefresh) brings us back
  if (dw.editing) {
    if (dw.board === board) return void dwRenderLayout(); // Home reopened mid-edit: the draft again
    if (typeof deAbandon === 'function') deAbandon(); // another board: the edit is moot (announced if dirty)
  }
  const seq = ++dw.layoutSeq;
  if (dw.board !== board) {
    dw.last.clear();
    dw.layout = null;
    if (typeof deSyncEditBtn === 'function') deSyncEditBtn(); // nothing to edit until it loads
    root.replaceChildren(node('div', 'dw-root-msg', 'Loading dashboard…'));
  }
  dw.board = board;
  let body;
  try {
    const res = await fetch(`/project/${encodeURIComponent(board)}/layout`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (e) {
    if (seq !== dw.layoutSeq) return;
    if (dw.layout) return; // keep the layout on screen; the next layout message retries
    const msg = node('div', 'dw-root-msg dw-error');
    msg.append(node('div', 'dw-error-msg', `Couldn’t load the dashboard layout (${e.message})`));
    const retry = node('button', 'dw-retry', 'Retry');
    retry.type = 'button';
    retry.onclick = () => dwLoadLayout();
    msg.append(retry);
    root.replaceChildren(msg);
    return;
  }
  if (seq !== dw.layoutSeq || dw.editing) return;
  dwRenderLayout(body.layout);
}

// Render layout (default: dw.layout) as the layout on screen, no fetch. Widgets whose id and
// params are unchanged repaint their last data at once (no skeleton flash on every edit).
function dwRenderLayout(layout) {
  if (layout) dw.layout = layout;
  const root = $('dash-root');
  if (!root || !dw.layout) return;
  for (const inst of dw.instances) dwFadeStop(inst);
  dw.instances = [];
  const frag = document.createDocumentFragment();
  // empty: view mode says so; edit mode with no sections prompts (the editor adds "+ Add section")
  if (dw.editing && !dw.layout.sections?.length) frag.append(node('div', 'dw-edit-empty', 'Add a section to start'));
  else if (!dw.editing && dwIsEmpty(dw.layout)) frag.append(dwEmptyState());
  else for (const sec of dw.layout.sections ?? []) {
    try {
      frag.append(dwSection(sec));
    } catch (e) {
      console.error('dashboard section', sec?.id, e);
      frag.append(node('div', 'dw-root-msg dw-error', `Section “${sec?.title ?? ''}” couldn’t render`));
    }
  }
  root.replaceChildren(frag);
  for (const inst of [...dw.instances]) dwLoad(inst, dw.cache);
  dwRendered(root);
}

// No sections, or no widget anywhere: nothing would show.
function dwIsEmpty(layout) {
  const sections = layout?.sections ?? [];
  return !sections.some((sec) => (sec.rows ?? []).some((r) => (r.slots ?? []).some((s) => (s.widgets ?? []).length)));
}

// View mode, empty layout: say so, offer the editor (≥800px, not embedded: CSS) and the default.
function dwEmptyState() {
  const box = node('div', 'dw-empty-state');
  box.append(node('div', 'dw-empty-title', 'This dashboard is empty'));
  const actions = node('div', 'dw-empty-actions');
  if (!EMBED) {
    const edit = node('button', 'home-btn dw-empty-edit', 'Edit dashboard');
    edit.type = 'button';
    edit.onclick = () => typeof deEnter === 'function' && deEnter();
    actions.append(edit);
  }
  const reset = node('button', 'dw-empty-reset', 'Reset to default');
  reset.type = 'button';
  reset.onclick = () => dwConfirmReset();
  actions.append(reset);
  box.append(actions);
  return box;
}

// "Reset to default": confirm, DELETE the stored layout, then load what the board gets now.
function dwConfirmReset() {
  if (svModal) return;
  const board = dw.board;
  let busy = false;
  const { dlg, close, mount } = openModal({ labelledBy: 'dw-reset-title', describedBy: 'dw-reset-sub', busy: () => busy, fallbackFocus: () => $('home-edit') });
  dlg.classList.add('dw-reset-dlg');
  const title = node('h2', 'sv-title', 'Reset to the default dashboard?');
  title.id = 'dw-reset-title';
  const sub = node('p', 'sv-sub', 'This deletes the saved layout for this board, for everyone viewing it.');
  sub.id = 'dw-reset-sub';
  const err = node('div', 'sv-error');
  err.setAttribute('role', 'alert');
  const foot = node('div', 'sv-foot');
  const cancel = node('button', 'home-btn', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => !busy && close();
  const go = node('button', 'home-btn pl-danger', 'Reset dashboard');
  go.type = 'button';
  go.onclick = async () => {
    if (busy) return;
    busy = true;
    go.disabled = cancel.disabled = true;
    go.textContent = 'Resetting…';
    try {
      const res = await fetch(`/project/${encodeURIComponent(board)}/layout`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 403 ? 'only allowed from this machine' : body.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      busy = false;
      go.disabled = cancel.disabled = false;
      go.textContent = 'Reset dashboard';
      err.textContent = `Couldn’t reset the dashboard (${e.message}).`;
      return;
    }
    busy = false;
    close();
    if (dw.board === board) dwLoadLayout();
  };
  foot.append(node('span', 'sv-foot-note'), cancel, go);
  dlg.append(title, sub, err, foot);
  mount();
  cancel.focus();
}

const dwCollapseKey = (secId) => `dw.collapsed.${dw.board}.${secId}`;
function dwSection(sec) {
  const el = node('section', 'dw-section');
  el.dataset.sectionId = sec.id;
  let stored = null;
  try {
    stored = localStorage.getItem(dwCollapseKey(sec.id));
  } catch {} // storage unavailable: the layout's default
  let collapsed = stored === null ? !!sec.collapsed : stored === '1';
  const toggle = node('button', 'dw-sec-toggle');
  toggle.type = 'button';
  toggle.append(node('span', 'dw-sec-caret', '▾'), node('span', 'dw-sec-title', sec.title));
  const body = node('div', 'dw-sec-body');
  body.id = `dw-sec-${dw.board}-${sec.id}`;
  toggle.setAttribute('aria-controls', body.id);
  const apply = () => {
    el.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  toggle.onclick = () => {
    collapsed = !collapsed;
    apply();
    try {
      localStorage.setItem(dwCollapseKey(sec.id), collapsed ? '1' : '0');
    } catch {} // not persisted, still applies this session
  };
  apply();
  const head = node('header', 'dw-sec-head');
  head.append(toggle);
  dwRows(body, sec.rows ?? [], sec.id);
  el.append(head, body);
  return el;
}

// containerId: the section's or tab's id (data-container-id on each row)
function dwRows(host, rows, containerId) {
  const created = [];
  for (const r of rows) {
    const row = node('div', 'dw-row');
    row.dataset.rowId = r.id;
    // view mode hides a row with no widgets, and keeps an empty slot's space but not its look (CSS)
    row.classList.toggle('dw-row-vacant', !(r.slots ?? []).some((s) => (s.widgets ?? []).length));
    if (containerId != null) row.dataset.containerId = containerId;
    row.style.setProperty('--h', String(r.height));
    for (const s of r.slots ?? []) {
      const slot = node('div', 'dw-slot');
      slot.dataset.slotId = s.id;
      slot.style.setProperty('--span', String(s.span));
      slot.classList.toggle('dw-slot-vacant', !(s.widgets ?? []).length);
      for (const w of s.widgets ?? []) {
        const inst = dwWidget(w);
        created.push(inst);
        slot.append(inst.frame);
      }
      row.append(slot);
    }
    host.append(row);
  }
  return created;
}

// Rows inside another widget (the tabs widget's tab contents); its widgets load at once.
// ctx: the hosting widget's ctx (its refresh cache carries over); tabId: the tab they belong to.
function dwRenderRows(host, rows, ctx, tabId) {
  const created = dwRows(host, rows ?? [], tabId);
  const cache = ctx?._cache ?? dw.cache;
  for (const inst of created) dwLoad(inst, cache);
  dwRendered(host);
  return created;
}

// ── widgets ──
// A widget renders at its configured size at every width: below 800px the slots stack
// full width (CSS), so a widget has at least its desktop width there.

function dwWidget(w) {
  const frame = node('div', 'dw-widget');
  frame.dataset.type = w.type;
  frame.dataset.widgetId = w.id;
  frame.dataset.widgetType = w.type;
  const head = node('div', 'dw-head');
  const title = node('span', 'dw-title');
  // a truncated title shows in full as a tooltip (measured on hover: edit mode's handle narrows it)
  title.addEventListener('pointerenter', () => (title.title = title.scrollWidth > title.clientWidth ? title.textContent : ''));
  const vars = node('span', 'dw-vars');
  const asof = node('span', 'dw-asof');
  head.append(title, vars, asof);
  const body = node('div', 'dw-body');
  frame.append(head, body);
  const inst = { w, frame, head, title, vars, asof, body, ctx: null, seq: 0, painted: false, fadeMO: null };
  inst.ctx = {
    id: w.id,
    size: w.size,
    params: w.params ?? {},
    projectId: dw.board,
    get filters() {
      return dwFilters(w);
    },
    get range() {
      return dwRangeOf(w);
    },
    // an overriding widget's reads are keyed by its own filters (never Home's pre-seeded 'home');
    // the live reads ignore the range, so they're keyed without it (a range-only override shares Home's)
    shared: (key, fetcher) => {
      const live = DW_LIVE_KEYS.includes(key);
      const own = live ? fbNoRange(dwFilters(w)) : dwFilters(w);
      const home = live ? fbNoRange(fbParams(hctx)) : fbParams(hctx);
      return dwShared(inst.ctx._cache ?? dw.cache, own === home ? key : `${key}|vars:${own}`, fetcher);
    },
    refresh: () => dwLoad(inst, new Map()),
    drillCards: async (opts) => {
      await homeMeta();
      if (activeView !== 'home') return;
      // the "Open all" banner names this widget: "from Home · <its title>"
      fbDrillCards(hctx, homeView, { source: inst.title.textContent ? `Home · ${inst.title.textContent}` : 'Home', ...opts });
    },
    openCard: (id, boardId) => {
      if (!boardId || boardId === projectId) openCardModal(id);
      else location.search = `?project=${encodeURIComponent(boardId)}&card=${encodeURIComponent(id)}`;
    },
    _cache: null,
  };
  dwFrameTitle(inst);
  dwFadeRO?.observe(body);
  body.addEventListener('scroll', () => dwFadeCheck(body), { passive: true });
  // content patched in place (onStatus, a refresh paint): check again, at most once per frame
  inst.fadeMO = new MutationObserver(() => dwFadeSoon(body));
  inst.fadeMO.observe(body, { childList: true, subtree: true, characterData: true });
  dw.instances.push(inst);
  return inst;
}

// A widget's own filter overrides (params.vars), only the keys that are set (an unranged widget's
// range / from / to never apply: its data doesn't follow the range).
function dwVars(w) {
  const v = w.params?.vars;
  if (!v || typeof v !== 'object') return null;
  const out = {};
  const keys = dwRanged(w) ? ['scope', 'phase', 'tag', 'agent', 'workType', 'range', 'from', 'to'] : ['scope', 'phase', 'tag', 'agent', 'workType'];
  for (const k of keys) if (v[k] != null && v[k] !== '') out[k] = String(v[k]);
  return Object.keys(out).length ? out : null;
}
// The widget's filters as query params: Home's (hctx) with its params.vars merged over them.
function dwFilters(w) {
  const v = dwVars(w);
  if (!v) return fbParams(hctx);
  const f = { ...hctx.f, ...v };
  if ((v.from || v.to) && !v.range) f.range = 'custom';
  return fbParams({ ...hctx, f });
}
// The widget's effective range, as dwFilters resolves it: { id: '2w' | '4w' | '8w' | 'all' | 'custom',
// weeks (a rolling range's, else null), name ("4 weeks"; null for custom and all time) }.
function dwRangeOf(w) {
  const v = dwVars(w);
  const id = v?.range ?? (v?.from || v?.to ? 'custom' : hctx.f.range) ?? 'all';
  const weeks = MX_RANGES.find(([x]) => x === id)?.[2] ?? null;
  return { id, weeks, name: weeks ? `${weeks} week${weeks === 1 ? '' : 's'}` : null };
}

// "Phase: Launch · Range: 4 wks": the overrides in words, one part per key (quiet, text only).
function dwVarsParts(w) {
  const v = dwVars(w);
  if (!v) return [];
  const m = hctx.meta;
  const parts = [];
  if (v.scope) parts.push(`Board: ${m?.boardById?.get(v.scope)?.label ?? v.scope}`);
  if (v.phase) parts.push(`Phase: ${fbPhaseById(m, v.phase)?.title ?? v.phase}`);
  if (v.tag) parts.push(`Tag: ${v.tag}`);
  if (v.agent) parts.push(`Agent: ${v.agent}`);
  if (v.workType) parts.push(`Type: ${fbWorkTypeLabel(v.workType)}`);
  if (v.from || v.to || v.range === 'custom') parts.push(`Range: ${v.from || '…'} – ${v.to || 'today'}`);
  else if (v.range) parts.push(`Range: ${dwRangeLabel(v.range)}`);
  return parts;
}

// A rolling range, short, from MX_RANGES' week counts: "4 wks", "All time".
function dwRangeLabel(range) {
  const r = MX_RANGES.find(([id]) => id === range);
  if (!r) return range;
  return r[2] == null ? 'All time' : `${r[2]} wk${r[2] === 1 ? '' : 's'}`;
}

function dwFrameTitle(inst) {
  const def = dwTypes.get(inst.w.type);
  const params = inst.w.params ?? {};
  const t = params.title || (def ? (typeof def.title === 'function' ? def.title(params) : def.title) : inst.w.type);
  const parts = dwVarsParts(inst.w);
  inst.title.textContent = t || '';
  // one span per override (the separator leads the next): a narrow chip wraps between them; a
  // very narrow head shows the count instead (CSS), the full list stays in the tooltip
  const full = node('span', 'dw-vars-full');
  full.append(...parts.flatMap((p, i) => (i ? [' ', node('span', 'dw-var', `· ${p}`)] : [node('span', 'dw-var', p)])));
  const count = node('span', 'dw-vars-count', parts.length === 1 ? '1 filter' : `${parts.length} filters`);
  inst.vars.replaceChildren(...(parts.length ? [full, count] : []));
  inst.vars.title = parts.length ? `This widget overrides Home’s filters: ${parts.join(' · ')}` : '';
  inst.head.classList.toggle('hidden', !t && !parts.length);
  inst.ctx.size = inst.w.size;
  inst.body.dataset.size = inst.ctx.size;
}

// Home's meta landed: override chips can name phases / boards now.
function dwRetitle() {
  for (const inst of dw.instances) if (inst.frame.isConnected) dwFrameTitle(inst);
}

// While editing, a widget's body content is inert (no keyboard / clicks); the body itself still
// scrolls. Applied after every paint, since a paint replaces the content.
function dwInertBody(body) {
  const on = dw.editing && body.parentElement?.dataset.widgetType !== 'tabs';
  for (const c of body.children) c.inert = on;
}

function dwState(inst, state) {
  dwInertBody(inst.body);
  for (const s of ['loading', 'error', 'empty', 'stale']) inst.frame.classList.toggle(`is-${s}`, s === state);
  if (state !== 'stale') inst.asof.textContent = '';
  dwFadeSoon(inst.body); // after this paint's content is in
}

const dwClock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function dwPaint(inst, data) {
  const def = dwTypes.get(inst.w.type);
  inst.body.replaceChildren();
  dwState(inst, null);
  try {
    const r = def.render(inst.body, data, inst.ctx);
    inst.painted = true;
    if (r && typeof r.empty === 'string') {
      inst.body.replaceChildren(node('div', 'dw-empty', r.empty));
      dwState(inst, 'empty');
    }
  } catch (e) {
    console.error('widget render', inst.w.type, e);
    dwError(inst, e);
  }
  dwInertBody(inst.body);
}

// A body whose content overflows (and isn't scrolled to its end) gets a subtle bottom fade.
const DW_FADE_SHORT_PX = 96; // a body this short (a 1-unit row) gets the stronger fade
function dwFadeCheck(body) {
  const more = body.scrollHeight - body.clientHeight - body.scrollTop > 1;
  body.classList.toggle('dw-clipped', more);
  body.classList.toggle('dw-clipped-short', more && body.clientHeight < DW_FADE_SHORT_PX);
  // a tab group's strip: a right-edge fade while tabs run past its end
  const strip = body.querySelector(':scope > .dw-tabs-strip');
  if (strip) dwTabsFadeCheck(strip);
}
function dwTabsFadeCheck(strip) {
  if (!strip._dwFade) {
    strip._dwFade = true;
    strip.addEventListener('scroll', () => dwTabsFadeCheck(strip), { passive: true });
  }
  strip.classList.toggle('dw-tabs-more', strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1);
}
function dwFadeSoon(body) {
  if (body._dwFadeQueued) return;
  body._dwFadeQueued = true;
  requestAnimationFrame(() => {
    body._dwFadeQueued = false;
    if (body.isConnected) dwFadeCheck(body);
  });
}
function dwFadeStop(inst) {
  dwFadeRO?.unobserve(inst.body);
  inst.fadeMO?.disconnect();
}
const dwFadeRO = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => entries.forEach((e) => dwFadeCheck(e.target))) : null;

function dwError(inst, e) {
  inst.painted = false;
  const box = node('div', 'dw-error');
  box.append(node('div', 'dw-error-msg', e?.message || String(e)));
  const retry = node('button', 'dw-retry', 'Retry');
  retry.type = 'button';
  retry.onclick = () => inst.ctx.refresh();
  box.append(retry);
  inst.body.replaceChildren(box);
  dwState(inst, 'error');
}

function dwSkeleton(inst) {
  const sk = node('div', 'dw-skel');
  sk.setAttribute('aria-busy', 'true');
  sk.setAttribute('aria-label', 'Loading');
  for (const cls of ['w60', 'w90', 'w75']) sk.append(node('div', `dw-skel-bar ${cls}`));
  inst.body.replaceChildren(sk);
  dwState(inst, 'loading');
}

// (Re)load one widget: last good data paints at once; a failed refresh keeps it, marked stale.
async function dwLoad(inst, cache) {
  const def = dwTypes.get(inst.w.type);
  inst.ctx.projectId = dw.board;
  dwFrameTitle(inst);
  if (!def) {
    inst.painted = false;
    inst.body.replaceChildren(node('div', 'dw-placeholder', 'Widget not available'));
    dwState(inst, null);
    return;
  }
  if (!def.load) return void dwPaint(inst, undefined);
  const seq = ++inst.seq;
  const sig = dwSig(inst.w);
  const last0 = dw.last.get(inst.w.id);
  const prev = last0?.sig === sig ? last0 : null; // data for other params (e.g. another metric) doesn't fit
  if (prev && !inst.painted) dwPaint(inst, prev.data);
  else if (!prev) dwSkeleton(inst);
  inst.ctx._cache = cache;
  let data;
  try {
    data = await def.load(inst.ctx);
  } catch (e) {
    if (seq !== inst.seq || !inst.frame.isConnected) return;
    const last = dw.last.get(inst.w.id);
    if (!last || last.sig !== sig) return void dwError(inst, e);
    if (!inst.painted) dwPaint(inst, last.data);
    dwState(inst, 'stale');
    inst.asof.textContent = `as of ${dwClock(last.at)}`;
    inst.asof.title = e?.message || String(e);
    return;
  }
  if (seq !== inst.seq || !inst.frame.isConnected) return;
  dw.last.set(inst.w.id, { data, at: Date.now(), sig });
  dwPaint(inst, data);
}

// what a widget's data depends on: its type and params (a retitle keeps the data)
const dwSig = (w) => `${w.type}|${JSON.stringify({ ...w.params, title: undefined })}`;

function dwPrune() {
  for (const i of dw.instances) if (!i.frame.isConnected) dwFadeStop(i);
  dw.instances = dw.instances.filter((i) => i.frame.isConnected);
}

// app.js may have opened Home before this file loaded (EARLY_VIEW): mount now, and if
// that /home read already landed (its dwRefresh call was skipped) hand it to the widgets.
if (activeView === 'home') {
  dwOpen();
  if (home.data && home.key === fbParams(hctx, true, false)) dwRefresh(home.data);
}
