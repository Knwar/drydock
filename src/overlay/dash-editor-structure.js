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
//                Collapse / Expand (saved in the layout), Delete
//   tabs         a + after the strip (outside the tablist); F2 / double-click renames a tab inline;
//                menu: Rename, Move left / right, Delete (not the last)

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

// A visible note for a refused edit (also announced).
let dsToastTimer = 0;
function dsRefuse(message) {
  deAnnounce(message);
  let t = $('ds-toast');
  if (!t) {
    t = node('div', 'ds-toast');
    t.id = 'ds-toast';
    t.setAttribute('aria-hidden', 'true'); // the live region already speaks it
    document.body.append(t);
  }
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(dsToastTimer);
  dsToastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// make(draft) → a new layout via lo* ops; a LoError is refused out loud. → the applied layout or null
function dsDo(make, label) {
  if (!deState.active) return null;
  let next;
  try {
    next = make(deState.draft);
  } catch (e) {
    if (!(e instanceof LoError)) throw e;
    dsRefuse(e.message);
    return null;
  }
  return deApply(next, label) ? next : null;
}

function dsFocus(selector) {
  const el = selector && $('dash-root')?.querySelector(selector);
  el?.focus();
  return !!el;
}
const dsFor = (key) => `[data-de-for="${CSS.escape(key)}"]`;

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

// items: menu items, some with .spans; warn(spans) → true marks one that would drop widgets
function dsOpenPicker(anchor, items, warn, title) {
  deMenu(anchor, items);
  const lv = deMenuState?.levels[0];
  if (!lv) return;
  lv.el.classList.add('ds-picker');
  lv.el.setAttribute('aria-label', title);
  for (const b of lv.buttons) {
    const it = b._deItem;
    if (!it?.spans) continue;
    b.querySelector('.de-menu-label')?.before(dsDiagram(it.spans));
    if (warn?.(it.spans)) {
      b.classList.add('ds-warned');
      b.append(node('span', 'ds-warn', 'drops widgets'));
    }
  }
  deMenuPlace(lv.el, anchor, false); // the diagrams widened it
}

// onPick(spans); current: the row's spans (Split) or null (Add row)
function dsPicker(anchor, onPick, current, warn) {
  const item = ([spans, name]) => ({
    label: `${name} (${dsSpansText(spans)})`,
    spans,
    ...(current ? { checked: dsSame(spans, current), radio: true } : {}),
    onSelect: () => onPick(spans),
  });
  const items = DS_PRESETS.map(item);
  items.push({ separator: true }, { label: 'Custom…', onSelect: () => dsCustomPicker(anchor, onPick, current, warn) });
  dsOpenPicker(anchor, items, warn, current ? 'Split row' : 'Add a row');
}

function dsCustomPicker(anchor, onPick, current, warn) {
  const items = [1, 2, 3, 4, 5, 6].map((n) => {
    const spans = dsEqualSplit(n);
    return [spans, `${n} column${n > 1 ? 's' : ''}`];
  });
  dsOpenPicker(
    anchor,
    items.map(([spans, name]) => ({
      label: `${name} (${dsSpansText(spans)})`,
      spans,
      ...(current ? { checked: dsSame(spans, current), radio: true } : {}),
      onSelect: () => onPick(spans),
    })),
    warn,
    'Number of columns',
  );
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
        const next = dsDo((L) => loRemoveRow(L, id), n ? `Row and its ${n} widget${n > 1 ? 's' : ''} deleted` : 'Row deleted');
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
  if (dsDo((L) => loSetSpans(L, rowId, spans), `Columns ${a} | ${b}`)) dsFocus(`.ds-div[data-ds-key="${CSS.escape(`${rowId}:${i}`)}"]`);
}

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
    if (e.button !== 0 || !deState.active) return;
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
    const end = (commit) => {
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
      div.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', esc, true);
      if (div.hasPointerCapture?.(e.pointerId)) div.releasePointerCapture(e.pointerId);
      div.classList.remove('ds-dragging');
      rowEl.classList.remove('ds-resizing');
      if (commit && d !== 0) {
        const next = spans.slice();
        next[i] = a0 + d;
        next[i + 1] = b0 - d;
        if (dsDo((L) => loSetSpans(L, rowId, next), `Columns ${next[i]} | ${next[i + 1]}`)) return;
      }
      d = 0;
      show();
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const esc = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    div.setPointerCapture(e.pointerId);
    div.classList.add('ds-dragging');
    rowEl.classList.add('ds-resizing');
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
    div.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', esc, true);
  });
  return div;
}

// ── inline titles (sections, tabs) ──

// A text input: max 60 chars, trimmed; Enter / blur commit, Esc cancels; empty or unchanged reverts.
// onDone(title | null) runs once (null: reverted).
function dsInlineInput(value, label, onDone) {
  const input = node('input', 'ds-inline');
  input.type = 'text';
  input.maxLength = DS_TITLE_MAX;
  input.value = value.slice(0, DS_TITLE_MAX);
  input.setAttribute('aria-label', label);
  input.spellcheck = false;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim().slice(0, DS_TITLE_MAX);
    input.remove();
    onDone(commit && v ? v : null);
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

// the layout's collapsed default; this browser's own toggle (localStorage) is cleared so it shows
function dsSetCollapsed(id, collapsed) {
  try {
    localStorage.removeItem(dwCollapseKey(id));
  } catch {} // storage unavailable: nothing stored to clear
  const label = collapsed ? 'Section collapsed' : 'Section expanded';
  const sec = deFind(deState.draft, 'section', id);
  if (sec && !!sec.collapsed === collapsed) {
    dwRenderLayout(); // already the layout's value: only the local override went
    return void deAnnounce(label);
  }
  dsDo((L) => loSetCollapsed(L, id, collapsed), label);
}

deMenuItems('section', (id) => {
  const sections = deState.draft?.sections ?? [];
  const index = sections.findIndex((s) => s.id === id);
  if (index < 0) return [];
  const sec = sections[index];
  const shown = !deNodeFor('section', id)?.classList.contains('collapsed');
  const n = dsWidgetCount(sec);
  const del = () => {
    const next = dsDo((L) => loRemoveSection(L, id), n ? `Section and its ${n} widget${n > 1 ? 's' : ''} deleted` : 'Section deleted');
    if (!next) return;
    const after = next.sections[Math.min(index, next.sections.length - 1)];
    if (!(after && dsFocus(dsFor(`section:${after.id}`)))) dsFocus('.ds-add-section-btn');
  };
  return [
    { label: 'Rename', onSelect: () => dsRenameSection(id) },
    { label: 'Move section up', disabled: index === 0, onSelect: () => dsDo((L) => loMoveSection(L, id, index - 1), 'Section moved up') },
    { label: 'Move section down', disabled: index === sections.length - 1, onSelect: () => dsDo((L) => loMoveSection(L, id, index + 1), 'Section moved down') },
    { label: shown ? 'Collapse' : 'Expand', onSelect: () => dsSetCollapsed(id, shown) },
    { separator: true },
    n
      ? { label: `Delete section and its ${n} widget${n > 1 ? 's' : ''}`, danger: true, onSelect: del }
      : { label: 'Delete section', danger: true, onSelect: del },
  ];
});

// ── tabs ──

const dsTabStoreKey = (widgetId) => `dw.tab.${dw.board}.${widgetId}`;

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
  dsTabInput(frame, x, y, lr?.height ?? 30, 140, 'New tab', 'New tab title', (title) => {
    if (!title) return void (frame.isConnected && frame.querySelector('.ds-tab-add')?.focus());
    let tabId = null;
    const next = dsDo((L) => {
      const out = loAddTab(L, widgetId, title);
      const tabs = loFind(out, widgetId).node.params.tabs;
      tabId = tabs[tabs.length - 1].id;
      try {
        localStorage.setItem(dsTabStoreKey(widgetId), tabId); // show the new tab
      } catch {} // the first tab shows instead
      return out;
    }, `Tab ${title} added`);
    const btn = next && tabId && deNodeFor('tab', tabId);
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
        if (dsDo((L) => loRemoveTab(L, id), `Tab ${tabs[index].title} deleted`)) dsFocus(dsFor(`tabs:${widgetId}`));
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
    if (panel._dsObserved) continue;
    panel._dsObserved = true;
    new MutationObserver(() => dsDecoratePanel(panel)).observe(panel, { childList: true });
  }
  // tabs widgets: + after the strip (on the frame, outside the tablist); F2 / double-click renames
  for (const frame of dsAll(root, '.dw-widget[data-widget-type="tabs"]')) {
    if (!frame.querySelector(':scope > .ds-tab-add')) {
      const b = node('button', 'de-btn ds-tab-add');
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
      frame.append(b);
    }
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

deDecorate(dsDecorate);
