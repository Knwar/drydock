// ── Dashboard editor: structure (globals prefix ds) ──
// Rows, column splits, sections and tabs while editing. Builds on dash-editor.js's core API
// (deState, deApply, deMenu, deMenuItems, deDecorate, deFind, deNodeFor, deAnnounce) and
// layout-ops.js's lo* ops; every edit is one lo* result handed to deApply (undoable, announced).
//
//   add row      a + line between rows (hover / focus) and an "Add row" button at the end of every
//                section and tab panel → the preset picker (column diagrams) → loAddRow
//   dividers     a separator between adjacent slots: drag in 1-column steps (one loSetSpans on
//                release) or focus + Left / Right (one step per key)
//   row menu     Split… (picker → loSetSpans), Move up / down, Duplicate, Delete
//   sections     "Add section" at the bottom; menu: Rename (inline), Move up / down,
//                Collapse / Expand (saved in the layout), Delete (not the only one; asks first
//                when it holds widgets)
//   tabs         a + right after the last tab (on the frame, outside the tablist); F2 / double-click
//                renames a tab inline; menu: Rename, Move left / right, Delete (not the last)
//   deletes      a toast with Undo (besides the announcement)

const DS_TITLE_MAX = 60;
const DS_PRESETS = [
  [[12], 'Full width'],
  [[6, 6], 'Halves'],
  [[4, 4, 4], 'Thirds'],
  [[3, 3, 3, 3], 'Quarters'],
  [[8, 4], 'Wide + narrow'],
  [[4, 8], 'Narrow + wide'],
];

const dsSpansText = (spans) => spans.join(' + ');
const dsSame = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// n equal columns, rounded so they sum to 12 (5 → 3 + 3 + 2 + 2 + 2)
function dsEqualSplit(n) {
  const base = Math.floor(12 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 12 - base * n ? 1 : 0));
}

function dsAll(root, sel) {
  const list = [...root.querySelectorAll(sel)];
  if (root.matches?.(sel)) list.unshift(root);
  return list;
}

function dsWidgetCount(container) {
  let n = 0;
  loWalk({ sections: [{ rows: container?.rows ?? [] }] }, ({ kind }) => {
    if (kind === 'widget') n++;
  });
  return n;
}

// ── edits ──

// A visible note (the live region speaks it; the toast's text is hidden from it). undoFor: the
// layout a delete just produced → an Undo button, live only while that layout is still the draft;
// refocus() → the restored item's element, focused after that Undo.
let dsToastTimer = 0;
let dsToastUndo = null;
function dsToast(message, undoFor, refocus) {
  let t = $('ds-toast');
  if (!t) {
    t = node('div', 'ds-toast');
    t.id = 'ds-toast';
    // kept up while the Undo button has focus
    t.addEventListener('focusin', () => clearTimeout(dsToastTimer));
    t.addEventListener('focusout', () => dsToastLater(4000));
    document.body.append(t);
  }
  const msg = node('span', 'ds-toast-msg', message);
  msg.setAttribute('aria-hidden', 'true');
  t.replaceChildren(msg);
  dsToastUndo = undoFor ?? null;
  t.classList.toggle('ds-toast-undo', !!undoFor);
  if (undoFor) {
    const b = node('button', 'ds-toast-btn', 'Undo');
    b.type = 'button';
    b.setAttribute('aria-label', `Undo: ${message}`);
    b.addEventListener('click', () => {
      const ok = dsToastUndo && deState.draft === dsToastUndo;
      dsToastHide();
      if (ok && deUndo()) dsFocusAfterUndo(refocus); // the toast is going: focus stays in the editor
    });
    t.append(b);
  }
  t.classList.add('show');
  dsToastLater(undoFor ? 8000 : 4000);
}
// the restored item, else the toolbar's Redo (if the toolbar is loaded), else the Edit button
function dsFocusAfterUndo(refocus) {
  const redo = typeof deTb !== 'undefined' ? deTb.redo : null;
  for (const el of [refocus?.(), redo, $('home-edit')]) {
    if (!el?.isConnected || el.disabled) continue;
    el.focus();
    if (document.activeElement === el) return;
  }
}

function dsToastLater(ms) {
  clearTimeout(dsToastTimer);
  dsToastTimer = setTimeout(dsToastHide, ms);
}
function dsToastHide() {
  clearTimeout(dsToastTimer);
  dsToastUndo = null;
  $('ds-toast')?.classList.remove('show');
}

// A refused edit: shown as well as announced.
function dsRefuse(message) {
  deAnnounce(message);
  dsToast(message);
}

// A delete: dsDo announces it; the toast shows it with Undo (refocus: see dsToast). → next
function dsDeleted(next, label, refocus) {
  if (next) dsToast(label, next, refocus);
  return next;
}

// make(draft) → a new layout via lo* ops; a LoError is refused out loud. → the applied layout or null
// opts: deApply's ({ coalesce })
function dsDo(make, label, opts) {
  if (!deState.active) return null;
  let next;
  try {
    next = make(deState.draft);
  } catch (e) {
    if (!(e instanceof LoError)) throw e;
    dsRefuse(e.message);
    return null;
  }
  return deApply(next, label, opts) ? next : null;
}

function dsFocus(selector) {
  const el = selector && $('dash-root')?.querySelector(selector);
  el?.focus();
  return !!el;
}
const dsFor = (key) => `[data-de-for="${CSS.escape(key)}"]`;
const dsHandle = (key) => $('dash-root')?.querySelector(dsFor(key)) ?? null;

// ── the column picker (the shared menu, with a mini diagram per item) ──

function dsDiagram(spans) {
  const d = node('span', 'ds-dia');
  d.setAttribute('aria-hidden', 'true');
  for (const s of spans) {
    const c = node('span', 'ds-dia-col');
    c.style.gridColumn = `span ${s}`;
    d.append(c);
  }
  return d;
}

// items: menu items, some with .spans. Opened with the public deMenu; its labels carry everything
// (the split and any warning), so the picker works fully even without the diagrams.
// center: under the anchor (the add-row buttons), not the core's right-aligned placement
function dsOpenPicker(anchor, items, title, center) {
  deMenu(anchor, items);
  const menu = dsAddDiagrams(items, title);
  if (center && menu) dsCenterUnder(menu, anchor);
}

// centred under the anchor (above it when there's no room below), clamped to the viewport
function dsCenterUnder(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = r.left + r.width / 2 - m.width / 2;
  let y = r.bottom + 4;
  if (y + m.height > vh - 8) y = Math.max(8, r.top - m.height - 4);
  menu.style.left = `${Math.max(8, Math.min(x, vw - m.width - 8))}px`;
  menu.style.top = `${y}px`;
}

// Visual only: deMenu has no hook for item content, so the diagrams go into the menu it just
// rendered. The ONE place that knows its DOM (a top-level .de-menu whose role=menuitem buttons
// carry data-label = the item's label). Anything unexpected → no diagrams, the menu is unchanged.
function dsAddDiagrams(items, title) {
  const menus = document.querySelectorAll('body > .de-menu:not(.de-submenu)');
  const menu = menus[menus.length - 1];
  if (!menu) return null;
  menu.classList.add('ds-picker');
  menu.setAttribute('aria-label', title);
  const byLabel = new Map(items.filter((it) => it.spans).map((it) => [it.label, it.spans]));
  for (const b of menu.querySelectorAll('[data-label]')) {
    const spans = byLabel.get(b.dataset.label);
    if (spans) b.querySelector('.de-menu-label')?.before(dsDiagram(spans));
  }
  // the diagrams widened it: keep it on screen (our own clamp, not the core's placement)
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) menu.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
  return menu;
}

// onPick(spans); current: the row's spans (Split) or null (Add row)
function dsPicker(anchor, onPick, current, warn) {
  const items = DS_PRESETS.map(([spans, name]) => dsPickItem(spans, name, onPick, current, warn));
  items.push({ separator: true }, { label: 'Custom…', onSelect: () => dsCustomPicker(anchor, onPick, current, warn) });
  dsOpenPicker(anchor, items, current ? 'Split row' : 'Add a row', !current);
}

// warn(spans) → true: these spans would drop columns holding widgets (said in the label)
function dsPickItem(spans, name, onPick, current, warn) {
  return {
    label: `${name} (${dsSpansText(spans)})${warn?.(spans) ? ' · drops widgets' : ''}`,
    spans,
    ...(current ? { checked: dsSame(spans, current), radio: true } : {}),
    onSelect: () => onPick(spans),
  };
}

function dsCustomPicker(anchor, onPick, current, warn) {
  const items = [1, 2, 3, 4, 5, 6].map((n) => dsPickItem(dsEqualSplit(n), `${n} column${n > 1 ? 's' : ''}`, onPick, current, warn));
  dsOpenPicker(anchor, items, 'Number of columns', !current);
}

// ── rows ──

function dsAddRow(anchor, containerId, beforeRowId) {
  dsPicker(anchor, (spans) => {
    const box = loFind(deState.draft, containerId)?.node;
    if (!box) return;
    const rows = box.rows ?? [];
    const at = beforeRowId ? rows.findIndex((r) => r.id === beforeRowId) : rows.length;
    const index = at < 0 ? rows.length : at;
    const next = dsDo((L) => loAddRow(L, containerId, index, spans), `Row added (${dsSpansText(spans)})`);
    const row = next && loFind(next, containerId)?.node.rows?.[index];
    if (row) dsFocus(dsFor(`row:${row.id}`));
  });
}

function dsRowPlace(layout, rowId) {
  const loc = loFind(layout, rowId);
  if (!loc || loc.kind !== 'row') return null;
  const rows = loc.parent.rows ?? [];
  return { row: loc.node, container: loc.parent, rows, index: rows.findIndex((r) => r.id === rowId) };
}

// the row's widgets would be lost by these spans (loSetSpans drops trailing slots)
const dsDropsWidgets = (row, spans) => row.slots.slice(spans.length).some((s) => (s.widgets ?? []).length > 0);

function dsSplitRow(rowId) {
  const row = deFind(deState.draft, 'row', rowId);
  const anchor = $('dash-root')?.querySelector(dsFor(`row:${rowId}`));
  if (!row || !anchor) return;
  dsPicker(
    anchor,
    (spans) => dsDo((L) => loSetSpans(L, rowId, spans), `Row split ${dsSpansText(spans)}`),
    row.slots.map((s) => s.span),
    (spans) => dsDropsWidgets(row, spans),
  );
}

// a copy right after the row: fresh row / slot ids (loAddRow), widgets copied with fresh ids
// (loDuplicateWidget puts the copy beside its original; loMoveWidget takes it to the new slot)
function dsDuplicateRow(L, rowId) {
  const p = dsRowPlace(L, rowId);
  if (!p) throw new LoError(`No row with id "${rowId}"`);
  const src = p.row;
  let out = loAddRow(L, p.container.id, p.index + 1, src.slots.map((s) => s.span));
  const copy = loFind(out, p.container.id).node.rows[p.index + 1];
  out = loSetRowHeight(out, copy.id, src.height);
  src.slots.forEach((slot, j) => {
    slot.widgets.forEach((w, k) => {
      out = loDuplicateWidget(out, w.id);
      const dup = loFind(out, slot.id).node.widgets[k + 1];
      out = loMoveWidget(out, dup.id, copy.slots[j].id);
    });
  });
  return out;
}

deMenuItems('row', (id) => {
  const p = dsRowPlace(deState.draft, id);
  if (!p) return [];
  const n = dsWidgetCount({ rows: [p.row] });
  return [
    { label: 'Split…', onSelect: () => dsSplitRow(id) },
    { label: 'Move row up', disabled: p.index <= 0, onSelect: () => dsDo((L) => loMoveRow(L, id, p.container.id, p.index - 1), 'Row moved up') },
    { label: 'Move row down', disabled: p.index >= p.rows.length - 1, onSelect: () => dsDo((L) => loMoveRow(L, id, p.container.id, p.index + 1), 'Row moved down') },
    {
      label: 'Duplicate row',
      onSelect: () => {
        const next = dsDo((L) => dsDuplicateRow(L, id), 'Row duplicated');
        const copy = next && loFind(next, p.container.id)?.node.rows?.[p.index + 1];
        if (copy) dsFocus(dsFor(`row:${copy.id}`));
      },
    },
    { separator: true },
    {
      label: 'Delete row',
      danger: true,
      onSelect: () => {
        const label = n ? `Row and its ${n} widget${n > 1 ? 's' : ''} deleted` : 'Row deleted';
        const next = dsDeleted(dsDo((L) => loRemoveRow(L, id), label), label, () => dsHandle(`row:${id}`));
        if (!next) return;
        const after = loFind(next, p.container.id)?.node.rows?.[p.index];
        if (!(after && dsFocus(dsFor(`row:${after.id}`)))) dsFocus(`.ds-add-end[data-container-id="${CSS.escape(p.container.id)}"] > button`);
      },
    },
  ];
});

// ── column dividers ──

function dsDividerSpans(rowId) {
  const row = deFind(deState.draft, 'row', rowId);
  return row ? row.slots.map((s) => s.span) : null;
}

function dsStep(rowId, i, d) {
  const spans = dsDividerSpans(rowId);
  if (!spans) return;
  const a = spans[i] + d;
  const b = spans[i + 1] - d;
  if (a < 1 || b < 1) return void deAnnounce(`Column ${a < 1 ? i + 1 : i + 2} is at its narrowest`);
  spans[i] = a;
  spans[i + 1] = b;
  // a burst of presses on one divider is one undo step
  if (dsDo((L) => loSetSpans(L, rowId, spans), `Columns ${a} | ${b}`, { coalesce: `${rowId}:divider` })) dsFocus(`.ds-div[data-ds-key="${CSS.escape(`${rowId}:${i}`)}"]`);
}

// the divider drag in progress: { end(commit) } or null
let dsDrag = null;

function dsDivider(rowEl, rowId, spans, i) {
  const div = node('div', 'ds-div');
  div.dataset.dsKey = `${rowId}:${i}`;
  div.tabIndex = 0;
  div.setAttribute('role', 'separator');
  div.setAttribute('aria-orientation', 'vertical');
  div.setAttribute('aria-label', `Divider between columns ${i + 1} and ${i + 2}`);
  div.setAttribute('aria-valuemin', '1');
  div.setAttribute('aria-valuemax', String(spans[i] + spans[i + 1] - 1));
  div.setAttribute('aria-valuenow', String(spans[i]));
  div.setAttribute('aria-valuetext', `${spans[i]} | ${spans[i + 1]}`);
  div.title = 'Drag to resize the columns (or focus and use Left / Right)';
  const before = spans.slice(0, i).reduce((s, v) => s + v, 0);
  div.style.setProperty('--c', String(before + spans[i]));
  const label = node('span', 'ds-div-label', `${spans[i]} | ${spans[i + 1]}`);
  label.setAttribute('aria-hidden', 'true');
  div.append(label);

  div.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    dsStep(rowId, i, e.key === 'ArrowLeft' ? -1 : 1);
  });
  div.addEventListener('click', (e) => e.stopPropagation());
  div.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !deState.active || dsDrag) return;
    e.preventDefault();
    e.stopPropagation();
    const a0 = spans[i];
    const b0 = spans[i + 1];
    const rect = rowEl.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(rowEl).columnGap) || 14;
    const pitch = (rect.width - 11 * gap) / 12 + gap;
    const x0 = e.clientX;
    const slots = rowEl.querySelectorAll(':scope > .dw-slot');
    let d = 0;
    const show = () => {
      slots[i]?.style.setProperty('--span', String(a0 + d));
      slots[i + 1]?.style.setProperty('--span', String(b0 - d));
      div.style.setProperty('--c', String(before + a0 + d));
      label.textContent = `${a0 + d} | ${b0 - d}`;
    };
    const move = (ev) => {
      const nd = Math.max(1 - a0, Math.min(b0 - 1, Math.round((ev.clientX - x0) / pitch)));
      if (nd !== d) {
        d = nd;
        show();
      }
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const esc = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    // the only way out (release, cancel, Esc, lost capture, window blur, a re-render, exit): runs
    // once, always detaches every listener and visual state, then commits (release only) or reverts
    let ended = false;
    const end = (commit) => {
      if (ended) return;
      ended = true;
      if (dsDrag?.end === end) dsDrag = null;
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
      div.removeEventListener('pointercancel', cancel);
      div.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', cancel);
      try {
        if (div.hasPointerCapture?.(e.pointerId)) div.releasePointerCapture(e.pointerId);
      } catch {} // already gone with the element
      div.classList.remove('ds-dragging');
      rowEl.classList.remove('ds-resizing');
      const moved = d;
      d = 0;
      show(); // back to the layout's spans (a commit re-renders anyway)
      if (commit && moved !== 0 && div.isConnected) {
        const next = spans.slice();
        next[i] = a0 + moved;
        next[i + 1] = b0 - moved;
        dsDo((L) => loSetSpans(L, rowId, next), `Columns ${next[i]} | ${next[i + 1]}`);
      }
    };
    dsDrag = { end };
    div.setPointerCapture(e.pointerId);
    div.classList.add('ds-dragging');
    rowEl.classList.add('ds-resizing');
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
    div.addEventListener('pointercancel', cancel);
    div.addEventListener('lostpointercapture', cancel);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('blur', cancel);
  });
  return div;
}

// ── inline titles (sections, tabs) ──

// A text input: max 60 chars, trimmed; Enter / blur commit, Esc cancels; empty reverts.
// onDone(title | null) runs once (null: reverted). An untouched value comes back as-is (a longer
// existing title is shown whole and never truncated unless edited).
function dsInlineInput(value, label, onDone) {
  const input = node('input', 'ds-inline');
  input.type = 'text';
  input.maxLength = DS_TITLE_MAX;
  input.value = value;
  input.setAttribute('aria-label', label);
  input.spellcheck = false;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const raw = input.value;
    const v = raw.trim().slice(0, DS_TITLE_MAX);
    input.remove();
    onDone(!commit || !v ? null : raw === value ? value : v);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  for (const ev of ['click', 'pointerdown', 'dblclick']) input.addEventListener(ev, (e) => e.stopPropagation());
  return input;
}

// ── sections ──

function dsRenameSection(id) {
  const sec = deFind(deState.draft, 'section', id);
  const el = deNodeFor('section', id);
  const head = el?.querySelector(':scope > .dw-sec-head');
  const toggle = head?.querySelector('.dw-sec-toggle');
  if (!sec || !toggle || head.querySelector('.ds-inline')) return;
  const input = dsInlineInput(sec.title, 'Section title', (title) => {
    toggle.hidden = false;
    if (title && title !== sec.title) dsDo((L) => loRenameSection(L, id, title), `Section renamed to ${title}`);
    else if (title === null) deAnnounce('Rename cancelled');
    if (!dsFocus(dsFor(`section:${id}`))) toggle.focus();
  });
  input.classList.add('ds-inline-section');
  toggle.hidden = true;
  head.prepend(input);
  input.focus();
  input.select();
}

function dsAddSection(wrap) {
  const btn = wrap.querySelector('.ds-add-section-btn');
  if (!btn || wrap.querySelector('.ds-inline')) return;
  const input = dsInlineInput('New section', 'New section title', (title) => {
    btn.hidden = false;
    const next = title && dsDo((L) => loAddSection(L, undefined, title), `Section ${title} added`);
    const sec = next?.sections[next.sections.length - 1];
    if (!(sec && dsFocus(dsFor(`section:${sec.id}`)))) dsFocus('.ds-add-section-btn');
  });
  input.classList.add('ds-inline-section');
  btn.hidden = true;
  wrap.prepend(input);
  input.focus();
  input.select();
}

// The layout's collapsed default. This browser's own toggle (dashboard.js's localStorage override,
// dwCollapseKey) would hide it, so once the layout holds the value the override is cleared and the
// layout re-rendered (no history step).
function dsSetCollapsed(id, collapsed) {
  const label = collapsed ? 'Section collapsed' : 'Section expanded';
  const sec = deFind(deState.draft, 'section', id);
  if (!sec) return;
  const already = !!sec.collapsed === collapsed;
  if (!already && !dsDo((L) => loSetCollapsed(L, id, collapsed), label)) return;
  try {
    localStorage.removeItem(dwCollapseKey(id));
  } catch {} // storage unavailable: nothing stored to clear
  dwRenderLayout();
  if (already) deAnnounce(label);
}

deMenuItems('section', (id) => {
  const sections = deState.draft?.sections ?? [];
  const index = sections.findIndex((s) => s.id === id);
  if (index < 0) return [];
  const sec = sections[index];
  const shown = !deNodeFor('section', id)?.classList.contains('collapsed');
  const n = dsWidgetCount(sec);
  const widgets = `${n} widget${n > 1 ? 's' : ''}`;
  const del = () => {
    const label = n ? `Section and its ${widgets} deleted` : 'Section deleted';
    const next = dsDeleted(dsDo((L) => loRemoveSection(L, id), label), label, () => dsHandle(`section:${id}`));
    if (!next) return;
    const after = next.sections[Math.min(index, next.sections.length - 1)];
    if (!(after && dsFocus(dsFor(`section:${after.id}`)))) dsFocus('.ds-add-section-btn');
  };
  const only = sections.length <= 1;
  return [
    { label: 'Rename', onSelect: () => dsRenameSection(id) },
    { label: 'Move section up', disabled: index === 0, onSelect: () => dsDo((L) => loMoveSection(L, id, index - 1), 'Section moved up') },
    { label: 'Move section down', disabled: index === sections.length - 1, onSelect: () => dsDo((L) => loMoveSection(L, id, index + 1), 'Section moved down') },
    { label: shown ? 'Collapse' : 'Expand', onSelect: () => dsSetCollapsed(id, shown) },
    { separator: true },
    only
      ? { label: 'Can’t delete the only section', disabled: true }
      : n
        ? { label: `Delete section and its ${widgets}…`, danger: true, onSelect: () => dsConfirmDeleteSection(sec, widgets, del) }
        : { label: 'Delete section', danger: true, onSelect: del },
  ];
});

// "Delete “<title>” and its N widgets?" → onDelete (still one undoable edit)
let dsConfirmClose = null;
function dsConfirmDeleteSection(sec, widgets, onDelete) {
  if (svModal) return;
  const { dlg, close, mount } = openModal({
    labelledBy: 'ds-del-title',
    describedBy: 'ds-del-sub',
    busy: () => false,
    onClose: () => (dsConfirmClose = null),
    fallbackFocus: () => $('dash-root')?.querySelector(dsFor(`section:${sec.id}`)),
  });
  dsConfirmClose = close;
  const title = node('h2', 'sv-title', `Delete ${sec.title ? `“${sec.title}”` : 'this section'} and its ${widgets}?`);
  title.id = 'ds-del-title';
  const sub = node('p', 'sv-sub', 'The section and everything in it leave your draft. You can undo this.');
  sub.id = 'ds-del-sub';
  const foot = node('div', 'sv-foot');
  const cancel = node('button', 'home-btn', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = close;
  const ok = node('button', 'home-btn pl-danger', 'Delete');
  ok.type = 'button';
  ok.onclick = () => {
    close();
    onDelete();
  };
  foot.append(node('span', 'sv-foot-note'), cancel, ok);
  dlg.append(title, sub, foot);
  mount();
  cancel.focus();
}

// ── tabs ──

// The selected-tab key is owned by widget-tabs.js (dwTabsKey(ctx), keyed by the board and the
// tabs widget's id); this is the one place we reach it.
const dsTabStoreKey = (widgetId) => dwTabsKey({ projectId: dw.board, id: widgetId });

// an input laid over the frame at x (the tab's place), so the tablist holds only tabs
function dsTabInput(frame, x, y, h, w, value, label, onDone) {
  const input = dsInlineInput(value, label, onDone);
  input.classList.add('ds-inline-tab');
  const fw = frame.clientWidth;
  input.style.left = `${Math.max(4, Math.min(x, fw - w - 4))}px`;
  input.style.top = `${y}px`;
  input.style.height = `${h}px`;
  input.style.width = `${w}px`;
  frame.append(input);
  input.focus();
  input.select();
}

function dsRenameTab(tabId) {
  const tab = deFind(deState.draft, 'tab', tabId);
  const btn = deNodeFor('tab', tabId);
  const frame = btn?.closest('.dw-widget');
  if (!tab || !frame || frame.querySelector(':scope > .ds-inline')) return;
  const fr = frame.getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  btn.classList.add('ds-renaming');
  dsTabInput(frame, r.left - fr.left, r.top - fr.top, r.height, Math.max(r.width, 140), tab.title, 'Tab title', (title) => {
    btn.classList.remove('ds-renaming');
    if (title && title !== tab.title) dsDo((L) => loRenameTab(L, tabId, title), `Tab renamed to ${title}`);
    else if (title === null) deAnnounce('Rename cancelled');
    (deNodeFor('tab', tabId) ?? btn).focus();
  });
}

function dsAddTab(frame) {
  const widgetId = frame.dataset.widgetId;
  if (frame.querySelector(':scope > .ds-inline')) return;
  const fr = frame.getBoundingClientRect();
  const strip = frame.querySelector('.dw-tabs-strip');
  const last = strip?.querySelector('.dw-tab:last-of-type');
  const lr = last?.getBoundingClientRect();
  const sr = strip?.getBoundingClientRect();
  const x = lr ? lr.right - fr.left + 4 : (sr ? sr.left - fr.left : 16);
  const y = lr ? lr.top - fr.top : (sr ? sr.top - fr.top : 12);
  const add = frame.querySelector(':scope > .ds-tab-add');
  if (add) add.hidden = true; // the input takes its place
  dsTabInput(frame, x, y, lr?.height ?? 30, 140, 'New tab', 'New tab title', (title) => {
    if (add) add.hidden = false;
    if (!title) return void (frame.isConnected && add?.focus());
    const next = dsDo((L) => loAddTab(L, widgetId, title), `Tab ${title} added`);
    const tabs = next && loFind(next, widgetId)?.node.params.tabs;
    const tabId = tabs?.[tabs.length - 1]?.id;
    if (tabId) {
      // applied: show the new tab (the selected tab is the tabs widget's stored choice)
      try {
        localStorage.setItem(dsTabStoreKey(widgetId), tabId);
        dwRenderLayout();
      } catch {} // storage unavailable: the first tab stays shown
    }
    const btn = tabId && deNodeFor('tab', tabId);
    if (btn) btn.focus();
    else dsFocus(dsFor(`tabs:${widgetId}`));
  });
}

deMenuItems('tab', (id) => {
  const loc = loFind(deState.draft, id);
  if (!loc || loc.kind !== 'tab') return [];
  const widgetId = loc.parent.id;
  const tabs = loc.parent.params.tabs;
  const index = tabs.findIndex((t) => t.id === id);
  const focusTab = () => deNodeFor('tab', id)?.focus();
  return [
    { label: 'Rename', onSelect: () => dsRenameTab(id) },
    { label: 'Move tab left', disabled: index === 0, onSelect: () => dsDo((L) => loMoveTab(L, widgetId, id, index - 1), 'Tab moved left') && focusTab() },
    { label: 'Move tab right', disabled: index === tabs.length - 1, onSelect: () => dsDo((L) => loMoveTab(L, widgetId, id, index + 1), 'Tab moved right') && focusTab() },
    { separator: true },
    {
      label: tabs.length > 1 ? 'Delete tab' : 'Delete tab (the last tab can’t go)',
      danger: tabs.length > 1,
      disabled: tabs.length <= 1,
      onSelect: () => {
        const label = `Tab ${tabs[index].title} deleted`;
        if (dsDeleted(dsDo((L) => loRemoveTab(L, id), label), label, () => deNodeFor('tab', id))) dsFocus(dsFor(`tabs:${widgetId}`));
      },
    },
  ];
});

// ── decoration ──

function dsEndButton(host) {
  const wrap = node('div', 'ds-add-end');
  const b = node('button', 'ds-add-end-btn');
  b.type = 'button';
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  const plus = node('span', 'ds-plus', '+');
  plus.setAttribute('aria-hidden', 'true');
  b.append(plus, node('span', '', 'Add row'));
  const containerId = () => (host.classList.contains('dw-tabs-panel') ? host.dataset.tabId : host.closest('.dw-section')?.dataset.sectionId);
  wrap.dataset.containerId = containerId() ?? '';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = containerId();
    if (id) dsAddRow(b, id, null);
  });
  wrap.append(b);
  return wrap;
}

function dsInserter(rowEl) {
  const wrap = node('div', 'ds-ins');
  const b = node('button', 'ds-ins-btn');
  b.type = 'button';
  b.setAttribute('aria-label', 'Add row here');
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.title = 'Add row here';
  const plus = node('span', 'ds-plus', '+');
  plus.setAttribute('aria-hidden', 'true');
  b.append(plus);
  const rowId = rowEl.dataset.rowId;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const p = dsRowPlace(deState.draft, rowId);
    if (p) dsAddRow(b, p.container.id, rowId);
  });
  wrap.append(b);
  return wrap;
}

function dsDecoratePanel(panel) {
  if (!deState.active || !panel.isConnected || !panel.dataset.tabId) return;
  const end = panel.querySelector(':scope > .ds-add-end');
  if (end && end === panel.lastElementChild) return;
  end?.remove();
  panel.append(dsEndButton(panel));
}

function dsDecorate(root) {
  if (!deState.active) return;
  // between rows: before each later row's bar
  for (const rowEl of dsAll(root, '.dw-row[data-row-id]')) {
    const siblings = [...rowEl.parentElement.querySelectorAll(':scope > .dw-row')];
    if (siblings.indexOf(rowEl) > 0) {
      const top = rowEl.previousElementSibling?.classList.contains('de-row-bar') ? rowEl.previousElementSibling : rowEl;
      if (!top.previousElementSibling?.classList.contains('ds-ins')) top.before(dsInserter(rowEl));
    }
    // column dividers between adjacent slots
    const id = rowEl.dataset.rowId;
    const spans = dsDividerSpans(id);
    if (!spans || spans.length < 2 || rowEl.querySelector(':scope > .ds-div')) continue;
    for (let i = 0; i < spans.length - 1; i++) rowEl.append(dsDivider(rowEl, id, spans, i));
  }
  // end of every section
  for (const body of dsAll(root, '.dw-sec-body')) {
    if (!body.querySelector(':scope > .ds-add-end')) body.append(dsEndButton(body));
  }
  // tab panels: their contents change on a tab switch (an empty tab renders without a hook)
  for (const panel of dsAll(root, '.dw-tabs-panel')) {
    dsDecoratePanel(panel);
    if (dsObservers.has(panel)) continue;
    const mo = new MutationObserver(() => dsDecoratePanel(panel));
    mo.observe(panel, { childList: true });
    dsObservers.set(panel, mo);
  }
  // tabs widgets: + right after the last tab (on the frame, outside the tablist); F2 /
  // double-click renames
  for (const frame of dsAll(root, '.dw-widget[data-widget-type="tabs"]')) {
    if (!frame.querySelector(':scope > .ds-tab-add')) {
      const b = node('button', 'ds-tab-add');
      b.type = 'button';
      b.setAttribute('aria-label', 'Add tab');
      b.title = 'Add tab';
      const plus = node('span', 'ds-plus', '+');
      plus.setAttribute('aria-hidden', 'true');
      b.append(plus);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        dsAddTab(frame);
      });
      // after the body (which holds the tablist): next to the tabs in the focus order too
      const body = frame.querySelector(':scope > .dw-body');
      if (body) body.after(b);
      else frame.append(b);
    }
    dsTrackTabAdd(frame);
    for (const tab of frame.querySelectorAll('.dw-tab[data-tab-id]')) {
      if (tab.dataset.dsTab) continue;
      tab.dataset.dsTab = '1';
      tab.addEventListener('dblclick', (e) => {
        if (!deState.active) return;
        e.preventDefault();
        dsRenameTab(tab.dataset.tabId);
      });
      tab.addEventListener('keydown', (e) => {
        if (!deState.active || e.key !== 'F2') return;
        e.preventDefault();
        dsRenameTab(tab.dataset.tabId);
      });
    }
  }
  // the bottom of the dashboard
  if (root.id === 'dash-root' && !root.querySelector(':scope > .ds-add-section')) {
    const wrap = node('div', 'ds-add-section');
    const b = node('button', 'ds-add-section-btn');
    b.type = 'button';
    const plus = node('span', 'ds-plus', '+');
    plus.setAttribute('aria-hidden', 'true');
    b.append(plus, node('span', '', 'Add section'));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      dsAddSection(wrap);
    });
    wrap.append(b);
    root.append(wrap);
  }
}

// The tab + sits just right of the last tab, kept clear of the core's handles on the frame (the
// tab / widget ⋮, measured: the leftmost one level with the strip). The strip's right margin
// reserves that much (a margin, not padding: an overflowing strip scrolls its tabs under its own
// padding), so the tabs never run under the + or the handles. Re-placed whenever a tab or the
// strip changes size or the strip scrolls.
const DS_TAB_ADD_GAP = 6;
function dsPlaceTabAdd(frame) {
  const b = frame.querySelector(':scope > .ds-tab-add');
  const strip = frame.querySelector('.dw-tabs-strip');
  const tabs = strip?.querySelectorAll(':scope > .dw-tab[data-tab-id]') ?? [];
  const last = tabs[tabs.length - 1];
  if (!b || !last?.getClientRects().length) return;
  const fr = frame.getBoundingClientRect();
  const sr = strip.getBoundingClientRect();
  const bw = b.offsetWidth;
  const bh = b.offsetHeight;
  let end = fr.right - DS_TAB_ADD_GAP; // no handles: the frame's edge
  for (const h of frame.querySelectorAll(':scope > .de-btn')) {
    const r = h.getBoundingClientRect();
    if (r.width && r.top < sr.bottom && r.bottom > sr.top) end = Math.min(end, r.left);
  }
  const maxLeft = end - DS_TAB_ADD_GAP - bw; // viewport x
  // the strip ends a gap before the +'s furthest place (its right edge as if unmargined, less that)
  const unmargined = sr.right + (parseFloat(getComputedStyle(strip).marginRight) || 0);
  strip.style.marginRight = `${Math.floor(unmargined - (maxLeft - DS_TAB_ADD_GAP))}px`;
  const lr = last.getBoundingClientRect();
  const x = Math.max(4, Math.min(lr.right + DS_TAB_ADD_GAP, maxLeft) - fr.left);
  b.style.left = `${x}px`;
  b.style.top = `${lr.top - fr.top + (lr.height - bh) / 2}px`;
}

function dsTrackTabAdd(frame) {
  const strip = frame.querySelector('.dw-tabs-strip');
  const old = dsTabAddObs.get(frame);
  if (old?.strip !== strip) {
    old?.stop();
    dsTabAddObs.delete(frame);
    if (strip) {
      const place = () => dsPlaceTabAdd(frame);
      const ro = new ResizeObserver(place);
      ro.observe(frame);
      ro.observe(strip);
      const add = frame.querySelector(':scope > .ds-tab-add');
      if (add) ro.observe(add); // shown again after its input closes
      for (const tab of strip.querySelectorAll('.dw-tab')) ro.observe(tab);
      strip.addEventListener('scroll', place, { passive: true });
      dsTabAddObs.set(frame, {
        strip,
        stop: () => {
          ro.disconnect();
          strip.removeEventListener('scroll', place);
          strip.style.marginRight = '';
        },
      });
    }
  }
  dsPlaceTabAdd(frame);
}

// tab panel → its MutationObserver; tabs frame → its + tracker ({ strip, stop })
const dsObservers = new Map();
const dsTabAddObs = new Map();
function dsDisconnect(all) {
  for (const [panel, mo] of dsObservers) {
    if (!all && panel.isConnected) continue;
    mo.disconnect();
    dsObservers.delete(panel);
  }
  for (const [frame, o] of dsTabAddObs) {
    if (!all && frame.isConnected) continue;
    o.stop();
    dsTabAddObs.delete(frame);
  }
}

deDecorate(dsDecorate);

// 'render' fires after the decorators: panels a re-render replaced lose their observers, and a
// divider drag still in progress ends (its divider is gone or stale; it reverts, no commit)
deOn('render', () => {
  dsDrag?.end(false);
  dsDisconnect(false);
});
// an edit after a delete (or its undo) retires that toast's Undo
deOn('change', () => {
  if (dsToastUndo && deState.draft !== dsToastUndo) dsToastHide();
});
deOn('exit', () => {
  dsDrag?.end(false);
  dsDisconnect(true);
  dsConfirmClose?.();
  dsToastHide();
  $('ds-toast')?.replaceChildren();
});
