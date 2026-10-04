// ── Dashboard: widget registry + layout renderer, mounted on Home (#dash-root) ──
// Classic script loaded after app.js: uses its globals (node, $, hctx, fbParams,
// fbDrillCards, homeMeta, homeView, openCardModal, currentProject, projectId, activeView).
//
// Widget contract (widget-*.js files call dwRegister):
//   dwRegister({ type, title: string | (params) => string, sizes: ['S','M','L','XL'] subset, load?(ctx) → Promise<data>,
//                render(el, data, ctx) → void | { empty: 'reason' }, onStatus?(msg, el, ctx),
//                params?: [{ key, label, type: 'select'|'text'|'number'|'toggle', options?: [{ value, label }], default?, min?, max? }] })
//   ctx = { id, size, params, projectId, filters, shared(key, fetcher), refresh(), drillCards(opts), openCard(id, boardId?) }
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

function dwRegister(def) {
  if (!def || typeof def.type !== 'string' || typeof def.render !== 'function') throw new Error('dwRegister: type and render are required');
  dwTypes.set(def.type, { title: '', sizes: DW_SIZES, params: [], ...def });
  // late registration: this type's widgets already on screen render for real now
  for (const inst of dw.instances) if (inst.w.type === def.type && inst.frame.isConnected) dwLoad(inst, dw.cache);
}

const dwDef = (type) => dwTypes.get(type) ?? null;

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
      fbDrillCards(hctx, homeView, opts);
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

// A widget's own filter overrides (params.vars), only the keys that are set.
function dwVars(w) {
  const v = w.params?.vars;
  if (!v || typeof v !== 'object') return null;
  const out = {};
  for (const k of ['scope', 'phase', 'tag', 'agent', 'workType', 'range', 'from', 'to']) if (v[k] != null && v[k] !== '') out[k] = String(v[k]);
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
