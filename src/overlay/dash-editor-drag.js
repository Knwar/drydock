// ── Dashboard editor: moving and resizing widgets (globals prefix dd) ──
// Classic script loaded after dash-editor.js; builds on its API (deState, deApply, deDecorate,
// deMenuItems, deAnnounce, deNodeFor, deWidgetTitle, deMenuClose) and layout-ops.js's lo* ops.
//   Pointer drag: from a widget's .de-handle or header (past 4px) to any visible slot
//   Keyboard: Space on .de-handle picks up, arrows move, Space drops, Escape cancels
//   Menus: widget → Move / Size, row → Height
//   Resize: a corner grip on every widget (its registered sizes), a bottom edge on every row (1-12)
// Every change is one deApply of an lo* op (one undo step). Previews never touch the layout.

const DD_THRESHOLD = 4; // px before a press becomes a drag
const DD_SIZE_STEP = 48; // px of grip travel per size step
const DD_EDGE = 48; // px from the scroller's edge where auto-scroll starts
const DD_MAX_SPEED = 14; // px per frame
const DD_ROW_MAX = 12;

let ddDrag = null; // pointer drag in progress
let ddKb = null; // keyboard pick-up in progress
let ddSwallowSpaceUp = false; // the Space keyup after a pick-up / drop must not click the handle

// ── layout helpers (the draft) ──
const ddTitleOf = (id) => {
  const frame = deNodeFor('widget', id);
  if (frame) return deWidgetTitle(frame);
  const w = loFind(deState.draft, id)?.node;
  return w?.params?.title || w?.type || 'widget';
};

// { slotId, index } of a widget in the draft
function ddWhere(id) {
  const loc = loFind(deState.draft, id);
  if (!loc || loc.kind !== 'widget') return null;
  return { slotId: loc.parent.id, index: loc.parent.widgets.indexOf(loc.node) };
}

// the widgets a slot holds besides the one being moved
function ddOthers(slotId, dragId) {
  const slot = loFind(deState.draft, slotId)?.node;
  return (slot?.widgets ?? []).filter((w) => w.id !== dragId);
}

// a slot inside a tab group's panel
const ddInTab = (slotEl) => !!slotEl.parentElement?.closest('.dw-tabs-panel');

// The slots a widget can go to, in reading order (sections, rows, the visible tab panel's rows).
function ddTargets(dragId) {
  const root = $('dash-root');
  if (!root) return [];
  const tabs = loFind(deState.draft, dragId)?.node?.type === 'tabs';
  return [...root.querySelectorAll('.dw-slot[data-slot-id]')].filter((s) => s.getClientRects().length && !(tabs && ddInTab(s)));
}

// "Slot 2 of 3, row 1, Overview" (+ the place in a stack)
function ddPosLabel(slotId, index, dragId) {
  const layout = deState.draft;
  const slotLoc = loFind(layout, slotId);
  if (!slotLoc) return '';
  const row = slotLoc.parent;
  const box = loFind(layout, row.id)?.parent;
  const isSection = layout.sections.includes(box);
  const where = isSection ? box.title || 'Untitled section' : `${box?.title || 'Untitled'} tab`;
  let s = `Slot ${row.slots.indexOf(slotLoc.node) + 1} of ${row.slots.length}, row ${(box?.rows ?? []).indexOf(row) + 1}, ${where}`;
  const n = ddOthers(slotId, dragId).length;
  if (n > 0) s += `, position ${index + 1} of ${n + 1}`;
  return s;
}

// Move a widget; refused moves announce the reason. Returns deApply's verdict.
function ddMove(id, slotId, index, title = ddTitleOf(id)) {
  let next;
  try {
    next = loMoveWidget(deState.draft, id, slotId, index);
  } catch (e) {
    deAnnounce(e.message);
    return false;
  }
  return deApply(next, `Moved ${title}`);
}

// ── shared drop indicator: the target slot's highlight + an insertion line ──
let ddLine = null;
let ddLit = null;

function ddShow(slotEl, index, dragId) {
  if (ddLit !== slotEl) {
    ddLit?.classList.remove('de-drop-target');
    slotEl?.classList.add('de-drop-target');
    ddLit = slotEl;
  }
  if (!slotEl) return void ddLine?.remove();
  if (!ddLine) {
    ddLine = node('div', 'de-drop-line');
    ddLine.setAttribute('aria-hidden', 'true');
  }
  if (!ddLine.isConnected) document.body.append(ddLine);
  const r = slotEl.getBoundingClientRect();
  const frames = [...slotEl.querySelectorAll(':scope > .dw-widget')].filter((f) => f.dataset.widgetId !== dragId);
  const gap = parseFloat(getComputedStyle(slotEl).rowGap) || 0;
  let y;
  if (!frames.length) y = r.top + r.height / 2;
  else if (index <= 0) y = frames[0].getBoundingClientRect().top - gap / 2;
  else if (index >= frames.length) y = frames[frames.length - 1].getBoundingClientRect().bottom + gap / 2;
  else y = (frames[index - 1].getBoundingClientRect().bottom + frames[index].getBoundingClientRect().top) / 2;
  y = Math.max(r.top - gap / 2, Math.min(y, r.bottom + gap / 2));
  ddLine.style.left = `${r.left + 4}px`;
  ddLine.style.width = `${Math.max(0, r.width - 8)}px`;
  ddLine.style.top = `${Math.round(y - 1)}px`;
}

function ddHide() {
  ddLit?.classList.remove('de-drop-target');
  ddLit = null;
  ddLine?.remove();
}

// ── auto-scroll: Home's scroller, near the viewport's top / bottom ──
function ddScroller() {
  return $('home-body') ?? document.scrollingElement;
}
function ddAutoScroll(state, onScroll) {
  if (state.raf) return;
  const tick = () => {
    state.raf = 0;
    if (!state.active) return;
    const sc = ddScroller();
    const r = sc.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const y = state.y;
    let v = 0;
    if (y < top + DD_EDGE) v = -Math.ceil(((top + DD_EDGE - y) / DD_EDGE) * DD_MAX_SPEED);
    else if (y > bottom - DD_EDGE) v = Math.ceil(((y - (bottom - DD_EDGE)) / DD_EDGE) * DD_MAX_SPEED);
    v = Math.max(-DD_MAX_SPEED, Math.min(DD_MAX_SPEED, v));
    if (!v) return;
    const before = sc.scrollTop;
    sc.scrollTop += v;
    if (sc.scrollTop !== before) onScroll();
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

// A drag just ended: the click it would produce (menu, selection) is swallowed.
function ddSwallowClick() {
  const stop = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

// Esc during a pointer gesture cancels it (and nothing else hears it)
function ddEscOnce(cancel) {
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

// ── pointer drag ──
function ddPointerDown(e, frame) {
  if (!deState.active || e.button !== 0 || ddDrag || ddKb) return;
  const src = e.currentTarget;
  const id = frame.dataset.widgetId;
  const st = { id, frame, src, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, raf: 0, target: null, refused: false };
  ddDrag = st;
  const move = (ev) => {
    if (ev.pointerId !== st.pointerId) return;
    st.x = ev.clientX;
    st.y = ev.clientY;
    if (!st.active) {
      if (Math.hypot(st.x - st.x0, st.y - st.y0) <= DD_THRESHOLD) return;
      ddDragStart(st);
    }
    ev.preventDefault();
    ddDragMove(st);
  };
  const end = (ev, drop) => {
    if (ev && ev.pointerId !== st.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    st.offEsc?.();
    ddDrag = null;
    if (!st.active) return;
    ddDragEnd(st, drop);
  };
  const up = (ev) => end(ev, true);
  const cancel = (ev) => end(ev, false);
  st.cancel = () => end(null, false);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

function ddDragStart(st) {
  st.active = true;
  deMenuClose(false);
  try {
    st.src.setPointerCapture(st.pointerId);
  } catch {} // the pointer is already gone: window listeners still end the drag
  st.title = deWidgetTitle(st.frame);
  st.tabs = st.frame.dataset.widgetType === 'tabs';
  const r = st.frame.getBoundingClientRect();
  const w = Math.min(r.width, 260);
  const h = Math.min(r.height, 96);
  st.dx = Math.min(Math.max(st.x0 - r.left, 12), w - 12);
  st.dy = Math.min(Math.max(st.y0 - r.top, 12), h - 12);
  const ghost = node('div', 'de-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.width = `${w}px`;
  ghost.style.height = `${h}px`;
  ghost.append(node('span', 'de-ghost-title', st.title));
  document.body.append(ghost);
  st.ghost = ghost;
  st.frame.classList.add('de-dragging');
  document.body.classList.add('de-drag-active');
  st.offEsc = ddEscOnce(() => {
    st.cancel();
    deAnnounce('Move cancelled');
  });
}

// the slot under the pointer and the index within its stack
function ddHit(st) {
  const el = document.elementFromPoint(st.x, st.y);
  const slot = el?.closest?.('#dash-root .dw-slot[data-slot-id]');
  if (!slot) return { slot: null };
  if (st.tabs && ddInTab(slot)) return { slot, refused: true };
  const frames = [...slot.querySelectorAll(':scope > .dw-widget')].filter((f) => f !== st.frame);
  let index = 0;
  for (const f of frames) {
    const r = f.getBoundingClientRect();
    if (st.y > r.top + r.height / 2) index++;
  }
  return { slot, index };
}

function ddDragMove(st) {
  st.ghost.style.transform = `translate(${Math.round(st.x - st.dx)}px, ${Math.round(st.y - st.dy)}px)`;
  const hit = ddHit(st);
  st.refused = !!hit.refused;
  st.ghost.classList.toggle('refused', st.refused);
  if (!hit.slot || hit.refused) {
    st.target = null;
    ddHide();
  } else {
    st.target = { slotId: hit.slot.dataset.slotId, index: hit.index };
    ddShow(hit.slot, hit.index, st.id);
  }
  ddAutoScroll(st, () => ddDragMove(st));
}

function ddDragEnd(st, drop) {
  cancelAnimationFrame(st.raf);
  st.ghost?.remove();
  st.frame.classList.remove('de-dragging');
  document.body.classList.remove('de-drag-active');
  ddHide();
  try {
    st.src.releasePointerCapture(st.pointerId);
  } catch {} // already released
  ddSwallowClick();
  if (!drop) return;
  if (st.refused) return void deAnnounce('A tab group cannot go inside another tab group');
  if (st.target) ddMove(st.id, st.target.slotId, st.target.index, st.title);
}

// ── keyboard pick-up (on .de-handle, capture phase: ahead of its menu click) ──
function ddKeyDown(e, frame) {
  if (!deState.active) return;
  const handle = e.currentTarget;
  if (!ddKb) {
    if (e.key !== ' ' || e.repeat || ddDrag) return;
    e.preventDefault();
    e.stopPropagation();
    ddSwallowSpaceUp = true;
    deMenuClose(false);
    ddPickUp(frame, handle);
    return;
  }
  const k = ddKb;
  const keys = [' ', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Enter') return; // no menu mid-move
  if (e.key === 'Escape') return void ddKbEnd(false);
  if (e.key === ' ') {
    if (e.repeat) return;
    ddSwallowSpaceUp = true;
    return void ddKbEnd(true);
  }
  const { slotId, index } = k.pos;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const n = ddOthers(slotId, k.id).length;
    const to = Math.max(0, Math.min(n, index + (e.key === 'ArrowUp' ? -1 : 1)));
    k.pos = { slotId, index: to };
  } else {
    const targets = ddTargets(k.id);
    const i = targets.findIndex((s) => s.dataset.slotId === slotId);
    const next = targets[i + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (next) {
      const id = next.dataset.slotId;
      k.pos = { slotId: id, index: Math.min(index, ddOthers(id, k.id).length) };
    }
  }
  ddKbShow();
  deAnnounce(ddPosLabel(k.pos.slotId, k.pos.index, k.id));
}

function ddKeyUp(e) {
  if (e.key !== ' ' || !ddSwallowSpaceUp) return;
  ddSwallowSpaceUp = false;
  e.preventDefault();
  e.stopPropagation();
}

function ddPickUp(frame, handle) {
  const id = frame.dataset.widgetId;
  const pos = ddWhere(id);
  if (!pos) return;
  const title = deWidgetTitle(frame);
  ddKb = { id, title, frame, handle, pos, origin: pos };
  frame.classList.add('de-lifted');
  handle.setAttribute('aria-pressed', 'true');
  handle.addEventListener('blur', ddKbBlur);
  ddKbShow();
  deAnnounce(`Picked up ${title}. Arrow keys move, Space drops, Escape cancels.`);
}

function ddKbShow() {
  const slot = deNodeFor('slot', ddKb.pos.slotId);
  if (!slot) return void ddHide();
  slot.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  ddShow(slot, ddKb.pos.index, ddKb.id);
}

function ddKbBlur() {
  if (ddKb) ddKbEnd(false);
}

function ddKbEnd(drop) {
  const k = ddKb;
  if (!k) return;
  ddKb = null;
  k.handle.removeEventListener('blur', ddKbBlur);
  k.handle.removeAttribute('aria-pressed');
  k.frame.classList.remove('de-lifted');
  ddHide();
  if (!drop) return void deAnnounce(`Move cancelled. ${k.title} is back in place`);
  if (k.pos.slotId === k.origin.slotId && k.pos.index === k.origin.index) return void deAnnounce(`Dropped ${k.title}. No change`);
  ddMove(k.id, k.pos.slotId, k.pos.index, k.title);
  // the drop re-rendered the handle away: focus its successor
  document.querySelector(`[data-de-for="${CSS.escape(`widget:${k.id}`)}"]`)?.focus();
}

// a re-render or leaving edit mode ends any gesture
function ddReset() {
  if (ddDrag) ddDrag.cancel();
  if (ddKb) ddKbEnd(false);
  ddHide();
}
deOn('exit', ddReset);
deOn('render', (root) => {
  if (root?.id !== 'dash-root') return;
  if (ddDrag) ddDrag.cancel();
  if (ddKb && !ddKb.frame.isConnected) ddKbEnd(false);
});

// ── widget resize grip: snaps through the widget's registered sizes ──
const ddSizes = (type) => {
  const s = dwDef(type)?.sizes;
  return (Array.isArray(s) && s.length ? s : LO_SCHEMA.sizes).filter((x) => LO_SCHEMA.sizes.includes(x));
};

function ddGripDown(e, frame) {
  if (!deState.active || e.button !== 0 || ddDrag || ddKb) return;
  e.preventDefault();
  e.stopPropagation();
  const grip = e.currentTarget;
  const id = frame.dataset.widgetId;
  const w = loFind(deState.draft, id)?.node;
  if (!w) return;
  const sizes = ddSizes(w.type);
  const from = w.size;
  const i0 = Math.max(0, sizes.indexOf(from));
  deMenuClose(false);
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {} // window listeners still end it
  const label = node('div', 'de-size-label');
  label.setAttribute('aria-hidden', 'true');
  document.body.append(label);
  frame.classList.add('de-resizing');
  document.body.classList.add('de-resize-active', 'de-resize-widget');
  const x0 = e.clientX;
  const y0 = e.clientY;
  let to = from;
  const place = (x, y) => {
    label.textContent = `${from} → ${to}`;
    label.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 14)}px)`;
  };
  place(x0, y0);
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    to = sizes[Math.max(0, Math.min(sizes.length - 1, i0 + Math.round(delta / DD_SIZE_STEP)))];
    place(ev.clientX, ev.clientY);
  };
  const finish = (apply) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    offEsc();
    label.remove();
    frame.classList.remove('de-resizing');
    document.body.classList.remove('de-resize-active', 'de-resize-widget');
    try {
      grip.releasePointerCapture(e.pointerId);
    } catch {} // already released
    ddSwallowClick();
    if (apply && to !== from) ddSetSize(id, to);
  };
  const up = (ev) => ev.pointerId === e.pointerId && finish(true);
  const cancel = (ev) => ev.pointerId === e.pointerId && finish(false);
  const offEsc = ddEscOnce(() => {
    finish(false);
    deAnnounce('Resize cancelled');
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

function ddSetSize(id, size) {
  let next;
  try {
    next = loSetWidgetSize(deState.draft, id, size);
  } catch (e) {
    return void deAnnounce(e.message);
  }
  deApply(next, `Resized ${ddTitleOf(id)} to ${size}`);
}

// ── row bottom edge: height in whole units (one unit = 88px + the row gap) ──
function ddRowDown(e, rowEl) {
  if (!deState.active || e.button !== 0 || ddDrag || ddKb) return;
  e.preventDefault();
  e.stopPropagation();
  const edge = e.currentTarget;
  const id = rowEl.dataset.rowId;
  const row = loFind(deState.draft, id)?.node;
  if (!row) return;
  const from = row.height;
  const css = getComputedStyle(rowEl);
  const unit = (parseFloat(css.getPropertyValue('--dw-row')) || DW_ROW_PX) + (parseFloat(css.rowGap) || 0);
  deMenuClose(false);
  try {
    edge.setPointerCapture(e.pointerId);
  } catch {} // window listeners still end it
  const label = node('span', 'de-row-resize-label');
  label.setAttribute('aria-hidden', 'true');
  edge.append(label);
  edge.classList.add('active');
  document.body.classList.add('de-resize-active', 'de-resize-row');
  const y0 = e.clientY;
  let to = from;
  const show = () => {
    rowEl.style.setProperty('--h', String(to));
    label.textContent = to === from ? `Height ${from}` : `Height ${from} → ${to}`;
  };
  show();
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    to = Math.max(1, Math.min(DD_ROW_MAX, from + Math.round((ev.clientY - y0) / unit)));
    show();
  };
  const finish = (apply) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    offEsc();
    label.remove();
    edge.classList.remove('active');
    document.body.classList.remove('de-resize-active', 'de-resize-row');
    try {
      edge.releasePointerCapture(e.pointerId);
    } catch {} // already released
    ddSwallowClick();
    rowEl.style.setProperty('--h', String(from)); // the preview ends; deApply renders the result
    if (apply && to !== from) ddSetHeight(id, to);
  };
  const up = (ev) => ev.pointerId === e.pointerId && finish(true);
  const cancel = (ev) => ev.pointerId === e.pointerId && finish(false);
  const offEsc = ddEscOnce(() => {
    finish(false);
    deAnnounce('Resize cancelled');
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

function ddSetHeight(id, height) {
  let next;
  try {
    next = loSetRowHeight(deState.draft, id, height);
  } catch (e) {
    return void deAnnounce(e.message);
  }
  deApply(next, `Row height ${height}`);
}

// ── decoration (idempotent: each element is wired once) ──
deDecorate((root) => {
  for (const frame of root.querySelectorAll('.dw-widget[data-widget-id]')) {
    const handle = frame.querySelector(':scope > .de-handle');
    if (handle && !handle.dataset.ddWired) {
      handle.dataset.ddWired = '1';
      handle.addEventListener('pointerdown', (e) => ddPointerDown(e, frame));
      handle.addEventListener('keydown', (e) => ddKeyDown(e, frame), true);
      handle.addEventListener('keyup', ddKeyUp, true);
    }
    const head = frame.querySelector(':scope > .dw-head');
    if (head && !head.dataset.ddWired) {
      head.dataset.ddWired = '1';
      head.addEventListener('pointerdown', (e) => ddPointerDown(e, frame));
    }
    if (!frame.querySelector(':scope > .de-resize-grip') && ddSizes(frame.dataset.widgetType).length > 1) {
      const grip = node('div', 'de-resize-grip');
      grip.setAttribute('aria-hidden', 'true');
      grip.title = 'Drag to resize (or use Size in the widget menu)';
      grip.addEventListener('pointerdown', (e) => ddGripDown(e, frame));
      frame.append(grip);
    }
  }
  for (const row of root.querySelectorAll('.dw-row[data-row-id]')) {
    if (row.querySelector(':scope > .de-row-resize')) continue;
    const edge = node('div', 'de-row-resize');
    edge.setAttribute('aria-hidden', 'true');
    edge.title = 'Drag to change the row height (or use Height in the row menu)';
    edge.addEventListener('pointerdown', (e) => ddRowDown(e, row));
    row.append(edge);
  }
});

// ── menus ──
deMenuItems('widget', (id, info) => {
  const w = info.item;
  const at = ddWhere(id);
  if (!w || !at) return [];
  const title = info.el ? deWidgetTitle(info.el) : ddTitleOf(id);
  const n = ddOthers(at.slotId, id).length;
  const targets = ddTargets(id);
  const i = targets.findIndex((s) => s.dataset.slotId === at.slotId);
  const toSlot = (el) => () => {
    const sid = el.dataset.slotId;
    ddMove(id, sid, Math.min(at.index, ddOthers(sid, id).length), title);
  };
  const prev = i > 0 ? targets[i - 1] : null;
  const next = i >= 0 && i < targets.length - 1 ? targets[i + 1] : null;
  const sections = deState.draft.sections.map((sec) => {
    const slot = sec.rows?.[0]?.slots?.[0];
    return {
      label: sec.title || 'Untitled section',
      disabled: !slot,
      onSelect: () => ddMove(id, slot.id, undefined, title),
    };
  });
  const sizes = ddSizes(w.type);
  return [
    {
      label: 'Move',
      children: [
        { label: 'Up', disabled: at.index <= 0, onSelect: () => ddMove(id, at.slotId, at.index - 1, title) },
        { label: 'Down', disabled: at.index >= n, onSelect: () => ddMove(id, at.slotId, at.index + 1, title) },
        { label: 'Previous slot', disabled: !prev, onSelect: prev && toSlot(prev) },
        { label: 'Next slot', disabled: !next, onSelect: next && toSlot(next) },
        { label: 'To section', disabled: !sections.length, children: sections },
      ],
    },
    {
      label: 'Size',
      children: sizes.map((s) => ({ label: s, checked: w.size === s, radio: true, onSelect: () => ddSetSize(id, s) })),
    },
  ];
});

deMenuItems('row', (id, info) => {
  const row = info.item;
  if (!row) return [];
  const heights = Array.from({ length: DD_ROW_MAX }, (_, i) => i + 1);
  return [
    {
      label: 'Height',
      children: heights.map((h) => ({ label: String(h), checked: row.height === h, radio: true, onSelect: () => ddSetHeight(id, h) })),
    },
  ];
});
