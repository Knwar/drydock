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
let ddResize = null; // grip / row edge resize in progress
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

// a slot's rect and the rects of the widgets it holds besides the moving one (top to bottom)
function ddSlotGeo(slotEl, dragId) {
  const frames = [...slotEl.querySelectorAll(':scope > .dw-widget')].filter((f) => f.dataset.widgetId !== dragId);
  return { r: slotEl.getBoundingClientRect(), frames: frames.map((f) => f.getBoundingClientRect()) };
}

// the stack gap (one style read per gesture / key press, never per pointer move)
const ddGap = () => parseFloat(getComputedStyle($('dash-root') ?? document.body).getPropertyValue('--dw-gap')) || 0;

function ddShow(slotEl, index, geo, gap) {
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
  const { r, frames } = geo;
  let y;
  if (!frames.length) y = r.top + r.height / 2;
  else if (index <= 0) y = frames[0].top - gap / 2;
  else if (index >= frames.length) y = frames[frames.length - 1].bottom + gap / 2;
  else y = (frames[index - 1].bottom + frames[index].top) / 2;
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

// Home's scroller (auto-scroll target)
function ddScroller() {
  return $('home-body') ?? document.scrollingElement;
}

const ddBusy = () => !!(ddDrag || ddKb || ddResize);

// A gesture just ended (dropped or cancelled): swallow the click its release produces (the
// handle's menu, a selection). Armed until that release + 300ms (at most 500ms after a cancel
// with the button still down); a new press disarms it.
function ddSwallowClick(released) {
  let timer = 0;
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
    disarm();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(disarm, 300);
  };
  function disarm() {
    clearTimeout(timer);
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerdown', disarm, true);
    window.removeEventListener('pointerup', arm, true);
  }
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerdown', disarm, true);
  if (released) arm();
  else {
    window.addEventListener('pointerup', arm, true);
    timer = setTimeout(disarm, 500); // the release may never reach us: never stay armed
  }
}

// ── pointer drag ──
// st: { id, frame, src, pointerId, x0, y0, x, y, active, ended, raf (auto-scroll loop),
//       moveRaf (throttled move), slots (cached hit targets), stale, edge, target, refused }
function ddPointerDown(e, frame) {
  if (!deState.active || e.button !== 0 || ddBusy()) return;
  const src = e.currentTarget;
  const st = {
    id: frame.dataset.widgetId,
    frame,
    src,
    pointerId: e.pointerId,
    x0: e.clientX,
    y0: e.clientY,
    x: e.clientX,
    y: e.clientY,
    active: false,
    ended: false,
    raf: 0,
    moveRaf: 0,
    slots: [],
    stale: true,
    target: null,
    refused: false,
  };
  ddDrag = st;
  const mine = (ev) => ev.pointerId === st.pointerId;
  const onMove = (ev) => {
    if (!mine(ev)) return;
    if (ev.buttons === 0) return void ddDragStop(st, false); // released where we didn't hear it
    st.x = ev.clientX;
    st.y = ev.clientY;
    if (!st.active) {
      if (Math.hypot(st.x - st.x0, st.y - st.y0) <= DD_THRESHOLD) return;
      ddDragStart(st);
    }
    ev.preventDefault();
    if (!st.moveRaf)
      st.moveRaf = requestAnimationFrame(() => {
        st.moveRaf = 0;
        ddDragUpdate(st);
      });
  };
  const onUp = (ev) => {
    if (!mine(ev)) return;
    st.x = ev.clientX;
    st.y = ev.clientY;
    ddDragStop(st, true, true);
  };
  const onCancel = (ev) => mine(ev) && ddDragStop(st, false);
  // only the source's own capture: a child's lostpointercapture (touch / pen) bubbles here too
  const onLost = (ev) => ev.target === src && onCancel(ev);
  const onBlur = () => ddDragStop(st, false);
  const onKey = (ev) => {
    if (ev.key !== 'Escape' || !st.active) return;
    ev.preventDefault();
    ev.stopPropagation();
    ddDragStop(st, false);
    deAnnounce('Move cancelled');
  };
  const onScroll = () => (st.stale = true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', onBlur);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  src.addEventListener('lostpointercapture', onLost);
  st.off = () => {
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, { capture: true });
    src.removeEventListener('lostpointercapture', onLost);
  };
}

function ddDragStart(st) {
  st.active = true;
  deMenuClose(false);
  try {
    st.src.setPointerCapture(st.pointerId);
  } catch {} // the pointer is already gone: the window listeners still end the drag
  st.title = deWidgetTitle(st.frame);
  st.tabs = st.frame.dataset.widgetType === 'tabs';
  st.gap = ddGap();
  st.scroller = ddScroller();
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
  ddDragCache(st);
  ddAutoScrollLoop(st);
}

// Hit targets, measured once per drag and again after anything scrolls or re-renders.
// A tab panel's slots are clipped to the panel (they may scroll out of it) and win over the
// slot holding the tab group.
const ddClip = (a, b) => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });

function ddDragCache(st) {
  const root = $('dash-root');
  const sr = st.scroller.getBoundingClientRect();
  const scr = ddClip(sr, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  st.slots = [];
  for (const el of root ? root.querySelectorAll('.dw-slot[data-slot-id]') : []) {
    if (!el.getClientRects().length) continue; // a collapsed section
    const panel = el.parentElement?.closest('.dw-tabs-panel');
    const geo = ddSlotGeo(el, st.id);
    // only the part on screen: inside the scroller's view (and the tab panel's)
    let clip = ddClip(geo.r, scr);
    if (panel) clip = ddClip(clip, panel.getBoundingClientRect());
    st.slots.push({ el, id: el.dataset.slotId, inTab: !!panel, refused: st.tabs && !!panel, clip, ...geo });
  }
  st.edge = { top: scr.top, bottom: scr.bottom };
  st.stale = false;
}

function ddDragHit(st) {
  if (st.stale) ddDragCache(st);
  const { x, y } = st;
  let hit = null;
  for (const s of st.slots) {
    const c = s.clip;
    if (x < c.left || x > c.right || y < c.top || y > c.bottom) continue;
    if (!hit || (s.inTab && !hit.inTab)) hit = s;
  }
  if (!hit) return { slot: null };
  if (hit.refused) return { slot: hit, refused: true };
  let index = 0;
  for (const f of hit.frames) if (y > f.top + f.height / 2) index++;
  return { slot: hit, index };
}

// one paint of the drag (ghost, target, indicator); never schedules anything itself
function ddDragUpdate(st) {
  if (ddDrag !== st || !st.active) return;
  st.ghost.style.transform = `translate(${Math.round(st.x - st.dx)}px, ${Math.round(st.y - st.dy)}px)`;
  const hit = ddDragHit(st);
  st.refused = !!hit.refused;
  st.ghost.classList.toggle('refused', st.refused);
  if (!hit.slot || hit.refused) {
    st.target = null;
    ddHide();
  } else {
    st.target = { slotId: hit.slot.id, index: hit.index };
    ddShow(hit.slot.el, hit.index, hit.slot, st.gap);
  }
}

// One auto-scroll loop per drag, started once by ddDragStart: speed is bounded by
// DD_MAX_SPEED and the loop stops as soon as the drag isn't the live one any more.
function ddAutoScrollLoop(st) {
  const tick = () => {
    st.raf = 0;
    if (ddDrag !== st || !st.active) return;
    const { top, bottom } = st.edge;
    let v = 0;
    if (st.y < top + DD_EDGE) v = -Math.ceil(((top + DD_EDGE - st.y) / DD_EDGE) * DD_MAX_SPEED);
    else if (st.y > bottom - DD_EDGE) v = Math.ceil(((st.y - (bottom - DD_EDGE)) / DD_EDGE) * DD_MAX_SPEED);
    v = Math.max(-DD_MAX_SPEED, Math.min(DD_MAX_SPEED, v));
    if (v) {
      const sc = st.scroller;
      const before = sc.scrollTop;
      sc.scrollTop += v;
      if (sc.scrollTop !== before) {
        st.stale = true;
        ddDragUpdate(st);
      }
    }
    st.raf = requestAnimationFrame(tick);
  };
  st.raf = requestAnimationFrame(tick);
}

// Every end path: drop (pointerup) or cancel (Esc, pointercancel, lost capture, blur,
// buttons released, re-render, exit). Idempotent.
function ddDragStop(st, drop, released = false) {
  if (st.ended) return;
  st.ended = true;
  const was = st.active;
  st.active = false;
  if (ddDrag === st) ddDrag = null;
  st.off();
  cancelAnimationFrame(st.raf);
  cancelAnimationFrame(st.moveRaf);
  st.raf = st.moveRaf = 0;
  if (!was) return; // a press that never became a drag: its click goes through
  // where it ends counts, even if the last move's frame hadn't painted yet
  const hit = drop ? ddDragHit(st) : null;
  st.ghost?.remove();
  st.frame.classList.remove('de-dragging');
  document.body.classList.remove('de-drag-active');
  ddHide();
  try {
    st.src.releasePointerCapture(st.pointerId);
  } catch {} // already released
  ddSwallowClick(released);
  if (!hit?.slot) return;
  if (hit.refused) return void deAnnounce('A tab group cannot go inside another tab group');
  ddMove(st.id, hit.slot.id, hit.index, st.title);
}

// ── keyboard pick-up (on .de-handle, capture phase: ahead of its menu click) ──
function ddKeyDown(e, frame) {
  if (!deState.active) return;
  const handle = e.currentTarget;
  if (!ddKb) {
    if (e.key !== ' ' || e.repeat || ddBusy()) return;
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
  ddShow(slot, ddKb.pos.index, ddSlotGeo(slot, ddKb.id), ddGap());
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

// a re-render or leaving edit mode ends any gesture (cancelled, never applied)
function ddReset() {
  if (ddDrag) ddDragStop(ddDrag, false);
  ddResize?.stop(false);
  if (ddKb) ddKbEnd(false);
  ddHide();
}
deOn('exit', ddReset);
deOn('render', (root) => {
  if (ddDrag) ddDrag.stale = true; // a tab panel re-rendered: re-measure
  if (root?.id !== 'dash-root') return;
  if (ddDrag) ddDragStop(ddDrag, false);
  ddResize?.stop(false);
  if (ddKb && !ddKb.frame.isConnected) ddKbEnd(false);
});

// ── resize gestures (grip, row edge) ──
// Pointer capture on el; moves are painted once per frame via onMove(dx, dy, x, y). Ends on
// pointerup (onEnd(true)) or, without a change, on Esc / pointercancel / lost capture / blur /
// buttons released / re-render / exit (onEnd(false)).
function ddResizeGesture(e, el, bodyClass, onMove, onEnd) {
  e.preventDefault();
  e.stopPropagation();
  deMenuClose(false);
  const g = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, raf: 0, ended: false };
  const paint = () => onMove(g.x - g.x0, g.y - g.y0, g.x, g.y);
  const mine = (ev) => ev.pointerId === g.pointerId;
  const onPMove = (ev) => {
    if (!mine(ev)) return;
    if (ev.buttons === 0) return void stop(false);
    g.x = ev.clientX;
    g.y = ev.clientY;
    if (!g.raf)
      g.raf = requestAnimationFrame(() => {
        g.raf = 0;
        if (!g.ended) paint();
      });
  };
  const onUp = (ev) => {
    if (!mine(ev)) return;
    g.x = ev.clientX;
    g.y = ev.clientY;
    stop(true, true);
  };
  const onCancel = (ev) => mine(ev) && stop(false);
  const onLost = (ev) => ev.target === el && onCancel(ev); // not a child's capture bubbling up
  const onBlur = () => stop(false);
  const onKey = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    stop(false);
    deAnnounce('Resize cancelled');
  };
  function stop(apply, released = false) {
    if (g.ended) return;
    g.ended = true;
    if (ddResize === g) ddResize = null;
    window.removeEventListener('pointermove', onPMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('keydown', onKey, true);
    el.removeEventListener('lostpointercapture', onLost);
    cancelAnimationFrame(g.raf);
    try {
      el.releasePointerCapture(g.pointerId);
    } catch {} // already released
    document.body.classList.remove('de-resize-active', bodyClass);
    ddSwallowClick(released);
    if (apply) paint(); // the release point counts
    onEnd(apply);
  }
  g.stop = stop;
  ddResize = g;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {} // the window listeners still end it
  document.body.classList.add('de-resize-active', bodyClass);
  window.addEventListener('pointermove', onPMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', onBlur);
  window.addEventListener('keydown', onKey, true);
  el.addEventListener('lostpointercapture', onLost);
  paint();
}

// ── widget resize grip: snaps through the widget's registered sizes ──
const ddSizes = (type) => {
  const s = dwDef(type)?.sizes;
  return (Array.isArray(s) && s.length ? s : LO_SCHEMA.sizes).filter((x) => LO_SCHEMA.sizes.includes(x));
};

function ddGripDown(e, frame) {
  if (!deState.active || e.button !== 0 || ddBusy()) return;
  const id = frame.dataset.widgetId;
  const w = loFind(deState.draft, id)?.node;
  if (!w) return;
  const sizes = ddSizes(w.type);
  const from = w.size;
  const i0 = Math.max(0, sizes.indexOf(from));
  const label = node('div', 'de-size-label');
  label.setAttribute('aria-hidden', 'true');
  document.body.append(label);
  frame.classList.add('de-resizing');
  let to = from;
  ddResizeGesture(
    e,
    e.currentTarget,
    'de-resize-widget',
    (dx, dy, x, y) => {
      const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      to = sizes[Math.max(0, Math.min(sizes.length - 1, i0 + Math.round(delta / DD_SIZE_STEP)))];
      label.textContent = `${from} → ${to}`;
      label.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 14)}px)`;
    },
    (apply) => {
      label.remove();
      frame.classList.remove('de-resizing');
      if (apply && to !== from) ddSetSize(id, to);
    },
  );
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
  if (!deState.active || e.button !== 0 || ddBusy()) return;
  const edge = e.currentTarget;
  const id = rowEl.dataset.rowId;
  const row = loFind(deState.draft, id)?.node;
  if (!row) return;
  const from = row.height;
  const css = getComputedStyle(rowEl); // once per gesture
  const unit = (parseFloat(css.getPropertyValue('--dw-row')) || DW_ROW_PX) + (parseFloat(css.rowGap) || 0);
  const label = node('span', 'de-row-resize-label');
  label.setAttribute('aria-hidden', 'true');
  edge.append(label);
  edge.classList.add('active');
  let to = from;
  ddResizeGesture(
    e,
    edge,
    'de-resize-row',
    (_dx, dy) => {
      to = Math.max(1, Math.min(DD_ROW_MAX, from + Math.round(dy / unit)));
      rowEl.style.setProperty('--h', String(to));
      label.textContent = to === from ? `Height ${from}` : `Height ${from} → ${to}`;
    },
    (apply) => {
      label.remove();
      edge.classList.remove('active');
      rowEl.style.setProperty('--h', String(from)); // the preview ends; deApply renders the result
      if (apply && to !== from) ddSetHeight(id, to);
    },
  );
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
