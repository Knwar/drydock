// Dashboard layout operations: pure edits on a layout
// { version: 1, sections: [{ id, title, collapsed?, rows: [{ id, height, slots: [{ id, span, widgets }] }] }] }.
// A 'tabs' widget holds params.tabs = [{ id, title, rows }]; rows inside tabs are addressed
// exactly like section rows. Every op takes a layout and returns a NEW one (the input is never
// mutated) or throws a LoError with a readable message when it can't apply.
// Classic script (globals prefixed lo / Lo); the node tests load it with vm.runInThisContext.

// Keep in sync with WIDGET_TYPES / WIDGET_SIZES / KPI_METRICS / LAYOUT_CAPS in src/core/dashboard.ts.
const LO_SCHEMA = {
  types: [
    'now-building',
    'active-agents',
    'verticals',
    'up-next',
    'send-to-agent',
    'kpi',
    'tabs',
    'workspace-boards',
    'placeholder',
    'phase-health',
    'forecast',
    'milestones',
    'scope-change',
    'planned-delivered',
    'gate-readiness',
    'rag-trend',
    'cycle-breakdown',
    'wip',
    'review-queue',
    'throughput-trend',
    'escalation',
    'quality',
    'speed-stability',
    'top-risks',
    'ai-spend',
    'investment-mix',
    'budget-burn',
  ],
  sizes: ['S', 'M', 'L', 'XL'],
  metrics: ['schedule', 'budget', 'decisions', 'throughput'],
  caps: { sections: 20, rows: 50, widgets: 200 },
};

const LO_ROW_HEIGHT = 4; // default height of a new row

class LoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoError';
  }
}

const loIsObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const loIsIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const loArr = (v) => (Array.isArray(v) ? v : []);

// ── lookup ──

// Visits every node depth first: { kind, node, parent, path, list, index } (list[index] === node).
function loWalk(layout, visit) {
  const rows = (container, list, path) =>
    loArr(list).forEach((r, i) => {
      const rp = `${path}[${i}]`;
      visit({ kind: 'row', node: r, parent: container, path: rp, list, index: i });
      loArr(r?.slots).forEach((s, j) => {
        const sp = `${rp}.slots[${j}]`;
        visit({ kind: 'slot', node: s, parent: r, path: sp, list: r.slots, index: j });
        loArr(s?.widgets).forEach((w, k) => {
          const wp = `${sp}.widgets[${k}]`;
          visit({ kind: 'widget', node: w, parent: s, path: wp, list: s.widgets, index: k });
          if (w?.type !== 'tabs') return;
          loArr(w.params?.tabs).forEach((t, m) => {
            const tp = `${wp}.params.tabs[${m}]`;
            visit({ kind: 'tab', node: t, parent: w, path: tp, list: w.params.tabs, index: m });
            rows(t, t?.rows, `${tp}.rows`);
          });
        });
      });
    });
  loArr(layout?.sections).forEach((sec, i) => {
    visit({ kind: 'section', node: sec, parent: layout, path: `sections[${i}]`, list: layout.sections, index: i });
    rows(sec, sec?.rows, `sections[${i}].rows`);
  });
}

function loLocate(layout, id, ...kinds) {
  let found = null;
  loWalk(layout, (loc) => {
    if (!found && loc.node?.id === id) found = loc;
  });
  const want = kinds.join(' or ');
  if (!found) throw new LoError(`No ${want} with id "${id}"`);
  if (!kinds.includes(found.kind)) throw new LoError(`"${id}" is a ${found.kind}, not a ${want}`);
  return found;
}

/** The node with this id anywhere in the layout (tabs included), or null. */
function loFind(layout, id) {
  let found = null;
  loWalk(layout, (loc) => {
    if (!found && loc.node?.id === id) found = loc;
  });
  return found && { kind: found.kind, node: found.node, parent: found.parent, path: found.path };
}

function loUsedIds(layout) {
  const used = new Set();
  loWalk(layout, ({ node }) => {
    if (typeof node?.id === 'string') used.add(node.id);
  });
  return used;
}

function loFresh(used, prefix) {
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  const id = `${prefix}-${n}`;
  used.add(id);
  return id;
}

/** An id with this prefix not used anywhere in the layout (tabs included). */
function loId(layout, prefix) {
  return loFresh(loUsedIds(layout), prefix);
}

// ── shared helpers (operate on the private copy inside loEdit) ──

function loEdit(layout, fn) {
  const copy = structuredClone(layout);
  fn(copy);
  return copy;
}

function loInsert(list, item, index) {
  if (index === undefined) return void list.push(item);
  if (!Number.isInteger(index) || index < 0 || index > list.length)
    throw new LoError(`Position ${index} is out of range (0-${list.length})`);
  list.splice(index, 0, item);
}

const loInTab = (loc) => loc.path.includes('.params.tabs[');

const loRowHasTabs = (row) => loArr(row.slots).some((s) => loArr(s.widgets).some((w) => w.type === 'tabs'));

function loCheckTitle(title) {
  if (typeof title !== 'string') throw new LoError('Title must be text');
}

function loCheckSpans(spans) {
  if (!Array.isArray(spans) || spans.length === 0) throw new LoError('A row needs at least one column');
  for (const s of spans) if (!loIsIntIn(s, 1, 12)) throw new LoError(`Column width ${s} must be a whole number 1-12`);
  const sum = spans.reduce((a, b) => a + b, 0);
  if (sum > 12) throw new LoError(`Column widths add up to ${sum}; a row holds at most 12`);
}

function loCheckCaps(layout) {
  let rows = 0;
  let widgets = 0;
  loWalk(layout, ({ kind }) => {
    if (kind === 'row') rows++;
    if (kind === 'widget') widgets++;
  });
  const { caps } = LO_SCHEMA;
  if (layout.sections.length > caps.sections) throw new LoError(`A dashboard holds at most ${caps.sections} sections`);
  if (rows > caps.rows) throw new LoError(`A dashboard holds at most ${caps.rows} rows`);
  if (widgets > caps.widgets) throw new LoError(`A dashboard holds at most ${caps.widgets} widgets`);
}

const loNewSlot = (used, span) => ({ id: loFresh(used, 'slot'), span, widgets: [] });

const loNewRow = (used, spans) => ({
  id: loFresh(used, 'row'),
  height: LO_ROW_HEIGHT,
  slots: spans.map((span) => loNewSlot(used, span)),
});

// Gives a widget (and everything inside its tabs) fresh ids.
function loReId(w, used) {
  w.id = loFresh(used, 'w');
  if (w.type !== 'tabs') return;
  for (const t of loArr(w.params?.tabs)) {
    t.id = loFresh(used, 'tab');
    for (const r of loArr(t.rows)) {
      r.id = loFresh(used, 'row');
      for (const s of loArr(r.slots)) {
        s.id = loFresh(used, 'slot');
        for (const inner of loArr(s.widgets)) loReId(inner, used);
      }
    }
  }
}

// ── widgets ──

function loAddWidget(layout, slotId, widget, index) {
  if (!loIsObj(widget)) throw new LoError('A widget must be an object');
  return loEdit(layout, (c) => {
    const slot = loLocate(c, slotId, 'slot');
    const w = structuredClone(widget);
    if (!LO_SCHEMA.types.includes(w.type)) throw new LoError(`Unknown widget type "${w.type}"`);
    if (!LO_SCHEMA.sizes.includes(w.size)) throw new LoError(`Size must be ${LO_SCHEMA.sizes.join(', ')}`);
    if (w.type === 'tabs' && loInTab(slot)) throw new LoError('A tab group cannot go inside another tab group');
    if (w.params === undefined) w.params = {};
    const used = loUsedIds(c);
    if (w.id === undefined) w.id = loFresh(used, 'w');
    else if (used.has(w.id)) throw new LoError(`Id "${w.id}" is already used`);
    loInsert(slot.node.widgets, w, index);
    loCheckCaps(c);
  });
}

function loRemoveWidget(layout, widgetId) {
  return loEdit(layout, (c) => {
    const w = loLocate(c, widgetId, 'widget');
    w.list.splice(w.index, 1);
  });
}

function loDuplicateWidget(layout, widgetId) {
  return loEdit(layout, (c) => {
    const w = loLocate(c, widgetId, 'widget');
    const copy = structuredClone(w.node);
    loReId(copy, loUsedIds(c));
    w.list.splice(w.index + 1, 0, copy);
    loCheckCaps(c);
  });
}

/** index is the position in the target slot once the widget has left its old place. */
function loMoveWidget(layout, widgetId, toSlotId, index) {
  return loEdit(layout, (c) => {
    const w = loLocate(c, widgetId, 'widget');
    const to = loLocate(c, toSlotId, 'slot');
    if (w.node.type === 'tabs' && loInTab(to)) throw new LoError('A tab group cannot go inside another tab group');
    w.list.splice(w.index, 1);
    loInsert(to.node.widgets, w.node, index);
  });
}

function loSetWidgetSize(layout, widgetId, size) {
  if (!LO_SCHEMA.sizes.includes(size)) throw new LoError(`Size must be ${LO_SCHEMA.sizes.join(', ')}`);
  return loEdit(layout, (c) => {
    loLocate(c, widgetId, 'widget').node.size = size;
  });
}

/** Shallow merge; a key whose value is undefined is deleted. */
function loSetWidgetParams(layout, widgetId, patch) {
  if (!loIsObj(patch)) throw new LoError('Widget settings must be an object');
  return loEdit(layout, (c) => {
    const w = loLocate(c, widgetId, 'widget').node;
    const params = loIsObj(w.params) ? w.params : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete params[k];
      else params[k] = structuredClone(v);
    }
    w.params = params;
  });
}

// ── rows ──

function loAddRow(layout, containerId, index, spans) {
  loCheckSpans(spans);
  return loEdit(layout, (c) => {
    const box = loLocate(c, containerId, 'section', 'tab');
    if (!Array.isArray(box.node.rows)) box.node.rows = [];
    loInsert(box.node.rows, loNewRow(loUsedIds(c), spans), index);
    loCheckCaps(c);
  });
}

function loRemoveRow(layout, rowId) {
  return loEdit(layout, (c) => {
    const r = loLocate(c, rowId, 'row');
    r.list.splice(r.index, 1);
  });
}

/** index is the position in the target container once the row has left its old place. */
function loMoveRow(layout, rowId, containerId, index) {
  return loEdit(layout, (c) => {
    const r = loLocate(c, rowId, 'row');
    const box = loLocate(c, containerId, 'section', 'tab');
    if (box.kind === 'tab' && loRowHasTabs(r.node))
      throw new LoError('A row holding a tab group cannot go inside a tab group');
    r.list.splice(r.index, 1);
    if (!Array.isArray(box.node.rows)) box.node.rows = [];
    loInsert(box.node.rows, r.node, index);
  });
}

function loSetRowHeight(layout, rowId, height) {
  if (!loIsIntIn(height, 1, 12)) throw new LoError(`Row height ${height} must be a whole number 1-12`);
  return loEdit(layout, (c) => {
    loLocate(c, rowId, 'row').node.height = height;
  });
}

/** Same count resizes; more appends empty slots; fewer drops trailing slots only if they are empty. */
function loSetSpans(layout, rowId, spans) {
  loCheckSpans(spans);
  return loEdit(layout, (c) => {
    const row = loLocate(c, rowId, 'row').node;
    const dropped = row.slots.slice(spans.length);
    if (dropped.some((s) => loArr(s.widgets).length > 0))
      throw new LoError('Move or remove the widgets in the dropped columns first');
    const used = loUsedIds(c);
    row.slots = spans.map((span, i) => (row.slots[i] ? { ...row.slots[i], span } : loNewSlot(used, span)));
  });
}

// ── sections ──

function loAddSection(layout, index, title) {
  loCheckTitle(title);
  return loEdit(layout, (c) => {
    loInsert(c.sections, { id: loId(c, 'sec'), title, rows: [] }, index);
    loCheckCaps(c);
  });
}

function loRemoveSection(layout, id) {
  return loEdit(layout, (c) => {
    const s = loLocate(c, id, 'section');
    s.list.splice(s.index, 1);
  });
}

function loRenameSection(layout, id, title) {
  loCheckTitle(title);
  return loEdit(layout, (c) => {
    loLocate(c, id, 'section').node.title = title;
  });
}

function loMoveSection(layout, id, index) {
  return loEdit(layout, (c) => {
    const s = loLocate(c, id, 'section');
    s.list.splice(s.index, 1);
    loInsert(s.list, s.node, index);
  });
}

function loSetCollapsed(layout, id, collapsed) {
  if (typeof collapsed !== 'boolean') throw new LoError('Collapsed must be true or false');
  return loEdit(layout, (c) => {
    loLocate(c, id, 'section').node.collapsed = collapsed;
  });
}

// ── tabs ──

function loTabsWidget(c, tabsWidgetId) {
  const w = loLocate(c, tabsWidgetId, 'widget').node;
  if (w.type !== 'tabs') throw new LoError(`"${tabsWidgetId}" is not a tab group`);
  if (!loIsObj(w.params)) w.params = {};
  if (!Array.isArray(w.params.tabs)) w.params.tabs = [];
  return w;
}

/** The new tab gets one empty row with one full-width slot. */
function loAddTab(layout, tabsWidgetId, title, index) {
  loCheckTitle(title);
  return loEdit(layout, (c) => {
    const w = loTabsWidget(c, tabsWidgetId);
    const used = loUsedIds(c);
    loInsert(w.params.tabs, { id: loFresh(used, 'tab'), title, rows: [loNewRow(used, [12])] }, index);
    loCheckCaps(c);
  });
}

function loRemoveTab(layout, tabId) {
  return loEdit(layout, (c) => {
    const t = loLocate(c, tabId, 'tab');
    if (t.list.length === 1) throw new LoError('Cannot remove the last tab; remove the tab group instead');
    t.list.splice(t.index, 1);
  });
}

function loRenameTab(layout, tabId, title) {
  loCheckTitle(title);
  return loEdit(layout, (c) => {
    loLocate(c, tabId, 'tab').node.title = title;
  });
}

function loMoveTab(layout, tabsWidgetId, tabId, index) {
  return loEdit(layout, (c) => {
    const w = loTabsWidget(c, tabsWidgetId);
    const t = loLocate(c, tabId, 'tab');
    if (t.parent !== w) throw new LoError(`Tab "${tabId}" is not in tab group "${tabsWidgetId}"`);
    t.list.splice(t.index, 1);
    loInsert(t.list, t.node, index);
  });
}

// ── validation: a port of validateLayout (src/core/dashboard.ts); same rules, same paths ──

/** Every problem with a candidate layout as [{ path, message }] (empty = valid). */
function loValidate(input) {
  const errors = [];
  const err = (path, message) => void errors.push({ path, message });
  const seen = new Map(); // id → first path
  let rowCount = 0;
  let widgetCount = 0;
  const { types, sizes, metrics, caps } = LO_SCHEMA;

  const id = (o, path) => {
    if (typeof o.id !== 'string' || !o.id) return err(`${path}.id`, 'id (non-empty string) required');
    const first = seen.get(o.id);
    if (first !== undefined) err(`${path}.id`, `duplicate id "${o.id}" (also at ${first})`);
    else seen.set(o.id, path);
  };

  const rows = (list, path, inTab) => {
    if (!Array.isArray(list)) return err(path, 'rows must be an array');
    list.forEach((r, i) => row(r, `${path}[${i}]`, inTab));
  };

  const row = (r, path, inTab) => {
    if (!loIsObj(r)) return err(path, 'row must be an object');
    rowCount++;
    id(r, path);
    if (!loIsIntIn(r.height, 1, 12)) err(`${path}.height`, 'height must be an integer 1-12');
    if (!Array.isArray(r.slots)) return err(`${path}.slots`, 'slots must be an array');
    let spans = 0;
    r.slots.forEach((s, i) => {
      const sp = `${path}.slots[${i}]`;
      if (!loIsObj(s)) return err(sp, 'slot must be an object');
      id(s, sp);
      if (!loIsIntIn(s.span, 1, 12)) err(`${sp}.span`, 'span must be an integer 1-12');
      else spans += s.span;
      if (!Array.isArray(s.widgets)) return err(`${sp}.widgets`, 'widgets must be an array');
      s.widgets.forEach((w, j) => widget(w, `${sp}.widgets[${j}]`, inTab));
    });
    if (spans > 12) err(`${path}.slots`, `slot spans sum to ${spans} (max 12)`);
  };

  const widget = (w, path, inTab) => {
    if (!loIsObj(w)) return err(path, 'widget must be an object');
    widgetCount++;
    id(w, path);
    if (!types.includes(w.type)) err(`${path}.type`, `unknown widget type "${String(w.type)}"`);
    if (!sizes.includes(w.size)) err(`${path}.size`, 'size must be S, M, L or XL');
    if (!loIsObj(w.params)) return err(`${path}.params`, 'params must be an object');
    const p = w.params;
    if (w.type === 'kpi' && !metrics.includes(p.metric))
      err(`${path}.params.metric`, `kpi metric must be one of ${metrics.join(', ')}`);
    if (w.type === 'placeholder' && p.text !== undefined && typeof p.text !== 'string')
      err(`${path}.params.text`, 'text must be a string');
    if (w.type !== 'tabs') return;
    if (inTab) return err(`${path}.type`, 'tabs may not contain another tabs widget');
    if (!Array.isArray(p.tabs)) return err(`${path}.params.tabs`, 'tabs must be an array');
    p.tabs.forEach((t, i) => {
      const tp = `${path}.params.tabs[${i}]`;
      if (!loIsObj(t)) return err(tp, 'tab must be an object');
      id(t, tp);
      if (typeof t.title !== 'string') err(`${tp}.title`, 'title (string) required');
      rows(t.rows, `${tp}.rows`, true);
    });
  };

  if (!loIsObj(input)) return [{ path: '', message: 'layout must be an object' }];
  if (input.version !== 1) err('version', 'version must be 1');
  if (!Array.isArray(input.sections)) {
    err('sections', 'sections must be an array');
    return errors;
  }
  if (input.sections.length > caps.sections) err('sections', `at most ${caps.sections} sections`);
  input.sections.forEach((s, i) => {
    const path = `sections[${i}]`;
    if (!loIsObj(s)) return err(path, 'section must be an object');
    id(s, path);
    if (typeof s.title !== 'string') err(`${path}.title`, 'title (string) required');
    if (s.collapsed !== undefined && typeof s.collapsed !== 'boolean') err(`${path}.collapsed`, 'collapsed must be a boolean');
    rows(s.rows, `${path}.rows`, false);
  });
  if (rowCount > caps.rows) err('sections', `at most ${caps.rows} rows in total (has ${rowCount})`);
  if (widgetCount > caps.widgets) err('sections', `at most ${caps.widgets} widgets (has ${widgetCount})`);
  return errors;
}
