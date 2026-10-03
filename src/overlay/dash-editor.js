// ── Dashboard editor core (globals prefix de) ──
// Classic script loaded after dashboard.js, the widget scripts and layout-ops.js; the feature
// modules (dash-editor-toolbar / -library / -drag / -structure / -config .js) load after it and
// build on the API below. Uses app.js / dashboard.js globals (node, $, EMBED, dw, dwRenderLayout,
// dwAfterRender, dwDef).
//
// State
//   deState = { active, base, draft, past[], future[], dirty, saving, selected: { kind, id } | null }
//     base: the layout at deEnter (or the last save); draft: the layout being edited (also
//     dw.layout while active); saving: between deBeginSave() and deEndSave().
//     kind ∈ 'widget' | 'row' | 'section' | 'slot' | 'tab'. Treat every layout as immutable.
//
// Lifecycle
//   deEnter() → bool          enter from dw.layout (≥800px, not in embed; the Edit dashboard
//                             button is disabled until a layout has rendered); renders the draft
//   deExit({ saved }?)        leave edit mode. Default: DISCARD (base back on screen; an unsaved
//                             draft never stays rendered as if saved). { saved: true }: the draft
//                             stays, used by the toolbar after a successful PUT.
//   deRequestExit()           Done / Esc / Cancel: dirty → "Discard unsaved changes?" dialog
//                             (Discard / Keep editing), otherwise exits at once. Below 800px
//                             (editing isn't possible there) it opens the narrow dialog instead.
//   Viewport below 800px mid-edit → deRequestExit() → "Editing needs a wider window" (Save and
//                             exit + Discard changes when dirty, else Exit editing; no Keep
//                             editing). Widening again before a choice closes it, editing goes on.
//   While dirty, leaving the page (reload / close) asks first (beforeunload).
//   deAbandon()               exit discarding without asking (the board changed); announces
//                             "Unsaved dashboard edits were discarded" when dirty.
//
// Saving (the toolbar card owns the PUT):
//   deBeginSave(); const ok = (await fetch(PUT …)).ok; deEndSave(ok); if (ok) deExit({ saved: true });
//   deSetSaver(fn)            register the save routine: async fn() → bool (true: stored). The
//                             narrow dialog's "Save and exit" runs it (then exits if still editing
//                             and clean); with none registered it clicks #de-toolbar's .de-tb-save.
//   While saving (and 2s after a successful save) a live layout message for this board is our own
//   echo: no 'external-change', no notice. deEndSave(true) also makes the draft the new base
//   (dirty false, emits 'change').
//
// Edits (feature modules call lo* ops from layout-ops.js and hand the result here; never mutate)
//   deApply(layout, label, { coalesce }?) → bool
//       a no-op (same JSON as the draft) returns true without a history step. Otherwise validates with loValidate (refused: announces the first error, returns false); pushes the
//       draft to past (cap 100), clears future, renders, announces label, emits 'change'.
//       coalesce: a key; while the last step has the same key and is under 1s old the draft is
//       replaced without a new history step (typing in the config drawer).
//   deUndo() / deRedo() → bool; deCanUndo() / deCanRedo() → bool
//
// Selection, events, announcements
//   deSelect({ kind, id } | null)   accent outline on the node; emits 'select'
//   deOn(event, fn) → off()         'enter' | 'exit' | 'change' | 'select' | 'render' | 'external-change'
//                                   ('render' gets the rendered root; 'exit' gets { saved })
//   deAnnounce(text)                one polite aria-live region
//   deFind(layout, kind, id) → the layout object (section / row / slot / widget / tab) or null
//   deNodeFor(kind, id) → its element on screen or null
//
// Menus
//   deMenu(anchorEl, items)   the one shared popup menu (role=menu, arrows / Home / End /
//                             Enter / Space, Esc and Tab close and refocus the anchor, Right / Left
//                             open / close submenus, hovering an item moves the roving focus to it
//                             (one highlight) and hovering a parent opens its submenu; scrolls past
//                             max-height; closes on scroll / resize). Item: { label, onSelect?,
//                             children?, disabled?, checked?, radio?, primary?, danger? } or
//                             { separator: true }.
//                             checked !== undefined → menuitemcheckbox (radio: true → menuitemradio).
//   deMenuItems(kind, fn)     contribute items: fn(id, info) → items[]; info = { kind, id, item, el,
//                             layout }. Modules' items concatenate in registration order with
//                             separators between modules. Ordering across all modules: items with
//                             primary: true come first, items with danger: true come last (after a
//                             separator), everything else keeps registration order.
//   deMenuFor(kind, id, anchorEl)   open the registered menu for one target
//
// Decoration (edit mode, after every render; idempotent)
//   widget frames: .de-handle button ("Widget options: <title>") → 'widget' items
//   rows: a slim .de-row-bar (before the row, data-row-id) with a .de-row-handle → 'row' items
//   section heads: .de-section-handle → 'section' items
//   tabs widgets: .de-tab-handle (the selected tab; on the frame, outside the tablist) + context
//     menu / Shift+F10 on a tab → 'tab' items
//   widget bodies (except tabs) are inert while editing: they still scroll, a click selects the frame
//   a click on empty dashboard space (no frame / row / section head / control) clears the selection
//   empty slots: .de-slot-empty "Empty slot" with a .de-slot-handle → 'slot' items
//   Every handle carries data-de-for="<kind>:<id>" (a tab strip's: "tabs:<widget id>"). Clicking a frame / row / section / slot selects it.
//   deDecorate(fn)  fn(root) after the core's decoration (drag listeners etc.)
//
// Escape hatch: #de-hatch (a "Done" button + the "changed elsewhere" notice) until the toolbar
// card lands; the toolbar hides it (#de-hatch { display: none }). Esc → deRequestExit() too, only
// on Home with no dialog / card modal open and nothing else having claimed it.

const DE_HISTORY_CAP = 100;
const DE_COALESCE_MS = 1000;
const DE_KINDS = ['widget', 'row', 'section', 'slot', 'tab'];

const DE_SAVE_ECHO_MS = 2000;
const deState = { active: false, base: null, draft: null, past: [], future: [], dirty: false, saving: false, selected: null };
let deSavedAt = 0; // the last successful save (its live echo may land just after)
let deLastStep = null; // { coalesce, at } of the newest history step
let deExternal = false; // a live layout change arrived while editing
let deExitDlg = null; // { kind: 'discard' | 'narrow', close } while one of our exit dialogs is up
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
  Object.assign(deState, { active: true, base: deClone(dw.layout), draft: deClone(dw.layout), past: [], future: [], dirty: false, saving: false, selected: null });
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

function deExit({ saved = false } = {}) {
  if (!deState.active) return;
  deExitDlg?.close(); // left some other way (save, another board) with our dialog still up
  const layout = saved ? deState.draft : deState.base;
  const wasDirty = deState.dirty;
  const refetch = deExternal;
  deMenuClose(false);
  Object.assign(deState, { active: false, base: null, draft: null, past: [], future: [], dirty: false, saving: false, selected: null });
  deLastStep = null;
  deExternal = false;
  dw.editing = false;
  $('dash-root')?.classList.remove('de-editing');
  document.body.classList.remove('de-editing');
  deHatch(false);
  dwRenderLayout(layout);
  deEmit('exit', { saved });
  deAnnounce(saved ? 'Dashboard saved' : wasDirty ? 'Changes discarded' : 'Done editing');
  if (refetch) dwLoadLayout(); // the layout changed elsewhere meanwhile: show the stored one
  $('home-edit')?.focus();
}

// Done / Esc / Cancel: ask before throwing away unsaved edits.
function deRequestExit() {
  if (!deState.active) return;
  if (!deWide()) return void deNarrowPrompt(); // editing isn't possible here: no Keep editing
  if (!deState.dirty) return void deExit();
  if (svModal) return; // a dialog is already up
  const { dlg, close, mount } = openModal({ labelledBy: 'de-discard-title', describedBy: 'de-discard-sub', busy: () => false, onClose: () => (deExitDlg = null), fallbackFocus: () => $('home-edit') });
  deExitDlg = { kind: 'discard', close };
  dlg.classList.add('de-exit-dlg');
  const title = node('h2', 'sv-title', 'Discard unsaved changes?');
  title.id = 'de-discard-title';
  const sub = node('p', 'sv-sub', 'Your edits to this dashboard haven’t been saved.');
  sub.id = 'de-discard-sub';
  const foot = node('div', 'sv-foot');
  const keep = node('button', 'home-btn', 'Keep editing');
  keep.type = 'button';
  keep.onclick = close;
  const discard = node('button', 'home-btn pl-danger', 'Discard');
  discard.type = 'button';
  discard.onclick = () => {
    close();
    deExit();
  };
  foot.append(node('span', 'sv-foot-note'), keep, discard);
  dlg.append(title, sub, foot);
  mount();
  keep.focus();
}

// The save routine "Save and exit" runs (the toolbar's); see the header.
let deSaver = null;
function deSetSaver(fn) {
  deSaver = typeof fn === 'function' ? fn : null;
}
async function deSaveNow() {
  if (!deSaver) return void document.querySelector('#de-toolbar .de-tb-save')?.click(); // exits itself on success
  let ok = false;
  try {
    ok = !!(await deSaver());
  } catch (e) {
    console.error('dash-editor saver', e);
  }
  if (ok && deState.active && !deState.dirty) deExit({ saved: true });
}

// Below 800px mid-edit: save (when dirty) or discard / exit, nothing else (Esc / backdrop don't close
// it); widening the window again closes it (the matchMedia listener below).
function deNarrowPrompt() {
  if (!deState.active || deExitDlg?.kind === 'narrow') return;
  if (deExitDlg) deExitDlg.close(); // the generic one offers Keep editing: replace it
  // another dialog (library, templates…) owns the screen: ask once it has closed
  if (svModal) return void setTimeout(() => deState.active && !deWide() && !deExitDlg && deRequestExit(), 500);
  const dirty = deState.dirty;
  const { dlg, close, mount } = openModal({ labelledBy: 'de-narrow-title', describedBy: 'de-narrow-sub', busy: () => true, onClose: () => (deExitDlg = null), fallbackFocus: () => $('home-edit') });
  deExitDlg = { kind: 'narrow', close };
  dlg.classList.add('de-exit-dlg');
  const title = node('h2', 'sv-title', 'Editing needs a wider window');
  title.id = 'de-narrow-title';
  const sub = node('p', 'sv-sub', dirty ? 'The dashboard can only be edited at 800px or wider. Save your edits or discard them, or widen the window to keep editing.' : 'The dashboard can only be edited at 800px or wider.');
  sub.id = 'de-narrow-sub';
  const foot = node('div', 'sv-foot');
  const discard = node('button', dirty ? 'home-btn pl-danger' : 'home-btn', dirty ? 'Discard changes' : 'Exit editing');
  discard.type = 'button';
  discard.onclick = () => {
    close();
    deExit();
  };
  foot.append(node('span', 'sv-foot-note'));
  let save = null;
  if (dirty) {
    save = node('button', 'home-btn primary', 'Save and exit');
    save.type = 'button';
    save.onclick = () => {
      close();
      deSaveNow();
    };
    foot.append(discard, save);
  } else foot.append(discard);
  dlg.append(title, sub, foot);
  mount();
  (save ?? discard).focus();
}

// The board changed under the editor: no one to ask, so discard and say so.
function deAbandon() {
  if (!deState.active) return;
  const dirty = deState.dirty;
  deExit();
  if (dirty) deAnnounce('Unsaved dashboard edits were discarded');
}

// The toolbar's PUT: its own live layout echo isn't a change made elsewhere.
function deBeginSave() {
  if (deState.active) deState.saving = true;
}
function deEndSave(ok) {
  deState.saving = false;
  if (!ok || !deState.active) return;
  deSavedAt = Date.now();
  deState.base = deState.draft;
  deState.dirty = false;
  deEmit('change');
}

// The live layout changed while editing (dashboard.js calls this instead of refetching).
function deExternalChange() {
  if (!deState.active) return;
  if (deState.saving || Date.now() - deSavedAt < DE_SAVE_ECHO_MS) return; // our own save's echo
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
  if (deJson(newLayout) === deJson(deState.draft)) return true; // a no-op: no history step
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

// primary items first, then each module's rest (registration order, separated), danger items last
function deItemsFor(kind, id, info) {
  const primary = [];
  const danger = [];
  const middle = [];
  for (const r of deMenuRegistry) {
    if (r.kind !== kind) continue;
    let items = [];
    try {
      items = r.fn(id, info) || [];
    } catch (e) {
      console.error('dash-editor menu items', kind, e);
    }
    const rest = [];
    for (const it of items) {
      if (!it) continue;
      if (it.primary && !it.separator) primary.push(it);
      else if (it.danger && !it.separator) danger.push(it);
      else rest.push(it);
    }
    if (rest.some((it) => !it.separator)) middle.push({ separator: true }, ...rest);
  }
  const out = [...primary, { separator: true }, ...middle, { separator: true }, ...danger];
  // no leading / trailing / doubled separators
  const clean = out.filter((it, i) => !it.separator || (i > 0 && out.slice(0, i).some((p) => !p.separator) && out.slice(i + 1).some((n) => !n.separator) && !out[i + 1]?.separator));
  return clean.length ? clean : [{ label: 'No actions yet', disabled: true }];
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
  document.addEventListener('scroll', deMenuOnScroll, true);
  window.addEventListener('resize', deMenuOnResize);
  return deMenuState;
}

// focus: move focus to the new level's first item (keyboard), not when opened by hover
function deMenuOpenLevel(items, anchor, parentBtn, focus = true) {
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
      b.focus({ preventScroll: true }); // the roving focus follows the pointer: one highlight
      if (deMenuState?.levels[level + 1]?.parentBtn === b) return; // its submenu is already open
      deMenuTrim(level + 1);
      if (it.children?.length && !it.disabled) deMenuOpenLevel(it.children, b, b, false);
    });
    b._deItem = it;
    buttons.push(b);
    menu.append(b);
  }
  menu.addEventListener('keydown', (e) => deMenuKey(e, level));
  document.body.append(menu);
  deMenuState.levels.push({ el: menu, items, buttons, parentBtn });
  deMenuPlace(menu, anchor, !!parentBtn);
  if (focus) buttons[0]?.focus();
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
  document.removeEventListener('scroll', deMenuOnScroll, true);
  window.removeEventListener('resize', deMenuOnResize);
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

// the anchor moved away from a fixed menu: close it (scrolling inside the menu is fine)
function deMenuOnScroll(e) {
  if (deMenuState?.levels.some((lv) => lv.el === e.target || lv.el.contains(e.target))) return;
  deMenuClose(false);
}
function deMenuOnResize() {
  deMenuClose(false);
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
      deMenuClose(true); // back on the anchor
      break;
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
  for (const body of root.querySelectorAll('.dw-widget:not([data-widget-type="tabs"]) > .dw-body')) dwInertBody(body);
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
  // one handle per tabs widget, on its frame (outside the tablist): always the selected tab's menu
  const frame = strip.closest('.dw-widget');
  if (!frame || frame.querySelector(':scope > .de-tab-handle')) return;
  const label = () => `Tab options: ${selected()?.textContent ?? ''}`;
  const b = deHandle('de-tab-handle', 'tab', () => selected()?.dataset.tabId, label());
  b.dataset.deFor = `tabs:${frame.dataset.widgetId}`;
  const relabel = () => {
    b.setAttribute('aria-label', label());
    b.title = label();
  };
  b.addEventListener('focus', relabel);
  b.addEventListener('pointerenter', relabel);
  frame.append(b);
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

// a click in a widget's (inert) body selects the widget and goes no further: its links and
// buttons stay dead while editing, wheel / touch scrolling of the body still works
$('dash-root')?.addEventListener(
  'click',
  (e) => {
    if (!deState.active) return;
    const body = e.target.closest?.('.dw-body');
    const frame = body?.parentElement;
    if (!frame?.matches('.dw-widget[data-widget-id]') || frame.dataset.widgetType === 'tabs') return;
    e.preventDefault();
    e.stopPropagation();
    deSelect({ kind: 'widget', id: frame.dataset.widgetId });
  },
  { capture: true },
);

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

// a click on empty dashboard space (not a frame, row, section head, handle, menu, drawer, toolbar
// or control) clears the selection
$('home-body')?.addEventListener('click', (e) => {
  if (!deState.active || !deState.selected) return;
  const t = e.target;
  if (!(t === e.currentTarget || t.closest?.('#dash-root'))) return; // Home's header, the toolbar…
  const controls = '.dw-widget, .de-row-bar, .dw-row, .dw-sec-head, .de-slot-empty, .de-btn, .de-menu, #dec-drawer, #de-toolbar, [role="dialog"]';
  const editorBits = '.ds-add-section, .ds-add-end, .ds-inline, .ds-ins, .ds-div, .de-resize-grip, .de-row-resize';
  if (t.closest(`${controls}, ${editorBits}, button, a, input, textarea, select, label, [contenteditable]`)) return;
  deSelect(null);
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
  done.onclick = () => deRequestExit();
  hatch.append(note, done);
  $('home-body')?.prepend(hatch);
}

// a dialog (openModal's, the card modal) owns the keyboard
const deDialogOpen = () => svModal || !!document.querySelector('.sv-backdrop') || !$('card-modal')?.classList.contains('hidden');

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !deState.active || e.defaultPrevented || deMenuState) return;
  if (activeView !== 'home' || deDialogOpen()) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable], [role="dialog"], dialog')) return;
  e.preventDefault();
  deRequestExit();
});

// narrower than 800px mid-edit: like Done, but the dialog can't offer Keep editing (deNarrowPrompt);
// wider again before a choice: that dialog closes and editing goes on
window.matchMedia('(min-width: 800px)').addEventListener('change', (e) => {
  if (!deState.active) return;
  if (!e.matches) return void deRequestExit();
  if (deExitDlg?.kind === 'narrow') deExitDlg.close();
});

// unsaved edits: reloading / closing the page asks first
window.addEventListener('beforeunload', (e) => {
  if (!deState.active || !deState.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// the Edit dashboard button (hidden below 800px and in embed: CSS), enabled once a layout rendered
const deEditBtn = $('home-edit');
if (deEditBtn) deEditBtn.onclick = () => deEnter();
function deSyncEditBtn() {
  if (deEditBtn) deEditBtn.disabled = !dw.layout;
}
dwAfterRender(deSyncEditBtn);
deSyncEditBtn();
