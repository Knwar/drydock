// ── Dashboard editor: the widget config drawer (globals prefix dec) ──
// Builds on dash-editor.js (deState, deApply, deOn, deSelect, deMenuItems, deNodeFor, deFind,
// deAnnounce) and layout-ops.js (loSetWidgetParams, loSetWidgetSize). Opens from a widget's
// "Configure…" menu item or a double-click on its frame; a non-modal drawer on Home's right edge
// (#dash-root narrows while it's open) that follows the selected widget.
// Sections: Data (the type's params schema), Display (title override, size), Filters (per-widget
// overrides of Home's filters in params.vars: phase, range / from / to, agent, tag, workType, compare;
// only the ones the type declares it uses, dashboard.js dwUsesFilter: by default all of them).
// Every change applies live via deApply; text / number edits are debounced and coalesce into one
// undo step. Invalid values show an inline error and are not applied.

const DEC_DEBOUNCE_MS = 300;
const DEC_TAGS = ['ui', 'api', 'db', 'infra'];
// dashboard.js resolves a range through MX_RANGES (rolling weeks) or 'custom' (from / to days)
const DEC_RANGES = [
  ['2w', 'Last 2 weeks'],
  ['4w', 'Last 4 weeks'],
  ['8w', 'Last 8 weeks'],
];
const DEC_COMPARE = [
  ['previous', 'Previous period'],
  ['none', 'None'],
];

const dec = { el: null, body: null, id: null, json: '', applying: false, customOpen: false, timers: new Map() };

const decIsObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const decWidget = (id = dec.id) => (deState.active && id ? deFind(deState.draft, 'widget', id) : null);
const decJsonOf = (w) => JSON.stringify(w ? { size: w.size, params: w.params } : null);
const decVars = (w) => (decIsObj(w?.params?.vars) ? w.params.vars : {});

function decDefaultTitle(w) {
  const def = dwDef(w.type);
  if (!def) return w.type;
  return (typeof def.title === 'function' ? def.title(w.params ?? {}) : def.title) || '';
}

// ── open / close ──
function decOpen(id) {
  if (!deState.active || !decWidget(id)) return;
  if (deState.selected?.kind !== 'widget' || deState.selected.id !== id) deSelect({ kind: 'widget', id });
  decBind(id);
  dec.el.querySelector('.dec-title')?.focus();
}

function decBind(id) {
  decFlush();
  decBuild();
  dec.id = id;
  dec.customOpen = false;
  dec.el.hidden = false;
  $('home-view')?.classList.add('dec-open');
  decRender();
  // the canvas just narrowed: keep the widget in sight
  requestAnimationFrame(() => deNodeFor('widget', id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  if (!hctx.meta && typeof homeMeta === 'function')
    homeMeta().then(
      () => dec.id === id && decRender(),
      () => {},
    );
}

// flush: apply pending typing first (Close); refocus: back on the widget's options handle
function decClose({ flush = true, refocus = true } = {}) {
  if (!dec.id) return;
  if (flush) decFlush();
  else decClearTimers();
  const id = dec.id;
  dec.id = null;
  dec.json = '';
  if (dec.el) {
    dec.el.hidden = true;
    dec.body.replaceChildren();
  }
  $('home-view')?.classList.remove('dec-open');
  if (refocus) deNodeFor('widget', id)?.querySelector(':scope > .de-handle')?.focus();
}

function decBuild() {
  if (dec.el) return;
  const el = node('aside', 'dec');
  el.id = 'dec-drawer';
  el.hidden = true;
  el.setAttribute('aria-labelledby', 'dec-title');
  const head = node('div', 'dec-head');
  const title = node('h2', 'dec-title', 'Widget settings');
  title.id = 'dec-title';
  title.tabIndex = -1;
  const close = node('button', 'dec-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close widget settings');
  close.title = 'Close';
  close.onclick = () => decClose();
  const sub = node('div', 'dec-sub');
  sub.id = 'dec-sub';
  const titles = node('div', 'dec-titles');
  titles.append(title, sub);
  head.append(titles, close);
  const body = node('div', 'dec-body');
  el.append(head, body);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault(); // the editor's own Esc (leave edit mode) stays out of it
    e.stopPropagation();
    decClose();
  });
  ($('home-view') ?? document.body).append(el);
  dec.el = el;
  dec.body = body;
}

// ── debounced edits ──
function decClearTimers() {
  for (const t of dec.timers.values()) clearTimeout(t.handle);
  dec.timers.clear();
}
function decFlush() {
  const pending = [...dec.timers.values()];
  decClearTimers();
  for (const t of pending) t.fn();
}
function decCancel(key) {
  clearTimeout(dec.timers.get(key)?.handle);
  dec.timers.delete(key);
}
function decDebounce(key, fn) {
  const old = dec.timers.get(key);
  if (old) clearTimeout(old.handle);
  const t = {
    fn,
    handle: setTimeout(() => {
      dec.timers.delete(key);
      fn();
    }, DEC_DEBOUNCE_MS),
  };
  dec.timers.set(key, t);
}

// ── applying ──
// One deApply; our own 'change' doesn't re-render the form (focus and caret stay put).
function decCommit(next, label, coalesce) {
  dec.applying = true;
  let ok = false;
  try {
    ok = deApply(next, label, coalesce ? { coalesce } : undefined);
  } finally {
    dec.applying = false;
  }
  if (dec.id) {
    const w = decWidget();
    dec.json = decJsonOf(w);
    decRefresh();
    // a param that decides whether the widget is ranged (a KPI's metric): show / hide its Range field
    if (w && !!dec.body?.querySelector('[data-dec-field="v-range"]') !== (dwRanged(w) && dwUsesFilter(w.type, 'range'))) decRender();
  }
  return ok;
}

// patch: loSetWidgetParams's (undefined deletes a key); field: the coalescing key (typing)
function decSetParams(wid, patch, label, field) {
  if (!decWidget(wid)) return false;
  let next;
  try {
    next = loSetWidgetParams(deState.draft, wid, patch);
  } catch (e) {
    deAnnounce(e.message);
    return false;
  }
  return decCommit(next, label, field ? `${wid}:${field}` : null);
}

// Filter overrides: Inherit ('' / undefined) removes the key; an empty vars removes vars.
function decSetVars(wid, patch, label) {
  const w = decWidget(wid);
  if (!w) return false;
  const vars = { ...decVars(w) };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') delete vars[k];
    else vars[k] = v;
  }
  return decSetParams(wid, { vars: Object.keys(vars).length ? vars : undefined }, label);
}

// The layout changed under the form (undo / redo, another module's edit): show it as it is now.
deOn('change', () => {
  if (!dec.id || dec.applying) return;
  const w = decWidget();
  if (!w) return void decClose({ flush: false, refocus: false });
  if (decJsonOf(w) === dec.json) return;
  decClearTimers();
  decRender();
});
deOn('select', (sel) => {
  if (dec.id && sel?.kind === 'widget' && sel.id !== dec.id) decBind(sel.id);
});
deOn('exit', () => decClose({ flush: false, refocus: false }));

// ── form pieces ──
function decField(key, label, control, help) {
  const wrap = node('div', 'dec-field');
  const id = `dec-f-${key}`;
  control.id = id;
  control.dataset.decField = key;
  const lab = node('label', 'dec-label', label);
  lab.htmlFor = id;
  const err = node('p', 'dec-error');
  err.id = `${id}-err`;
  err.setAttribute('aria-live', 'polite');
  const described = [err.id];
  wrap.append(lab, control);
  if (help) {
    const h = node('p', 'dec-help', help);
    h.id = `${id}-help`;
    described.unshift(h.id);
    wrap.append(h);
  }
  wrap.append(err);
  control.setAttribute('aria-describedby', described.join(' '));
  const setError = (msg) => {
    err.textContent = msg || '';
    wrap.classList.toggle('invalid', !!msg);
    if (msg) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  };
  return { wrap, control, setError, help: wrap.querySelector('.dec-help') };
}

// options: [[value, label]] or [{ group, options: [[value, label]] }]
function decSelectEl(options, value) {
  const sel = node('select', 'dec-input dec-select');
  const add = (host, [v, l]) => {
    const o = node('option', '', l);
    o.value = v;
    host.append(o);
  };
  for (const o of options) {
    if (Array.isArray(o)) add(sel, o);
    else {
      const g = document.createElement('optgroup');
      g.label = o.group;
      for (const x of o.options) add(g, x);
      sel.append(g);
    }
  }
  sel.value = value;
  return sel;
}

function decSection(title, ...children) {
  const sec = node('section', 'dec-section');
  const id = `dec-sec-${title.toLowerCase()}`;
  const h = node('h3', 'dec-sec-title', title);
  h.id = id;
  sec.setAttribute('aria-labelledby', id);
  sec.append(h, ...children);
  return sec;
}

// the title the widget shows: its override if set, otherwise the default
const decShownTitle = (w) => (typeof w.params?.title === 'string' && w.params.title) || decDefaultTitle(w) || w.type;

// ── render ──
function decRender() {
  const w = decWidget();
  if (!w || !dec.el) return;
  const focused = dec.el.contains(document.activeElement) ? document.activeElement.dataset.decField : null;
  dec.json = decJsonOf(w);
  const def = dwDef(w.type);
  const sub = dec.el.querySelector('#dec-sub');
  sub.textContent = decShownTitle(w);
  dec.body.replaceChildren(decDataSection(w, def), decDisplaySection(w, def), decFilterSection(w));
  if (focused) dec.body.querySelector(`[data-dec-field="${CSS.escape(focused)}"]`)?.focus();
}

// what our own edit can change elsewhere in the form: the default title, the header
function decRefresh() {
  const w = decWidget();
  if (!w || !dec.el) return;
  const t = decDefaultTitle(w);
  dec.el.querySelector('#dec-sub').textContent = decShownTitle(w);
  const title = dec.body.querySelector('[data-dec-field="title"]');
  if (title) title.placeholder = t || 'No title';
}

function decDataSection(w, def) {
  const schema = Array.isArray(def?.params) ? def.params.filter((p) => p && p.key && p.key !== 'title' && p.key !== 'vars') : [];
  if (!schema.length) return decSection('Data', node('p', 'dec-none', 'This widget has no data settings.'));
  return decSection('Data', ...schema.map((p) => decParamField(w, p)));
}

const decFmt = (v) => (typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v));

function decParamField(w, p) {
  const wid = w.id;
  const cur = w.params?.[p.key];
  const label = p.label || p.key;
  const optLabel = (v) => p.options?.find((o) => o.value === v)?.label ?? v;
  const help = p.default !== undefined ? `Default: ${p.type === 'select' ? optLabel(p.default) : decFmt(p.default)}` : '';
  const key = `p-${p.key}`;
  if (p.type === 'select') {
    const opts = (p.options ?? []).map((o) => [String(o.value), o.label ?? String(o.value)]);
    const value = String(cur ?? p.default ?? opts[0]?.[0] ?? '');
    if (value && !opts.some(([v]) => v === value)) opts.unshift([value, value]);
    const f = decField(key, label, decSelectEl(opts, value), help);
    f.control.onchange = () => {
      const o = p.options?.find((x) => String(x.value) === f.control.value);
      decSetParams(wid, { [p.key]: o ? o.value : f.control.value }, `${label}: ${o?.label ?? f.control.value}`);
    };
    return f.wrap;
  }
  if (p.type === 'toggle') {
    const box = node('input', 'dec-check');
    box.type = 'checkbox';
    box.checked = !!(cur ?? p.default);
    const f = decField(key, label, box, help);
    f.wrap.classList.add('dec-toggle');
    box.onchange = () => decSetParams(wid, { [p.key]: box.checked }, `${label} ${box.checked ? 'on' : 'off'}`);
    return f.wrap;
  }
  const input = node('input', 'dec-input');
  if (p.type === 'number') {
    input.type = 'number';
    input.inputMode = 'decimal';
    if (Number.isFinite(p.min)) input.min = String(p.min);
    if (Number.isFinite(p.max)) input.max = String(p.max);
    const range = Number.isFinite(p.min) && Number.isFinite(p.max) ? `${p.min}–${p.max}` : Number.isFinite(p.min) ? `at least ${p.min}` : Number.isFinite(p.max) ? `at most ${p.max}` : '';
    const f = decField(key, label, input, [help, range && `Range: ${range}`].filter(Boolean).join(' · '));
    input.value = cur ?? '';
    if (p.default !== undefined) input.placeholder = String(p.default);
    input.oninput = () => {
      const raw = input.value.trim();
      const n = Number(raw);
      let msg = '';
      if (raw === '' && input.validity.badInput) msg = 'Enter a number';
      else if (raw !== '' && !Number.isFinite(n)) msg = 'Enter a number';
      else if (raw !== '' && Number.isFinite(p.min) && n < p.min) msg = `Must be at least ${p.min}`;
      else if (raw !== '' && Number.isFinite(p.max) && n > p.max) msg = `Must be at most ${p.max}`;
      f.setError(msg);
      if (msg) return void decCancel(`${wid}:${key}`); // invalid: nothing pending applies
      decDebounce(`${wid}:${key}`, () => decSetParams(wid, { [p.key]: raw === '' ? undefined : n }, `${label} changed`, key));
    };
    return f.wrap;
  }
  // text (and any unknown type)
  input.type = 'text';
  input.value = cur ?? '';
  if (p.default !== undefined) input.placeholder = String(p.default);
  const f = decField(key, label, input, help);
  input.oninput = () => decDebounce(`${wid}:${key}`, () => decSetParams(wid, { [p.key]: input.value === '' ? undefined : input.value }, `${label} changed`, key));
  return f.wrap;
}

function decDisplaySection(w, def) {
  const wid = w.id;
  const input = node('input', 'dec-input');
  input.type = 'text';
  input.value = typeof w.params?.title === 'string' ? w.params.title : '';
  input.placeholder = decDefaultTitle(w) || 'No title';
  input.maxLength = 120;
  const title = decField('title', 'Title', input, 'Leave empty to use the default title.');
  input.dataset.decField = 'title';
  input.oninput = () =>
    decDebounce(`${wid}:title`, () => {
      const v = input.value.trim() ? input.value : undefined;
      decSetParams(wid, { title: v }, v ? 'Title changed' : 'Title reset to the default', 'title');
    });

  const sizes = (def?.sizes ?? LO_SCHEMA.sizes).filter((s) => LO_SCHEMA.sizes.includes(s));
  const wrap = node('div', 'dec-field');
  const lab = node('div', 'dec-label', 'Size');
  lab.id = 'dec-size-label';
  const group = node('div', 'dec-seg');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', 'dec-size-label');
  for (const s of sizes) {
    const b = node('button', 'dec-seg-btn', s);
    b.type = 'button';
    b.dataset.decField = `size-${s}`;
    b.setAttribute('aria-pressed', String(w.size === s));
    b.onclick = () => {
      if (!decWidget(wid)) return;
      let next;
      try {
        next = loSetWidgetSize(deState.draft, wid, s);
      } catch (e) {
        return void deAnnounce(e.message);
      }
      decCommit(next, `Size ${s}`);
      for (const x of group.children) x.setAttribute('aria-pressed', String(x === b));
    };
    group.append(b);
  }
  wrap.append(lab, group, node('p', 'dec-help', 'Sizes this widget supports.'));
  return decSection('Display', title.wrap, wrap);
}

// ── filters (params.vars) ──
function decHomePhase() {
  const id = hctx.f.phase;
  return id ? (fbPhaseById(hctx.meta, id)?.title ?? id) : 'All phases';
}
function decHomeRange() {
  const r = hctx.f.range;
  if (r === 'custom') return fbWindowLabel(hctx);
  if (r === 'all' || !r) return 'All time';
  return DEC_RANGES.find(([id]) => id === r)?.[1] ?? r;
}

function decInherit(f, inherits, now) {
  if (f.help) f.help.textContent = inherits ? `Inherits: ${now}` : 'Overrides the dashboard filter for this widget.';
}

function decFilterSection(w) {
  const wid = w.id;
  const v = decVars(w);
  const m = hctx.meta;
  const fields = [];
  const uses = (key) => dwUsesFilter(w.type, key);

  // phase: the board's phases (grouped by board on a workspace)
  const phaseOpts = [['', 'Inherit']];
  const groups = [];
  for (const [board, list] of m?.phases ?? []) {
    if (!list?.length) continue;
    groups.push({ group: m.boardById?.get(board)?.label ?? board, options: list.map((p) => [p.id, p.title]) });
  }
  if (groups.length === 1) phaseOpts.push(...groups[0].options);
  else phaseOpts.push(...groups);
  if (v.phase && !groups.some((g) => g.options.some(([id]) => id === v.phase))) phaseOpts.push([v.phase, v.phase]);
  if (uses('phase'))
    fields.push(
      decVarSelect(wid, 'phase', 'Phase', phaseOpts, v.phase ?? '', decHomePhase(), (val) => `Phase: ${val ? (fbPhaseById(m, val)?.title ?? val) : 'inherited'}`),
    );

  // a widget whose data doesn't follow the range (dashboard.js dwRanged) has no Range to override
  if (dwRanged(w) && uses('range')) fields.push(decRangeField(w));

  // agent: the team (+ agents seen on the board's cards)
  const agents = [...new Set([...(typeof teamByName !== 'undefined' ? teamByName.keys() : []), ...(m?.agents ?? [])])].sort((a, b) => a.localeCompare(b));
  if (v.agent && !agents.includes(v.agent)) agents.push(v.agent);
  if (uses('agent')) fields.push(decVarSelect(wid, 'agent', 'Agent', [['', 'Inherit'], ...agents.map((a) => [a, a])], v.agent ?? '', hctx.f.agent || 'All agents', (val) => `Agent: ${val || 'inherited'}`));

  const tags = [...DEC_TAGS];
  if (v.tag && !tags.includes(v.tag)) tags.push(v.tag);
  if (uses('tag')) fields.push(decVarSelect(wid, 'tag', 'Tag', [['', 'Inherit'], ...tags.map((t) => [t, t])], v.tag ?? '', hctx.f.tag || 'All tags', (val) => `Tag: ${val || 'inherited'}`));

  // work type: the 4 types, Unclassified ('none'); an unknown stored value stays selectable
  const types = WORK_TYPES.concat([['none', 'Unclassified']]);
  if (v.workType && !types.some(([id]) => id === v.workType)) types.push([v.workType, v.workType]);
  if (uses('workType')) fields.push(decVarSelect(wid, 'workType', 'Type', [['', 'Inherit'], ...types], v.workType ?? '', hctx.f.workType ? fbWorkTypeLabel(hctx.f.workType) : 'All types', (val) => `Type: ${val ? fbWorkTypeLabel(val) : 'inherited'}`));

  const cmp = v.compare && !DEC_COMPARE.some(([id]) => id === v.compare) ? [[v.compare, v.compare]] : [];
  if (uses('compare'))
    fields.push(
      decVarSelect(wid, 'compare', 'Comparison', [['', 'Inherit'], ...DEC_COMPARE, ...cmp], v.compare ?? '', 'None', (val) => `Comparison: ${DEC_COMPARE.find(([id]) => id === val)?.[1] ?? 'inherited'}`),
    );

  if (!fields.length) return decSection('Filters', node('p', 'dec-none', 'This widget doesn’t use the dashboard’s filters.'));
  const some = ['phase', 'range', 'agent', 'tag', 'workType', 'compare'].some((k) => !uses(k));
  const intro = `Override the dashboard’s filters for this widget only.${some ? ' Only the filters this widget uses are shown.' : ''}`;
  return decSection('Filters', node('p', 'dec-intro', intro), ...fields);
}

function decVarSelect(wid, key, label, options, value, now, said) {
  const f = decField(`v-${key}`, label, decSelectEl(options, value), ' ');
  decInherit(f, !value, now);
  f.control.onchange = () => {
    const val = f.control.value;
    if (decSetVars(wid, { [key]: val }, said(val))) decInherit(f, !val, now);
  };
  return f.wrap;
}

function decRangeField(w) {
  const wid = w.id;
  const v = decVars(w);
  const custom = v.range === 'custom' || !!v.from || !!v.to;
  const value = custom ? 'custom' : DEC_RANGES.some(([id]) => id === v.range) ? v.range : v.range ? v.range : '';
  const opts = [['', 'Inherit'], ...DEC_RANGES, ['custom', 'Custom…']];
  if (value && !opts.some(([id]) => id === value)) opts.splice(opts.length - 1, 0, [value, value]);
  const now = decHomeRange();
  const f = decField('v-range', 'Range', decSelectEl(opts, dec.customOpen && !custom ? 'custom' : value), ' ');
  decInherit(f, !value && !dec.customOpen, now);

  // custom from – to (local days); applied once the start is set and from ≤ to
  const box = node('div', 'dec-range');
  const day = (key, lab, val) => {
    const i = node('input', 'dec-input dec-date');
    i.type = 'date';
    i.id = `dec-f-v-${key}`;
    i.dataset.decField = `v-${key}`;
    i.value = val || '';
    const l = node('label', 'dec-sublabel', lab);
    l.htmlFor = i.id;
    const cell = node('div', 'dec-range-cell');
    cell.append(l, i);
    box.append(cell);
    return i;
  };
  const from = day('from', 'From', v.from);
  const to = day('to', 'To', v.to);
  const err = node('p', 'dec-error');
  err.id = 'dec-f-v-range-custom-err';
  err.setAttribute('aria-live', 'polite');
  const note = node('p', 'dec-help', 'Leave “To” empty for up to today.');
  note.id = 'dec-f-v-range-note';
  for (const i of [from, to]) i.setAttribute('aria-describedby', `${note.id} ${err.id}`);
  const custBox = node('div', 'dec-custom');
  custBox.append(box, note, err);
  custBox.hidden = !(custom || dec.customOpen);
  f.wrap.insertBefore(custBox, f.wrap.querySelector('.dec-error'));

  const setErr = (msg) => {
    err.textContent = msg;
    f.wrap.classList.toggle('invalid', !!msg);
    for (const i of [from, to]) {
      if (msg) i.setAttribute('aria-invalid', 'true');
      else i.removeAttribute('aria-invalid');
    }
  };
  const applyCustom = () => {
    const a = from.value;
    const b = to.value;
    if (!a) return void setErr(b ? 'Pick a start date' : '');
    if (b && a > b) return void setErr('“From” must be on or before “To”');
    setErr('');
    decSetVars(wid, { range: 'custom', from: a, to: b }, `Range: ${a} – ${b || 'today'}`);
  };
  from.onchange = applyCustom;
  to.onchange = applyCustom;

  f.control.onchange = () => {
    const val = f.control.value;
    setErr('');
    if (val === 'custom') {
      dec.customOpen = true;
      custBox.hidden = false;
      decInherit(f, false, now);
      if (from.value) applyCustom();
      else from.focus();
      return;
    }
    dec.customOpen = false;
    custBox.hidden = true;
    from.value = to.value = '';
    const label = val ? `Range: ${DEC_RANGES.find(([id]) => id === val)?.[1] ?? val}` : 'Range: inherited';
    if (decSetVars(wid, { range: val, from: '', to: '' }, label)) decInherit(f, !val, now);
  };
  return f.wrap;
}

// ── entry points ──
deMenuItems('widget', (id) => [{ label: 'Configure…', primary: true, onSelect: () => decOpen(id) }]);

// double-click a widget frame (not its handles, a tab strip or a row / section bar)
$('dash-root')?.addEventListener('dblclick', (e) => {
  if (!deState.active) return;
  const t = e.target;
  if (t.closest?.('.de-btn, .dw-tab, .de-row-bar, .dw-sec-head, .de-slot-empty')) return;
  const frame = t.closest?.('.dw-widget[data-widget-id]');
  if (!frame) return;
  e.preventDefault();
  window.getSelection?.()?.removeAllRanges();
  decOpen(frame.dataset.widgetId);
});
