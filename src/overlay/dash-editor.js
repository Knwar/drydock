// ── Dashboard editor core (globals prefix de) ──
// Classic script loaded after dashboard.js, the widget scripts and layout-ops.js; the feature
// modules (dash-editor-toolbar / -library / -drag / -structure / -config .js) load after it and
// build on the API below. Uses app.js / dashboard.js globals (node, $, EMBED, dw, dwRenderLayout,
// dwAfterRender, dwDef).
//
// State
//   deState = { active, base, draft, past[], future[], dirty, selected: { kind, id } | null }
//     base: the layout at deEnter; draft: the layout being edited (also dw.layout while active).
//     kind ∈ 'widget' | 'row' | 'section' | 'slot' | 'tab'. Treat every layout as immutable.
//
// Lifecycle
//   deEnter() → bool          enter from dw.layout (≥800px, not in embed); renders the draft
//   deExit({ discard }?)      discard: back to base; otherwise the draft stays on screen.
//                             Saving is the toolbar's job: after a successful PUT it calls deExit().
//
// Edits (feature modules call lo* ops from layout-ops.js and hand the result here; never mutate)
//   deApply(layout, label, { coalesce }?) → bool
//       validates with loValidate (refused: announces the first error, returns false); pushes the
//       draft to past (cap 100), clears future, renders, announces label, emits 'change'.
//       coalesce: a key; while the last step has the same key and is under 1s old the draft is
//       replaced without a new history step (typing in the config drawer).
//   deUndo() / deRedo() → bool; deCanUndo() / deCanRedo() → bool
//
// Selection, events, announcements
//   deSelect({ kind, id } | null)   accent outline on the node; emits 'select'
//   deOn(event, fn) → off()         'enter' | 'exit' | 'change' | 'select' | 'render' | 'external-change'
//                                   ('render' gets the rendered root; 'exit' gets { discard })
//   deAnnounce(text)                one polite aria-live region
//   deFind(layout, kind, id) → the layout object (section / row / slot / widget / tab) or null
//   deNodeFor(kind, id) → its element on screen or null
//
// Menus
//   deMenu(anchorEl, items)   the one shared popup menu (role=menu, arrows / Home / End /
//                             Enter / Space, Esc closes and refocuses the anchor, Right / Left
//                             open / close submenus). Item: { label, onSelect?, children?,
//                             disabled?, checked?, radio?, danger? } or { separator: true }.
//                             checked !== undefined → menuitemcheckbox (radio: true → menuitemradio).
//   deMenuItems(kind, fn)     contribute items: fn(id, info) → items[]; info = { kind, id, item, el,
//                             layout }. Modules' items concatenate in registration order with
//                             separators between modules.
//   deMenuFor(kind, id, anchorEl)   open the registered menu for one target
//
// Decoration (edit mode, after every render; idempotent)
//   widget frames: .de-handle button ("Widget options: <title>") → 'widget' items
//   rows: a slim .de-row-bar (before the row, data-row-id) with a .de-row-handle → 'row' items
//   section heads: .de-section-handle → 'section' items
//   tab strips: .de-tab-handle (the selected tab) + context menu / Shift+F10 on a tab → 'tab' items
//   empty slots: .de-slot-empty "Empty slot" with a .de-slot-handle → 'slot' items
//   Every handle carries data-de-for="<kind>:<id>" (a tab strip's: "tabs:<widget id>"). Clicking a frame / row / section / slot selects it.
//   deDecorate(fn)  fn(root) after the core's decoration (drag listeners etc.)
//
// Escape hatch: #de-hatch (a "Done" button + the "changed elsewhere" notice) until the toolbar
// card lands; the toolbar hides it (#de-hatch { display: none }). Esc exits too, unless something
// else claimed it.

const DE_HISTORY_CAP = 100;
const DE_COALESCE_MS = 1000;
const DE_KINDS = ['widget', 'row', 'section', 'slot', 'tab'];

const deState = { active: false, base: null, draft: null, past: [], future: [], dirty: false, selected: null };
let deLastStep = null; // { coalesce, at } of the newest history step
let deExternal = false; // a live layout change arrived while editing
const deListeners = new Map(); // event → Set(fn)
const deMenuRegistry = []; // { kind, fn }
const deDecorators = [];

const deClone = (l) => JSON.parse(JSON.stringify(l));
const deJson = (l) => JSON.stringify(l);

// ── events ──
function deOn(event, fn) {
  if (!deListeners.has(event)) deListeners.set(event, new Set());
  deListeners.get(event).add(fn);
  return () => deListeners.get(event)?.delete(fn);
}
function deEmit(event, payload) {
  for (const fn of [...(deListeners.get(event) ?? [])]) {
    try {
      fn(payload);
    } catch (e) {
      console.error('dash-editor', event, e);
    }
  }
}

// ── announcements ──
function deAnnounce(text) {
  let live = $('de-live');
  if (!live) {
    live = node('div', 'de-sr');
    live.id = 'de-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = '';
  // a fresh text node next tick: repeating the same message is announced again
  setTimeout(() => (live.textContent = text || ''), 30);
}

// ── layout lookup ──
function deWalk(layout, visit) {
  const rows = (list, container) => {
    for (const r of list ?? []) {
      visit('row', r, container);
      for (const s of r.slots ?? []) {
        visit('slot', s, r);
        for (const w of s.widgets ?? []) {
          visit('widget', w, s);
          if (w.type === 'tabs')
            for (const t of Array.isArray(w.params?.tabs) ? w.params.tabs : []) {
              visit('tab', t, w);
              rows(t.rows, t);
            }
        }
      }
    }
  };
  for (const sec of layout?.sections ?? []) {
    visit('section', sec, null);
    rows(sec.rows, sec);
  }
}
function deFind(layout, kind, id) {
  let hit = null;
  deWalk(layout, (k, item) => {
    if (!hit && k === kind && item?.id === id) hit = item;
  });
  return hit;
}

const DE_SELECTORS = {
  widget: (id) => `.dw-widget[data-widget-id="${CSS.escape(id)}"]`,
  row: (id) => `.dw-row[data-row-id="${CSS.escape(id)}"]`,
  section: (id) => `.dw-section[data-section-id="${CSS.escape(id)}"]`,
  slot: (id) => `.dw-slot[data-slot-id="${CSS.escape(id)}"]`,
  tab: (id) => `.dw-tab[data-tab-id="${CSS.escape(id)}"]`,
};
function deNodeFor(kind, id) {
  const root = $('dash-root');
  return root && DE_SELECTORS[kind] ? root.querySelector(DE_SELECTORS[kind](id)) : null;
}

// ── enter / exit ──
const deWide = () => window.matchMedia('(min-width: 800px)').matches;

function deEnter() {
  if (deState.active || EMBED || !dw.layout || !deWide()) return false;
  Object.assign(deState, { active: true, base: deClone(dw.layout), draft: deClone(dw.layout), past: [], future: [], dirty: false, selected: null });
  deLastStep = null;
  deExternal = false;
  dw.editing = true;
  $('dash-root')?.classList.add('de-editing');
  document.body.classList.add('de-editing');
  deHatch(true);
  dwRenderLayout(deState.draft);
  deEmit('enter');
  deAnnounce('Editing the dashboard');
  return true;
}

function deExit({ discard = false } = {}) {
  if (!deState.active) return;
  const layout = discard ? deState.base : deState.draft;
  const refetch = deExternal;
  deMenuClose(false);
  Object.assign(deState, { active: false, base: null, draft: null, past: [], future: [], dirty: false, selected: null });
  deLastStep = null;
  deExternal = false;
  dw.editing = false;
  $('dash-root')?.classList.remove('de-editing');
  document.body.classList.remove('de-editing');
  deHatch(false);
  dwRenderLayout(layout);
  deEmit('exit', { discard });
  deAnnounce(discard ? 'Changes discarded' : 'Done editing');
  if (refetch) dwLoadLayout(); // the layout changed elsewhere meanwhile: show the stored one
  $('home-edit')?.focus();
}

// The live layout changed while editing (dashboard.js calls this instead of refetching).
function deExternalChange() {
  if (!deState.active) return;
  deExternal = true;
  const note = $('de-hatch-note');
  if (note) note.textContent = 'The dashboard was changed elsewhere. Saving will replace that change.';
  deEmit('external-change');
}

// ── edits + history ──
function deCommit(layout) {
  deState.draft = layout;
  deState.dirty = deJson(layout) !== deJson(deState.base);
  dwRenderLayout(layout);
  const sel = deState.selected;
  if (sel && !deFind(layout, sel.kind, sel.id)) deSelect(null);
  else deMark();
}

function deApply(newLayout, label, opts = {}) {
  if (!deState.active || !newLayout) return false;
  if (typeof loValidate === 'function') {
    const errors = loValidate(newLayout);
    if (errors?.length) {
      deAnnounce(errors[0].message || 'That change isn’t valid');
      return false;
    }
  }
  const now = Date.now();
  const merge = opts.coalesce != null && deLastStep?.coalesce === opts.coalesce && now - deLastStep.at < DE_COALESCE_MS && deState.past.length;
  if (!merge) {
    deState.past.push(deState.draft);
    if (deState.past.length > DE_HISTORY_CAP) deState.past.shift();
  }
  deLastStep = { coalesce: opts.coalesce ?? null, at: now };
  deState.future = [];
  deCommit(newLayout);
  if (label) deAnnounce(label);
  deEmit('change');
  return true;
}

const deCanUndo = () => deState.active && deState.past.length > 0;
const deCanRedo = () => deState.active && deState.future.length > 0;

function deUndo() {
  if (!deCanUndo()) return false;
  deState.future.push(deState.draft);
  deLastStep = null;
  deCommit(deState.past.pop());
  deAnnounce('Undone');
  deEmit('change');
  return true;
}
function deRedo() {
  if (!deCanRedo()) return false;
  deState.past.push(deState.draft);
  deLastStep = null;
  deCommit(deState.future.pop());
  deAnnounce('Redone');
  deEmit('change');
  return true;
}

// ── selection ──
function deSelect(sel) {
  deState.selected = sel && DE_KINDS.includes(sel.kind) && sel.id != null ? { kind: sel.kind, id: sel.id } : null;
  deMark();
  deEmit('select', deState.selected);
}
function deMark() {
  const root = $('dash-root');
  if (!root) return;
  for (const el of root.querySelectorAll('.de-selected')) el.classList.remove('de-selected');
  const sel = deState.selected;
  if (!deState.active || !sel) return;
  deNodeFor(sel.kind, sel.id)?.classList.add('de-selected');
  if (sel.kind === 'row') root.querySelector(`.de-row-bar[data-row-id="${CSS.escape(sel.id)}"]`)?.classList.add('de-selected');
}

// ── menus ──
function deMenuItems(kind, fn) {
  if (!DE_KINDS.includes(kind) || typeof fn !== 'function') throw new Error('deMenuItems: unknown kind or no fn');
  deMenuRegistry.push({ kind, fn });
}

function deItemsFor(kind, id, info) {
  const out = [];
  for (const r of deMenuRegistry) {
    if (r.kind !== kind) continue;
    let items = [];
    try {
      items = r.fn(id, info) || [];
    } catch (e) {
      console.error('dash-editor menu items', kind, e);
    }
    if (!items.length) continue;
    if (out.length) out.push({ separator: true });
    out.push(...items);
  }
  return out.length ? out : [{ label: 'No actions yet', disabled: true }];
}

function deMenuFor(kind, id, anchorEl) {
  if (!deState.active) return;
  const info = { kind, id, item: deFind(deState.draft, kind, id), el: deNodeFor(kind, id), layout: deState.draft };
  deMenu(anchorEl, deItemsFor(kind, id, info));
}

let deMenuState = null; // { anchor, levels: [{ el, items, buttons, parentBtn }] }
let deMenuSeq = 0;

function deMenu(anchorEl, items) {
  deMenuClose(false);
  deMenuState = { anchor: anchorEl, levels: [] };
  anchorEl?.setAttribute('aria-expanded', 'true');
  deMenuOpenLevel(items, anchorEl, null);
  document.addEventListener('pointerdown', deMenuOutside, true);
  return deMenuState;
}

function deMenuOpenLevel(items, anchor, parentBtn) {
  const level = deMenuState.levels.length;
  const menu = node('div', `de-menu${level ? ' de-submenu' : ''}`);
  menu.id = `de-menu-${++deMenuSeq}`;
  menu.setAttribute('role', 'menu');
  if (parentBtn) {
    menu.setAttribute('aria-label', parentBtn.dataset.label);
    parentBtn.setAttribute('aria-expanded', 'true');
  } else if (anchor) {
    const name = anchor.getAttribute('aria-label') || anchor.textContent;
    if (name) menu.setAttribute('aria-label', name);
  }
  const buttons = [];
  for (const it of items) {
    if (it.separator) {
      const sep = node('div', 'de-menu-sep');
      sep.setAttribute('role', 'separator');
      menu.append(sep);
      continue;
    }
    const b = node('button', 'de-menu-item');
    b.type = 'button';
    b.tabIndex = -1;
    b.dataset.label = it.label;
    const isCheck = it.checked !== undefined;
    b.setAttribute('role', isCheck ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem');
    if (isCheck) b.setAttribute('aria-checked', String(!!it.checked));
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    if (it.danger) b.classList.add('danger');
    const check = node('span', 'de-menu-check', isCheck && it.checked ? '✓' : '');
    check.setAttribute('aria-hidden', 'true');
    b.append(check, node('span', 'de-menu-label', it.label));
    if (it.children?.length) {
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      const caret = node('span', 'de-menu-caret', '›');
      caret.setAttribute('aria-hidden', 'true');
      b.append(caret);
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      deMenuActivate(level, it, b);
    });
    b.addEventListener('pointerenter', () => {
      deMenuTrim(level + 1);
      b.focus();
      if (it.children?.length && !it.disabled) deMenuOpenLevel(it.children, b, b);
    });
    b._deItem = it;
    buttons.push(b);
    menu.append(b);
  }
  menu.addEventListener('keydown', (e) => deMenuKey(e, level));
  document.body.append(menu);
  deMenuState.levels.push({ el: menu, items, buttons, parentBtn });
  deMenuPlace(menu, anchor, !!parentBtn);
  buttons[0]?.focus();
}

function deMenuPlace(menu, anchor, side) {
  const r = anchor?.getBoundingClientRect() ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const m = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = side ? r.right + 2 : r.right - m.width;
  let y = side ? r.top - 4 : r.bottom + 4;
  if (side && x + m.width > vw - 8) x = r.left - m.width - 2;
  if (!side && x < 8) x = r.left;
  if (y + m.height > vh - 8) y = Math.max(8, side ? vh - m.height - 8 : r.top - m.height - 4);
  menu.style.left = `${Math.max(8, Math.min(x, vw - m.width - 8))}px`;
  menu.style.top = `${y}px`;
}

function deMenuTrim(depth) {
  if (!deMenuState) return;
  while (deMenuState.levels.length > depth) {
    const lv = deMenuState.levels.pop();
    lv.parentBtn?.setAttribute('aria-expanded', 'false');
    lv.el.remove();
  }
}

function deMenuClose(refocus = true) {
  if (!deMenuState) return;
  const { anchor } = deMenuState;
  deMenuTrim(0);
  deMenuState = null;
  document.removeEventListener('pointerdown', deMenuOutside, true);
  anchor?.setAttribute('aria-expanded', 'false');
  if (refocus) deRefocus(anchor);
}

// Focus the anchor again; if an edit re-rendered it away, its successor (same data-de-for).
function deRefocus(anchor) {
  if (!anchor) return;
  if (anchor.isConnected) return void anchor.focus();
  const key = anchor.dataset?.deFor;
  const next = key && document.querySelector(`[data-de-for="${CSS.escape(key)}"]`);
  if (next) next.focus();
}

function deMenuOutside(e) {
  if (!deMenuState) return;
  if (deMenuState.levels.some((lv) => lv.el.contains(e.target))) return;
  if (deMenuState.anchor?.contains(e.target)) return; // the anchor's own click toggles it
  deMenuClose(false);
}

function deMenuActivate(level, it, b) {
  if (it.disabled) return;
  if (it.children?.length) {
    deMenuTrim(level + 1);
    deMenuOpenLevel(it.children, b, b);
    return;
  }
  const anchor = deMenuState?.anchor;
  deMenuClose(false);
  deRefocus(anchor);
  try {
    it.onSelect?.();
  } catch (e) {
    console.error('dash-editor menu item', it.label, e);
  }
  // the action may have re-rendered the anchor away: focus its successor
  setTimeout(() => {
    if (document.activeElement === document.body || !document.activeElement?.isConnected) deRefocus(anchor);
  });
}

function deMenuKey(e, level) {
  const lv = deMenuState?.levels[level];
  if (!lv) return;
  const bs = lv.buttons;
  const i = bs.indexOf(document.activeElement);
  const n = bs.length;
  const it = i >= 0 ? bs[i]._deItem : null;
  const go = (to) => bs[(to + n) % n]?.focus();
  switch (e.key) {
    case 'ArrowDown':
      go(i + 1);
      break;
    case 'ArrowUp':
      go(i < 0 ? n - 1 : i - 1);
      break;
    case 'Home':
      go(0);
      break;
    case 'End':
      go(n - 1);
      break;
    case 'Enter':
    case ' ':
      if (it) deMenuActivate(level, it, bs[i]);
      break;
    case 'ArrowRight':
      if (it?.children?.length && !it.disabled) deMenuActivate(level, it, bs[i]);
      break;
    case 'ArrowLeft':
      if (level === 0) return;
      deMenuTrim(level);
      lv.parentBtn?.focus();
      break;
    case 'Escape':
      if (level > 0) {
        deMenuTrim(level);
        lv.parentBtn?.focus();
      } else deMenuClose(true);
      break;
    case 'Tab':
      deMenuClose(false);
      return; // focus moves on as usual
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// ── decoration ──
function deDecorate(fn) {
  deDecorators.push(fn);
}

// id: the target's id, or () => id resolved at click time
function deHandle(cls, kind, id, label) {
  const b = node('button', `de-btn ${cls}`);
  b.type = 'button';
  if (typeof id !== 'function') b.dataset.deFor = `${kind}:${id}`;
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.title = label;
  const dots = node('span', 'de-dots', '⋮');
  dots.setAttribute('aria-hidden', 'true');
  b.append(dots);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = deMenuState?.anchor === b;
    deMenuClose(false);
    if (open) return; // a second click closes it
    const target = typeof id === 'function' ? id() : id;
    if (target == null) return;
    deSelect({ kind, id: target });
    deMenuFor(kind, target, b);
  });
  return b;
}

const deWidgetTitle = (frame) => {
  const t = frame.querySelector(':scope > .dw-head > .dw-title')?.textContent;
  const type = frame.dataset.widgetType;
  return t || (type === 'tabs' ? 'Tabs' : type === 'placeholder' ? 'Placeholder' : type);
};

function deDecorateRoot(root) {
  for (const frame of root.querySelectorAll('.dw-widget[data-widget-id]')) {
    const label = `Widget options: ${deWidgetTitle(frame)}`;
    const old = frame.querySelector(':scope > .de-handle');
    if (old) {
      old.setAttribute('aria-label', label);
      old.title = label;
      continue;
    }
    frame.append(deHandle('de-handle', 'widget', frame.dataset.widgetId, label));
  }
  for (const row of root.querySelectorAll('.dw-row[data-row-id]')) {
    if (row.previousElementSibling?.classList.contains('de-row-bar')) continue;
    const id = row.dataset.rowId;
    const bar = node('div', 'de-row-bar');
    bar.dataset.rowId = id;
    const n = [...row.parentElement.querySelectorAll(':scope > .dw-row')].indexOf(row) + 1;
    bar.append(node('span', 'de-row-label', `Row ${n}`), deHandle('de-row-handle', 'row', id, `Row options: row ${n}`));
    row.before(bar);
  }
  for (const sec of root.querySelectorAll('.dw-section[data-section-id]')) {
    const head = sec.querySelector(':scope > .dw-sec-head');
    if (!head || head.querySelector('.de-section-handle')) continue;
    const title = sec.querySelector('.dw-sec-title')?.textContent || 'section';
    head.append(deHandle('de-section-handle', 'section', sec.dataset.sectionId, `Section options: ${title}`));
  }
  for (const strip of root.querySelectorAll('.dw-tabs-strip')) deDecorateTabs(strip);
  for (const slot of root.querySelectorAll('.dw-slot[data-slot-id]')) {
    if (slot.querySelector(':scope > .dw-widget, :scope > .de-slot-empty')) continue;
    const box = node('div', 'de-slot-empty');
    box.append(node('span', 'de-slot-text', 'Empty slot'), deHandle('de-slot-handle', 'slot', slot.dataset.slotId, 'Empty slot options'));
    slot.append(box);
  }
}

function deDecorateTabs(strip) {
  const selected = () => strip.querySelector('.dw-tab[aria-selected="true"]') ?? strip.querySelector('.dw-tab[data-tab-id]');
  for (const tab of strip.querySelectorAll('.dw-tab[data-tab-id]')) {
    if (tab.dataset.deTab) continue;
    tab.dataset.deTab = '1';
    tab.addEventListener('contextmenu', (e) => {
      if (!deState.active) return;
      e.preventDefault();
      deSelect({ kind: 'tab', id: tab.dataset.tabId });
      deMenuFor('tab', tab.dataset.tabId, tab);
    });
    tab.addEventListener('keydown', (e) => {
      if (!deState.active || !(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
      e.preventDefault();
      deSelect({ kind: 'tab', id: tab.dataset.tabId });
      deMenuFor('tab', tab.dataset.tabId, tab);
    });
  }
  if (strip.querySelector('.de-tab-handle')) return;
  // always the selected tab's menu
  const b = deHandle('de-tab-handle', 'tab', () => selected()?.dataset.tabId, 'Tab options: selected tab');
  b.dataset.deFor = `tabs:${strip.closest('.dw-widget')?.dataset.widgetId}`;
  strip.append(b);
}

// after every render (layout or tab panel): decorate while editing
dwAfterRender((root) => {
  if (!deState.active) return;
  deDecorateRoot(root);
  for (const fn of deDecorators) {
    try {
      fn(root);
    } catch (e) {
      console.error('dash-editor decorate', e);
    }
  }
  deMark();
  deEmit('render', root);
});

// clicking a frame / row / section / empty slot selects it (inner-most first)
$('dash-root')?.addEventListener('click', (e) => {
  if (!deState.active) return;
  const t = e.target;
  if (t.closest('.de-btn, .dw-tab')) return;
  const hit =
    (t.closest('.de-slot-empty') && { kind: 'slot', id: t.closest('.dw-slot').dataset.slotId }) ||
    (t.closest('.dw-widget[data-widget-id]') && { kind: 'widget', id: t.closest('.dw-widget').dataset.widgetId }) ||
    (t.closest('.de-row-bar, .dw-row[data-row-id]') && { kind: 'row', id: t.closest('.de-row-bar, .dw-row').dataset.rowId }) ||
    (t.closest('.dw-sec-head') && t.closest('.dw-section[data-section-id]') && { kind: 'section', id: t.closest('.dw-section').dataset.sectionId });
  if (hit) deSelect(hit);
});

// ── temporary escape hatch (the toolbar card replaces it) ──
function deHatch(show) {
  let hatch = $('de-hatch');
  if (!show) return void hatch?.remove();
  if (hatch) return;
  hatch = node('div', 'de-hatch');
  hatch.id = 'de-hatch';
  const note = node('span', 'de-hatch-note');
  note.id = 'de-hatch-note';
  note.setAttribute('role', 'status');
  const done = node('button', 'de-hatch-done', 'Done');
  done.type = 'button';
  done.onclick = () => deExit();
  hatch.append(note, done);
  $('home-body')?.prepend(hatch);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !deState.active || e.defaultPrevented || deMenuState) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable], [role="dialog"], dialog')) return;
  if (typeof anyDialogOpen === 'function' && anyDialogOpen()) return;
  e.preventDefault();
  deExit();
});

// the Edit dashboard button (hidden below 800px and in embed: CSS)
const deEditBtn = $('home-edit');
if (deEditBtn) deEditBtn.onclick = () => deEnter();
