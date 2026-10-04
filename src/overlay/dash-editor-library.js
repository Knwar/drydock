// ── Dashboard editor: widget library + add / duplicate / remove (globals prefixed deLib) ──
// Builds on dash-editor.js's core API (deState, deApply, deMenuItems, deSelect, deNodeFor,
// deAnnounce) and layout-ops.js's lo* ops; the widget types come from dashboard.js's registry
// (dwTypes / dwDef). Uses app.js's node, openModal, svModal.
//
//   deLibraryOpen(target?)   the right-side "Add widget" sheet. target: a slot id to add into;
//                            otherwise the selected widget's / slot's slot; otherwise a new row
//                            (height 4, one 12-span slot) at the end of the first section.
//   Menus: 'widget' → Duplicate, Remove; 'slot' → Add widget here…

// One line + group + schematic icon per type; unknown types land in "Other" with a generic line.
const DE_LIB_TYPES = {
  kpi: { group: 'Delivery', name: 'KPI', desc: 'One headline metric: schedule, budget, decisions or throughput.' },
  'now-building': { group: 'Delivery', desc: 'Cards in progress right now, with their agents and progress.' },
  'up-next': { group: 'Delivery', desc: 'The next cards queued for dispatch.' },
  'workspace-boards': { group: 'Delivery', desc: 'Every board in the workspace with its lane counts.' },
  verticals: { group: 'Delivery', desc: 'Progress across this workspace’s verticals.' },
  'phase-health': { group: 'Delivery', desc: 'Every phase’s status, p85 against target, slip since baseline and progress.' },
  forecast: { group: 'Delivery', desc: 'The active phase’s p50 / p85 / p95 finish dates against its target.' },
  milestones: { group: 'Delivery', desc: 'Upcoming and past milestones, and which moved since their baseline.' },
  'scope-change': { group: 'Delivery', desc: 'The active phase’s card count now against its baseline, with scope and done over time.' },
  'planned-delivered': { group: 'Delivery', desc: 'How much of the phase’s baseline plan is done, and recently finished phases.' },
  'gate-readiness': { group: 'Delivery', desc: 'Go or hold: cards done, high risks, budget, blockers and decisions waiting.' },
  'rag-trend': { group: 'Delivery', name: 'RAG trend', desc: 'Each phase’s daily on track / at risk / off track status, flagging jumps to red.' },
  'cycle-breakdown': { group: 'Flow', desc: 'Median time per stage of cards done: queued, building, in review, and time blocked.' },
  wip: { group: 'Flow', name: 'WIP', desc: 'Cards building and in review now against the board’s WIP limits.' },
  'review-queue': { group: 'Flow', desc: 'Cards in review now, oldest first, with those past the stuck threshold flagged.' },
  'throughput-trend': { group: 'Flow', desc: 'Cards done per week, stacked by work type, with the weekly average.' },
  escalation: { group: 'Flow', desc: 'Blockers per card done, and the median time to resolve a blocker.' },
  quality: { group: 'Quality & risk', desc: 'First-pass review rate and average review rounds, with the weekly trend.' },
  'speed-stability': { group: 'Quality & risk', desc: 'Throughput against rework and defect share, period over period.' },
  'top-risks': { group: 'Quality & risk', desc: 'Open risks ranked by likelihood × impact, with the unmitigated high-risk count.' },
  'ai-spend': { group: 'Spend', name: 'AI spend', desc: 'Spend in the range and cost per card done.' },
  'investment-mix': { group: 'Spend', desc: 'Share of spend and of cards done by work type.' },
  'budget-burn': { group: 'Spend', desc: 'Actual against budget against projected spend, per phase.' },
  'autonomy-index': { group: 'Agentic (experimental)', desc: 'Share of done cards that needed no human: no blocker, decision or interrupt.' },
  'agent-stops': { group: 'Agentic (experimental)', desc: 'Agent self-stops against human interrupts, and their ratio.' },
  'batch-size': { group: 'Agentic (experimental)', desc: 'Share of done cards over a diff-size threshold, with the median change size.' },
  'spec-adherence': { group: 'Agentic (experimental)', desc: 'Share of done cards with every criterion checked and a first-pass review.' },
  'governance-posture': { group: 'Agentic (experimental)', desc: 'Agent actions tied to a card, done cards linked to a decision, and risky actions attempted.' },
  'rework-cost': { group: 'Agentic (experimental)', desc: 'Spend and share of spend on failed review rounds.' },
  'decision-latency-cost': { group: 'Agentic (experimental)', desc: 'Idle agent time spent waiting on you, in dollars and days of slip.' },
  'cost-anomaly': { group: 'Agentic (experimental)', desc: 'Days whose spend stands out from the usual, flagged on a daily sparkline.' },
  'usage-runway': { group: 'Agentic (experimental)', desc: 'When the 5-hour and weekly usage limits run out, against the phase forecast.' },
  'steering-pack': { group: 'Agentic (experimental)', desc: 'A one-page steering pre-read: RAG status, decisions, top risks and moved milestones.' },
  'agent-hourly-rate': { group: 'Agentic (experimental)', desc: 'Human-equivalent hours delivered per dollar, from card estimates.' },
  'perception-gap': { group: 'Agentic (experimental)', desc: 'Measured time against the human estimate: are cards faster or slower than expected.' },
  'active-agents': { group: 'People', desc: 'Who is working, reviewing or waiting on you.' },
  'send-to-agent': { group: 'Actions', desc: 'Send a prompt to an agent session from Home.' },
  tabs: { group: 'Layout', name: 'Tabs', desc: 'A tab group: each tab holds its own rows of widgets.' },
  placeholder: { group: 'Layout', name: 'Placeholder', desc: 'A note or a reserved spot for a widget to come.' },
};
const DE_LIB_GROUPS = ['Delivery', 'Flow', 'Quality & risk', 'Spend', 'Agentic (experimental)', 'People', 'Actions', 'Layout', 'Other'];
const DE_LIB_SIZE_NAMES = { S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large' };
const DE_LIB_SIZE_ORDER = ['S', 'M', 'L', 'XL'];

const deLibMeta = (type) => DE_LIB_TYPES[type] ?? { group: 'Other', desc: 'A dashboard widget.' };

// a type's name in the library (its registered title, or the map's name when it has none / a function)
function deLibName(type) {
  const def = dwDef(type);
  if (typeof def?.title === 'string' && def.title) return def.title;
  return deLibMeta(type).name ?? type;
}

// a widget's title as the dashboard shows it
function deLibTitle(w) {
  const def = dwDef(w.type);
  let t = w.params?.title;
  if (!t && def) {
    try {
      t = typeof def.title === 'function' ? def.title(w.params ?? {}) : def.title;
    } catch {
      t = '';
    }
  }
  return t || deLibName(w.type);
}

// the registered types in library order: grouped, the map's order inside each group
function deLibEntries() {
  const known = Object.keys(DE_LIB_TYPES);
  const types = [...dwTypes.keys()].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    return (ia < 0 ? known.length : ia) - (ib < 0 ? known.length : ib);
  });
  return types.map((type) => ({ type, def: dwDef(type), name: deLibName(type), ...deLibMeta(type) }));
}

// smallest registered size ≥ M, else the smallest one
function deLibDefaultSize(sizes) {
  const ordered = DE_LIB_SIZE_ORDER.filter((s) => sizes.includes(s));
  return ordered.find((s) => s !== 'S') ?? ordered[0] ?? 'M';
}

function deLibIcon(type) {
  const ic = node('span', `de-lib-ic de-lib-ic-${DE_LIB_TYPES[type] ? type : 'generic'}`);
  ic.setAttribute('aria-hidden', 'true');
  const parts = {
    kpi: 2, 'now-building': 3, 'up-next': 3, 'workspace-boards': 4, verticals: 3, 'active-agents': 3, 'send-to-agent': 2, tabs: 3, placeholder: 0,
    'phase-health': 3, forecast: 4, milestones: 3, 'scope-change': 2, 'planned-delivered': 4, 'gate-readiness': 3, 'rag-trend': 4,
    'cycle-breakdown': 3, wip: 3, 'review-queue': 3, 'throughput-trend': 5, escalation: 1,
    quality: 1, 'speed-stability': 4, 'top-risks': 3,
    'ai-spend': 3, 'investment-mix': 1, 'budget-burn': 4,
  };
  for (let i = 0; i < (parts[type] ?? 1); i++) ic.append(node('span'));
  return ic;
}

// ── placement ──
// → { slotId } | { sectionId } | { error }
function deLibPlacement(layout, target) {
  if (target != null && loFind(layout, target)?.kind === 'slot') return { slotId: target };
  const sel = deState.selected;
  if (sel?.kind === 'slot' && loFind(layout, sel.id)?.kind === 'slot') return { slotId: sel.id };
  if (sel?.kind === 'widget') {
    const hit = loFind(layout, sel.id);
    if (hit?.kind === 'widget') return { slotId: hit.parent.id };
  }
  const sec = layout.sections?.[0];
  if (!sec) return { error: 'This dashboard has no section to add a row to' };
  return { sectionId: sec.id };
}

function deLibPlacementText(layout, place) {
  if (place.error) return place.error;
  if (place.sectionId) {
    const title = layout.sections[0].title;
    return `Adds a new row at the end of ${title ? `“${title}”` : 'the first section'}.`;
  }
  return 'Adds to the selected slot.';
}

// a widget object with fresh ids against this layout
function deLibBuild(layout, type, size, params) {
  const w = { id: loId(layout, 'w'), type, size, params };
  if (type === 'tabs') {
    w.params = {
      ...params,
      tabs: [
        {
          id: loId(layout, 'tab'),
          title: 'Tab 1',
          rows: [{ id: loId(layout, 'row'), height: 4, slots: [{ id: loId(layout, 'slot'), span: 12, widgets: [] }] }],
        },
      ],
    };
  }
  return w;
}

// → { ok: true, id, title } | { ok: false, message }
function deLibAdd(target, type, size, params) {
  const draft = deState.draft;
  const place = deLibPlacement(draft, target);
  if (place.error) return { ok: false, message: place.error };
  let next;
  let w;
  try {
    let base = draft;
    let slotId = place.slotId;
    if (place.sectionId) {
      base = loAddRow(draft, place.sectionId, undefined, [12]);
      const rows = loFind(base, place.sectionId).node.rows;
      slotId = rows[rows.length - 1].slots[0].id;
    }
    w = deLibBuild(base, type, size, params);
    next = loAddWidget(base, slotId, w);
  } catch (e) {
    return { ok: false, message: e?.message || 'That widget can’t go there' };
  }
  const title = deLibTitle(w);
  if (!deApply(next, `Added ${title}`)) {
    return { ok: false, message: loValidate(next)?.[0]?.message || 'That change isn’t valid' };
  }
  return { ok: true, id: w.id, title };
}

// ── the sheet ──
let deLibSeq = 0;

function deLibraryOpen(target) {
  if (!deState.active || svModal) return;
  const uid = ++deLibSeq;
  const { backdrop, dlg, close, mount } = openModal({
    labelledBy: `de-lib-title-${uid}`,
    describedBy: `de-lib-sub-${uid}`,
    busy: () => false,
    fallbackFocus: () => $('home-edit'),
  });
  backdrop.classList.add('de-lib-backdrop');
  dlg.classList.add('de-lib-sheet');

  const head = node('div', 'de-lib-head');
  const titleWrap = node('div', 'de-lib-head-text');
  const title = node('h2', 'sv-title de-lib-title', 'Add widget');
  title.id = `de-lib-title-${uid}`;
  const sub = node('p', 'sv-sub de-lib-sub', deLibPlacementText(deState.draft, deLibPlacement(deState.draft, target)));
  sub.id = `de-lib-sub-${uid}`;
  titleWrap.append(title, sub);
  const x = node('button', 'de-lib-close', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.onclick = close;
  head.append(titleWrap, x);
  const body = node('div', 'de-lib-body');
  dlg.append(head, body);

  let query = '';
  let picked = null; // the type chosen in step 1

  function stepPick(focusType) {
    body.replaceChildren();
    const searchWrap = node('div', 'de-lib-search');
    const search = node('input', 'sv-input de-lib-search-input');
    search.type = 'search';
    search.placeholder = 'Search widgets';
    search.setAttribute('aria-label', 'Search widgets');
    search.value = query;
    searchWrap.append(search);
    const list = node('div', 'de-lib-groups');
    const status = node('p', 'de-sr');
    status.setAttribute('role', 'status');
    body.append(searchWrap, list, status);

    const paint = () => {
      list.replaceChildren();
      const q = query.trim().toLowerCase();
      const entries = deLibEntries().filter((e) => !q || e.name.toLowerCase().includes(q) || e.type.includes(q));
      for (const g of DE_LIB_GROUPS) {
        const items = entries.filter((e) => e.group === g);
        if (!items.length) continue;
        const sec = node('section', 'de-lib-group');
        const h = node('h3', 'de-lib-group-title', g);
        h.id = `de-lib-g-${uid}-${g}`;
        const ul = node('ul', 'de-lib-list');
        ul.setAttribute('aria-labelledby', h.id);
        for (const e of items) {
          const li = node('li');
          const b = node('button', 'de-lib-type');
          b.type = 'button';
          b.dataset.type = e.type;
          if (picked === e.type) b.setAttribute('aria-current', 'true');
          const text = node('span', 'de-lib-type-text');
          text.append(node('span', 'de-lib-type-name', e.name), node('span', 'de-lib-type-desc', e.desc));
          const sizes = node('span', 'de-lib-type-sizes', DE_LIB_SIZE_ORDER.filter((s) => e.def.sizes.includes(s)).join(' · '));
          sizes.setAttribute('aria-hidden', 'true');
          b.append(deLibIcon(e.type), text, sizes);
          b.onclick = () => stepConfigure(e.type);
          li.append(b);
          ul.append(li);
        }
        sec.append(h, ul);
        list.append(sec);
      }
      if (!entries.length) list.append(node('p', 'de-lib-empty', `No widgets match “${query.trim()}”`));
      status.textContent = q ? `${entries.length} widget${entries.length === 1 ? '' : 's'}` : '';
    };
    search.addEventListener('input', () => {
      query = search.value;
      paint();
    });
    paint();
    const again = focusType && list.querySelector(`.de-lib-type[data-type="${CSS.escape(focusType)}"]`);
    (again || search).focus();
  }

  function stepConfigure(type) {
    picked = type;
    const def = dwDef(type);
    const meta = deLibMeta(type);
    body.replaceChildren();

    const back = node('button', 'de-lib-back', '‹ All widgets');
    back.type = 'button';
    back.onclick = () => stepPick(type);

    const card = node('div', 'de-lib-picked');
    const text = node('div', 'de-lib-type-text');
    text.append(node('span', 'de-lib-type-name', deLibName(type)), node('span', 'de-lib-type-desc', meta.desc));
    card.append(deLibIcon(type), text);

    const form = node('form', 'de-lib-form');
    form.noValidate = true;

    // size: only the registered ones
    const sizes = DE_LIB_SIZE_ORDER.filter((s) => (def?.sizes ?? []).includes(s));
    const chosen = deLibDefaultSize(sizes);
    const fs = node('fieldset', 'de-lib-field de-lib-sizes');
    fs.append(node('legend', 'sv-label', 'Size'));
    const seg = node('div', 'de-lib-seg');
    for (const s of sizes) {
      const lab = node('label', 'de-lib-seg-opt');
      const r = node('input');
      r.type = 'radio';
      r.name = `de-lib-size-${uid}`;
      r.value = s;
      r.checked = s === chosen;
      lab.append(r, node('span', 'de-lib-seg-k', s), node('span', 'de-lib-seg-n', DE_LIB_SIZE_NAMES[s] ?? s));
      seg.append(lab);
    }
    fs.append(seg);
    form.append(fs);

    // params: the type's schema, with its defaults
    const fields = [];
    for (const p of Array.isArray(def?.params) ? def.params : []) {
      const id = `de-lib-p-${uid}-${p.key}`;
      const wrap = node('div', `de-lib-field${p.type === 'toggle' ? ' de-lib-toggle' : ''}`);
      let input;
      if (p.type === 'select') {
        input = node('select', 'sv-input');
        for (const o of p.options ?? []) {
          const opt = node('option', '', o.label ?? String(o.value));
          opt.value = o.value;
          input.append(opt);
        }
        if (p.default !== undefined) input.value = p.default;
      } else if (p.type === 'toggle') {
        input = node('input');
        input.type = 'checkbox';
        input.checked = !!p.default;
      } else {
        input = node('input', 'sv-input');
        input.type = p.type === 'number' ? 'number' : 'text';
        if (p.min !== undefined) input.min = p.min;
        if (p.max !== undefined) input.max = p.max;
        if (p.default !== undefined) input.value = p.default;
      }
      input.id = id;
      const lab = node('label', 'sv-label', p.label ?? p.key);
      lab.htmlFor = id;
      if (p.type === 'toggle') wrap.append(input, lab);
      else wrap.append(lab, input);
      fields.push({ p, input });
      form.append(wrap);
    }

    const err = node('p', 'sv-error de-lib-error');
    err.setAttribute('role', 'alert');
    const foot = node('div', 'sv-foot de-lib-foot');
    const cancel = node('button', 'home-btn', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = close;
    const add = node('button', 'home-btn primary', 'Add widget');
    add.type = 'submit';
    foot.append(node('span', 'sv-foot-note'), cancel, add);
    form.append(err, foot);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const size = form.querySelector(`input[name="de-lib-size-${uid}"]:checked`)?.value ?? chosen;
      const params = {};
      for (const { p, input } of fields) {
        if (p.type === 'toggle') params[p.key] = input.checked;
        else if (p.type === 'number') {
          if (input.value !== '') params[p.key] = Number(input.value);
        } else if (input.value !== '') params[p.key] = input.value;
      }
      const res = deLibAdd(target, type, size, params);
      if (!res.ok) {
        err.textContent = res.message;
        return;
      }
      close();
      deSelect({ kind: 'widget', id: res.id });
      const el = deNodeFor('widget', res.id);
      el?.querySelector(':scope > .de-handle')?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });

    body.append(back, card, form);
    (form.querySelector('input:checked') || form.querySelector('input, select') || add).focus();
  }

  mount();
  stepPick();
}

// ── menus ──
// the copy goes into an empty slot of the original's row (the nearest one after it, else before);
// failing that, into a new row right below (same height): one slot of the original's span, the
// rest of the width one empty slot. loDuplicateWidget puts it beside the original, loMoveWidget
// takes it there; the caller applies it all as one edit.
function deLibDuplicate(L, widgetId) {
  const w = loFind(L, widgetId);
  if (w?.kind !== 'widget') throw new LoError(`No widget with id "${widgetId}"`);
  const slot = w.parent;
  const row = loFind(L, slot.id).parent;
  const box = loFind(L, row.id).parent;
  const col = row.slots.indexOf(slot);
  let out = loDuplicateWidget(L, widgetId);
  const dup = loFind(out, slot.id).node.widgets[slot.widgets.indexOf(w.node) + 1];
  const empty = (s) => !s.widgets?.length;
  const spot = row.slots.slice(col + 1).find(empty) ?? row.slots.slice(0, col).reverse().find(empty);
  if (spot) return loMoveWidget(out, dup.id, spot.id);
  const ri = box.rows.indexOf(row);
  const rest = 12 - slot.span;
  out = loAddRow(out, box.id, ri + 1, rest > 0 ? [slot.span, rest] : [slot.span]);
  const copyRow = loFind(out, box.id).node.rows[ri + 1];
  out = loSetRowHeight(out, copyRow.id, row.height);
  return loMoveWidget(out, dup.id, copyRow.slots[0].id);
}

const deLibUndoKey = () => (/mac/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? '⌘Z' : 'Ctrl+Z');

function deLibTry(op, label) {
  try {
    return deApply(op(), label);
  } catch (e) {
    deAnnounce(e?.message || 'That change isn’t possible');
    return false;
  }
}

deMenuItems('widget', (id, info) => {
  if (!info.item) return [];
  const title = deLibTitle(info.item);
  return [
    { label: 'Duplicate', group: 'arrange', onSelect: () => deLibTry(() => deLibDuplicate(deState.draft, id), `Duplicated ${title}`) },
    { label: 'Remove', danger: true, onSelect: () => deLibTry(() => loRemoveWidget(deState.draft, id), `Removed ${title}. Press ${deLibUndoKey()} to undo`) },
  ];
});

deMenuItems('slot', (id) => [{ label: 'Add widget here…', onSelect: () => deLibraryOpen(id) }]);
