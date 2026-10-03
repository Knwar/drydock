// ── Dashboard: widget registry + layout renderer, mounted on Home (#dash-root) ──
// Classic script loaded after app.js: uses its globals (node, $, hctx, fbParams,
// fbDrillCards, homeMeta, homeView, openCardModal, currentProject, projectId, activeView).
//
// Widget contract (widget-*.js files call dwRegister):
//   dwRegister({ type, title: string | (params) => string, sizes: ['S','M','L','XL'] subset, load?(ctx) → Promise<data>,
//                render(el, data, ctx) → void | { empty: 'reason' }, onStatus?(msg, el, ctx) })
//   ctx = { id, size, params, projectId, filters, shared(key, fetcher), refresh(), drillCards(opts), openCard(id, boardId?) }
// shared() dedupes one fetch per refresh cycle; the 'home' key is pre-seeded with
// Home's own GET /home read (same filters), so widgets reading it cost no extra request.
// The renderer owns every widget's loading / error / empty / stale states.

const DW_SIZES = ['S', 'M', 'L', 'XL'];
const DW_ROW_PX = 88;
const DW_NARROW = window.matchMedia('(max-width: 799px)');
const dwTypes = new Map(); // type → registration
const dw = {
  board: null, // the project the layout on screen belongs to
  layout: null,
  layoutSeq: 0,
  instances: [], // every rendered widget (incl. ones inside tabs)
  last: new Map(), // widget id → { data, at }: last good data (keeps refreshes / re-renders calm)
  cache: new Map(), // this refresh cycle's shared() fetches
  homeWait: null, // Home's first /home read, awaited by the opening cycle
};

function dwRegister(def) {
  if (!def || typeof def.type !== 'string' || typeof def.render !== 'function') throw new Error('dwRegister: type and render are required');
  dwTypes.set(def.type, { title: '', sizes: DW_SIZES, ...def });
  // late registration: this type's widgets already on screen render for real now
  for (const inst of dw.instances) if (inst.w.type === def.type && inst.frame.isConnected) dwLoad(inst, dw.cache);
}

// ── built-in types ──
dwRegister({
  type: 'placeholder',
  title: '',
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

// Live messages for Home's boards (both sockets): status → onStatus; layout → refetch it.
function dwOnMessage(msg) {
  if (msg.type === 'layout' && msg.project_id && msg.project_id === dw.board) return void dwLoadLayout();
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
  const seq = ++dw.layoutSeq;
  if (dw.board !== board) {
    dw.last.clear();
    dw.layout = null;
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
  if (seq !== dw.layoutSeq) return;
  dw.layout = body.layout;
  dwRenderLayout();
}

function dwRenderLayout() {
  const root = $('dash-root');
  if (!root || !dw.layout) return;
  dw.instances = [];
  const frag = document.createDocumentFragment();
  for (const sec of dw.layout.sections ?? []) {
    try {
      frag.append(dwSection(sec));
    } catch (e) {
      console.error('dashboard section', sec?.id, e);
      frag.append(node('div', 'dw-root-msg dw-error', `Section “${sec?.title ?? ''}” couldn’t render`));
    }
  }
  root.replaceChildren(frag);
  for (const inst of [...dw.instances]) dwLoad(inst, dw.cache);
}

const dwCollapseKey = (secId) => `dw.collapsed.${dw.board}.${secId}`;
function dwSection(sec) {
  const el = node('section', 'dw-section');
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
  dwRows(body, sec.rows ?? []);
  el.append(head, body);
  return el;
}

function dwRows(host, rows) {
  const created = [];
  for (const r of rows) {
    const row = node('div', 'dw-row');
    row.style.setProperty('--h', String(r.height));
    for (const s of r.slots ?? []) {
      const slot = node('div', 'dw-slot');
      slot.style.setProperty('--span', String(s.span));
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
// ctx: the hosting widget's ctx (its refresh cache carries over).
function dwRenderRows(host, rows, ctx) {
  const created = dwRows(host, rows ?? []);
  const cache = ctx?._cache ?? dw.cache;
  for (const inst of created) dwLoad(inst, cache);
  return created;
}

// ── widgets ──
function dwSize(w, def) {
  if (!DW_NARROW.matches || !def) return w.size;
  // the nearest smaller tier the widget supports; none → the configured size
  for (let i = DW_SIZES.indexOf(w.size) - 1; i >= 0; i--) if (def.sizes.includes(DW_SIZES[i])) return DW_SIZES[i];
  return w.size;
}

function dwWidget(w) {
  const frame = node('div', 'dw-widget');
  frame.dataset.type = w.type;
  const head = node('div', 'dw-head');
  const title = node('span', 'dw-title');
  const asof = node('span', 'dw-asof');
  head.append(title, asof);
  const body = node('div', 'dw-body');
  frame.append(head, body);
  const inst = { w, frame, head, title, asof, body, ctx: null, seq: 0, painted: false };
  inst.ctx = {
    id: w.id,
    size: w.size,
    params: w.params ?? {},
    projectId: dw.board,
    get filters() {
      return fbParams(hctx);
    },
    shared: (key, fetcher) => dwShared(inst.ctx._cache ?? dw.cache, key, fetcher),
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
  dw.instances.push(inst);
  return inst;
}

function dwFrameTitle(inst) {
  const def = dwTypes.get(inst.w.type);
  const params = inst.w.params ?? {};
  const t = params.title || (def ? (typeof def.title === 'function' ? def.title(params) : def.title) : inst.w.type);
  inst.title.textContent = t || '';
  inst.head.classList.toggle('hidden', !t);
  inst.ctx.size = dwSize(inst.w, def);
  inst.body.dataset.size = inst.ctx.size;
}

function dwState(inst, state) {
  for (const s of ['loading', 'error', 'empty', 'stale']) inst.frame.classList.toggle(`is-${s}`, s === state);
  if (state !== 'stale') inst.asof.textContent = '';
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
}

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
  const prev = dw.last.get(inst.w.id);
  if (prev && !inst.painted) dwPaint(inst, prev.data);
  else if (!prev) dwSkeleton(inst);
  inst.ctx._cache = cache;
  let data;
  try {
    data = await def.load(inst.ctx);
  } catch (e) {
    if (seq !== inst.seq || !inst.frame.isConnected) return;
    const last = dw.last.get(inst.w.id);
    if (!last) return void dwError(inst, e);
    if (!inst.painted) dwPaint(inst, last.data);
    dwState(inst, 'stale');
    inst.asof.textContent = `as of ${dwClock(last.at)}`;
    inst.asof.title = e?.message || String(e);
    return;
  }
  if (seq !== inst.seq || !inst.frame.isConnected) return;
  dw.last.set(inst.w.id, { data, at: Date.now() });
  dwPaint(inst, data);
}

function dwPrune() {
  dw.instances = dw.instances.filter((i) => i.frame.isConnected);
}

// crossing 800px: slots stack (CSS) and widgets re-render one tier smaller, from their last data.
// Off Home nothing renders: reopening Home re-fetches and re-renders the layout (dwOpen).
DW_NARROW.addEventListener('change', () => {
  if (dw.layout && activeView === 'home') dwRenderLayout();
});

// app.js may have opened Home before this file loaded (EARLY_VIEW): mount now, and if
// that /home read already landed (its dwRefresh call was skipped) hand it to the widgets.
if (activeView === 'home') {
  dwOpen();
  if (home.data && home.key === fbParams(hctx, true)) dwRefresh(home.data);
}
