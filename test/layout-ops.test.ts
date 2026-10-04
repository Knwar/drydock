import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { builtinTemplates, validateLayout, WIDGET_SIZES, WIDGET_TYPES } from '../src/core/dashboard.js';

// src/overlay/layout-ops.js is a classic browser script; run it in this realm and pick up its globals.

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'overlay', 'layout-ops.js');
vm.runInThisContext(readFileSync(FILE, 'utf8'), { filename: FILE });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any;
const lo = vm.runInThisContext(`({
  LoError, loId, loFind, loValidate,
  loAddWidget, loRemoveWidget, loDuplicateWidget, loMoveWidget, loSetWidgetSize, loSetWidgetParams,
  loAddRow, loRemoveRow, loMoveRow, loSetRowHeight, loSetSpans,
  loAddSection, loRemoveSection, loRenameSection, loMoveSection, loSetCollapsed,
  loAddTab, loRemoveTab, loRenameTab, loMoveTab,
})`) as Record<string, Fn> & { LoError: new (m: string) => Error };

type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const w = (id: string, type = 'placeholder', params: J = {}) => ({ id, type, size: 'M', params });

/**
 * sec1: row1 [slot1(6): wA, wB | slot2(6): wT(tabs)]
 *        wT tabs: tab1 → rowT1 [slotT1(12): wC]; tab2 → rowT2 [slotT2(6): empty]
 *       row2 [slot3(12): empty]
 * sec2: row3 [slot4(4): wD]
 */
function fixture() {
  return deepFreeze({
    version: 1,
    sections: [
      {
        id: 'sec1',
        title: 'One',
        rows: [
          {
            id: 'row1',
            height: 4,
            slots: [
              { id: 'slot1', span: 6, widgets: [w('wA'), w('wB', 'kpi', { metric: 'budget' })] },
              {
                id: 'slot2',
                span: 6,
                widgets: [
                  {
                    id: 'wT',
                    type: 'tabs',
                    size: 'L',
                    params: {
                      tabs: [
                        { id: 'tab1', title: 'T1', rows: [{ id: 'rowT1', height: 3, slots: [{ id: 'slotT1', span: 12, widgets: [w('wC')] }] }] },
                        { id: 'tab2', title: 'T2', rows: [{ id: 'rowT2', height: 3, slots: [{ id: 'slotT2', span: 6, widgets: [] }] }] },
                      ],
                    },
                  },
                ],
              },
            ],
          },
          { id: 'row2', height: 2, slots: [{ id: 'slot3', span: 12, widgets: [] }] },
        ],
      },
      { id: 'sec2', title: 'Two', rows: [{ id: 'row3', height: 4, slots: [{ id: 'slot4', span: 4, widgets: [w('wD')] }] }] },
    ],
  });
}

const node = (l: J, id: string) => lo.loFind(l, id)?.node;
const ids = (list: J[]) => list.map((x) => x.id);
const valid = (l: J) => assert.deepEqual(lo.loValidate(l), []);
const throwsLo = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof lo.LoError && (e as Error).name === 'LoError' && re.test((e as Error).message));

describe('layout-ops: loading', () => {
  it('defines lo* globals from a classic script', () => {
    for (const [k, v] of Object.entries(lo)) assert.equal(typeof v, 'function', k);
    assert.ok(new lo.LoError('x') instanceof Error);
  });
});

describe('layout-ops: lookup', () => {
  it('loFind finds every kind anywhere, including inside tabs', () => {
    const l = fixture();
    assert.equal(lo.loFind(l, 'sec2').kind, 'section');
    assert.equal(lo.loFind(l, 'sec2').parent, l);
    const r = lo.loFind(l, 'rowT1');
    assert.equal(r.kind, 'row');
    assert.equal(r.parent.id, 'tab1');
    assert.equal(r.path, 'sections[0].rows[0].slots[1].widgets[0].params.tabs[0].rows[0]');
    assert.equal(lo.loFind(l, 'slotT2').kind, 'slot');
    assert.equal(lo.loFind(l, 'wC').kind, 'widget');
    assert.equal(lo.loFind(l, 'wC').parent.id, 'slotT1');
    const t = lo.loFind(l, 'tab2');
    assert.equal(t.kind, 'tab');
    assert.equal(t.parent.id, 'wT');
    assert.equal(lo.loFind(l, 'nope'), null);
  });

  it('loId is unique across the layout including tabs', () => {
    const l = deepFreeze({ version: 1, sections: [{ id: 'x-1', title: '', rows: [{ id: 'r', height: 1, slots: [{ id: 's', span: 1, widgets: [{ id: 't', type: 'tabs', size: 'L', params: { tabs: [{ id: 'x-2', title: '', rows: [] }] } }] }] }] }] });
    assert.equal(lo.loId(l, 'x'), 'x-3');
    assert.equal(lo.loId(l, 'y'), 'y-1');
  });
});

describe('layout-ops: widgets', () => {
  it('loAddWidget appends or inserts, anywhere incl. tab slots, with a fresh id when missing', () => {
    const l = fixture();
    const a = lo.loAddWidget(l, 'slot1', { type: 'up-next', size: 'S', params: {} }, 0);
    assert.equal(node(a, 'slot1').widgets[0].type, 'up-next');
    assert.ok(node(a, 'slot1').widgets[0].id);
    const b = lo.loAddWidget(l, 'slotT2', w('wNew'));
    assert.deepEqual(ids(node(b, 'slotT2').widgets), ['wNew']);
    valid(b);
  });

  it('loAddWidget refuses bad input', () => {
    const l = fixture();
    throwsLo(() => lo.loAddWidget(l, 'nope', w('z')), /No slot with id "nope"/);
    throwsLo(() => lo.loAddWidget(l, 'row1', w('z')), /"row1" is a row, not a slot/);
    throwsLo(() => lo.loAddWidget(l, 'slot1', w('wA')), /already used/);
    throwsLo(() => lo.loAddWidget(l, 'slot1', w('z', 'bogus')), /Unknown widget type/);
    throwsLo(() => lo.loAddWidget(l, 'slot1', { ...w('z'), size: 'XXL' }), /Size must be/);
    throwsLo(() => lo.loAddWidget(l, 'slot1', w('z'), 9), /out of range/);
    throwsLo(() => lo.loAddWidget(l, 'slotT1', w('z', 'tabs', { tabs: [] })), /cannot go inside another tab group/);
  });

  it('loRemoveWidget removes anywhere incl. tabs', () => {
    const l = fixture();
    assert.deepEqual(ids(node(lo.loRemoveWidget(l, 'wA'), 'slot1').widgets), ['wB']);
    assert.deepEqual(node(lo.loRemoveWidget(l, 'wC'), 'slotT1').widgets, []);
    throwsLo(() => lo.loRemoveWidget(l, 'slot1'), /not a widget/);
  });

  it('loDuplicateWidget copies after the original with fresh ids, incl. nested tab content', () => {
    const l = fixture();
    const a = lo.loDuplicateWidget(l, 'wA');
    const ws = node(a, 'slot1').widgets;
    assert.equal(ws.length, 3);
    assert.equal(ws[0].id, 'wA');
    assert.notEqual(ws[1].id, 'wA');
    assert.equal(ws[2].id, 'wB');
    valid(a);
    const b = lo.loDuplicateWidget(l, 'wT');
    const [orig, copy] = node(b, 'slot2').widgets;
    assert.equal(orig.id, 'wT');
    assert.equal(copy.type, 'tabs');
    assert.equal(copy.params.tabs.length, 2);
    assert.notEqual(copy.params.tabs[0].id, 'tab1');
    assert.notEqual(copy.params.tabs[0].rows[0].id, 'rowT1');
    assert.notEqual(copy.params.tabs[0].rows[0].slots[0].id, 'slotT1');
    assert.notEqual(copy.params.tabs[0].rows[0].slots[0].widgets[0].id, 'wC');
    valid(b);
    const c = lo.loDuplicateWidget(l, 'wC'); // inside a tab
    assert.equal(node(c, 'slotT1').widgets.length, 2);
    valid(c);
    throwsLo(() => lo.loDuplicateWidget(l, 'nope'), /No widget/);
  });

  it('loMoveWidget moves within a slot, across slots and into / out of tabs', () => {
    const l = fixture();
    assert.deepEqual(ids(node(lo.loMoveWidget(l, 'wA', 'slot1', 1), 'slot1').widgets), ['wB', 'wA']);
    const into = lo.loMoveWidget(l, 'wA', 'slotT2', 0);
    assert.deepEqual(ids(node(into, 'slotT2').widgets), ['wA']);
    assert.deepEqual(ids(node(into, 'slot1').widgets), ['wB']);
    const out = lo.loMoveWidget(l, 'wC', 'slot4', 0);
    assert.deepEqual(ids(node(out, 'slot4').widgets), ['wC', 'wD']);
    assert.deepEqual(node(out, 'slotT1').widgets, []);
    const end = lo.loMoveWidget(l, 'wD', 'slot3');
    assert.deepEqual(ids(node(end, 'slot3').widgets), ['wD']);
    // a tab group can move between section slots but not into a tab
    assert.deepEqual(ids(node(lo.loMoveWidget(l, 'wT', 'slot3', 0), 'slot3').widgets), ['wT']);
    throwsLo(() => lo.loMoveWidget(l, 'wT', 'slotT1', 0), /cannot go inside another tab group/);
    throwsLo(() => lo.loMoveWidget(l, 'wA', 'slot3', 5), /out of range/);
    throwsLo(() => lo.loMoveWidget(l, 'wA', 'nope', 0), /No slot/);
  });

  it('loSetWidgetSize sets a valid size', () => {
    const l = fixture();
    assert.equal(node(lo.loSetWidgetSize(l, 'wC', 'XL'), 'wC').size, 'XL');
    throwsLo(() => lo.loSetWidgetSize(l, 'wC', 'huge'), /Size must be/);
    throwsLo(() => lo.loSetWidgetSize(l, 'tab1', 'S'), /not a widget/);
  });

  it('loSetWidgetParams shallow-merges and deletes undefined keys', () => {
    const l = fixture();
    const a = lo.loSetWidgetParams(l, 'wB', { metric: 'schedule', extra: 1 });
    assert.deepEqual(node(a, 'wB').params, { metric: 'schedule', extra: 1 });
    const b = lo.loSetWidgetParams(a, 'wB', { extra: undefined });
    assert.deepEqual(node(b, 'wB').params, { metric: 'schedule' });
    assert.ok(!('extra' in node(b, 'wB').params));
    assert.deepEqual(node(lo.loSetWidgetParams(l, 'wC', { text: 'hi' }), 'wC').params, { text: 'hi' });
    throwsLo(() => lo.loSetWidgetParams(l, 'wB', null), /must be an object/);
  });
});

describe('layout-ops: rows', () => {
  it('loAddRow adds to a section or a tab with fresh slots and default height 4', () => {
    const l = fixture();
    const a = lo.loAddRow(l, 'sec2', 0, [4, 8]);
    const r = node(a, 'sec2').rows[0];
    assert.equal(r.height, 4);
    assert.deepEqual(r.slots.map((s: J) => s.span), [4, 8]);
    assert.ok(r.slots.every((s: J) => s.widgets.length === 0 && s.id));
    valid(a);
    const b = lo.loAddRow(l, 'tab2', 1, [12]);
    assert.equal(node(b, 'tab2').rows.length, 2);
    valid(b);
  });

  it('loAddRow refuses bad spans and containers', () => {
    const l = fixture();
    throwsLo(() => lo.loAddRow(l, 'sec1', 0, [6, 7]), /add up to 13/);
    throwsLo(() => lo.loAddRow(l, 'sec1', 0, [0]), /whole number 1-12/);
    throwsLo(() => lo.loAddRow(l, 'sec1', 0, []), /at least one column/);
    throwsLo(() => lo.loAddRow(l, 'row1', 0, [12]), /not a section or tab/);
    throwsLo(() => lo.loAddRow(l, 'sec1', 7, [12]), /out of range/);
  });

  it('loRemoveRow removes anywhere incl. tabs', () => {
    const l = fixture();
    assert.deepEqual(ids(node(lo.loRemoveRow(l, 'row1'), 'sec1').rows), ['row2']);
    assert.deepEqual(node(lo.loRemoveRow(l, 'rowT1'), 'tab1').rows, []);
    throwsLo(() => lo.loRemoveRow(l, 'slot1'), /not a row/);
  });

  it('loMoveRow moves within and across sections and into / out of tabs', () => {
    const l = fixture();
    assert.deepEqual(ids(node(lo.loMoveRow(l, 'row2', 'sec1', 0), 'sec1').rows), ['row2', 'row1']);
    const across = lo.loMoveRow(l, 'row3', 'sec1', 1);
    assert.deepEqual(ids(node(across, 'sec1').rows), ['row1', 'row3', 'row2']);
    assert.deepEqual(node(across, 'sec2').rows, []);
    const into = lo.loMoveRow(l, 'row2', 'tab2', 0);
    assert.deepEqual(ids(node(into, 'tab2').rows), ['row2', 'rowT2']);
    valid(into);
    const out = lo.loMoveRow(l, 'rowT1', 'sec2');
    assert.deepEqual(ids(node(out, 'sec2').rows), ['row3', 'rowT1']);
    throwsLo(() => lo.loMoveRow(l, 'row1', 'tab1', 0), /cannot go inside a tab group/);
    throwsLo(() => lo.loMoveRow(l, 'row2', 'wA', 0), /not a section or tab/);
  });

  it('loSetRowHeight accepts 1-12', () => {
    const l = fixture();
    assert.equal(node(lo.loSetRowHeight(l, 'rowT2', 12), 'rowT2').height, 12);
    throwsLo(() => lo.loSetRowHeight(l, 'row1', 13), /1-12/);
    throwsLo(() => lo.loSetRowHeight(l, 'row1', 1.5), /1-12/);
  });

  it('loSetSpans resizes, appends empty slots, and only drops empty slots', () => {
    const l = fixture();
    const same = lo.loSetSpans(l, 'row1', [4, 8]);
    assert.deepEqual(node(same, 'row1').slots.map((s: J) => [s.id, s.span, s.widgets.length]), [
      ['slot1', 4, 2],
      ['slot2', 8, 1],
    ]);
    const more = lo.loSetSpans(l, 'rowT2', [6, 3, 3]);
    const slots = node(more, 'rowT2').slots;
    assert.equal(slots.length, 3);
    assert.equal(slots[0].id, 'slotT2');
    assert.ok(slots[1].id && slots[2].id && slots[1].id !== slots[2].id);
    valid(more);
    const two = lo.loSetSpans(l, 'row3', [4, 4]);
    const fewer = lo.loSetSpans(two, 'row3', [12]);
    assert.deepEqual(node(fewer, 'row3').slots.map((s: J) => [s.id, s.span]), [['slot4', 12]]);
    throwsLo(() => lo.loSetSpans(l, 'row1', [12]), /widgets in the dropped columns/);
    throwsLo(() => lo.loSetSpans(l, 'row1', [6, 6, 1]), /add up to 13/);
    throwsLo(() => lo.loSetSpans(l, 'row1', [13]), /1-12/);
  });
});

describe('layout-ops: sections', () => {
  it('loAddSection / loRemoveSection / loRenameSection / loMoveSection / loSetCollapsed', () => {
    const l = fixture();
    const a = lo.loAddSection(l, 1, 'Mid');
    assert.deepEqual(a.sections.map((s: J) => s.title), ['One', 'Mid', 'Two']);
    assert.deepEqual(a.sections[1].rows, []);
    valid(a);
    assert.deepEqual(ids(lo.loRemoveSection(l, 'sec1').sections), ['sec2']);
    assert.equal(node(lo.loRenameSection(l, 'sec2', 'Renamed'), 'sec2').title, 'Renamed');
    assert.deepEqual(ids(lo.loMoveSection(l, 'sec1', 1).sections), ['sec2', 'sec1']);
    assert.equal(node(lo.loSetCollapsed(l, 'sec1', true), 'sec1').collapsed, true);
    valid(lo.loSetCollapsed(l, 'sec1', true));
    throwsLo(() => lo.loAddSection(l, 0, 5), /Title must be text/);
    throwsLo(() => lo.loAddSection(l, 3, 'x'), /out of range/);
    throwsLo(() => lo.loRemoveSection(l, 'row1'), /not a section/);
    throwsLo(() => lo.loRenameSection(l, 'nope', 'x'), /No section/);
    throwsLo(() => lo.loMoveSection(l, 'sec1', 2), /out of range/);
    throwsLo(() => lo.loSetCollapsed(l, 'sec1', 'yes'), /true or false/);
  });

  it('refuses to exceed the section cap', () => {
    let l = deepFreeze({ version: 1, sections: [] });
    for (let i = 0; i < 20; i++) l = lo.loAddSection(l, 0, `s${i}`);
    throwsLo(() => lo.loAddSection(l, 0, 'one too many'), /at most 20 sections/);
  });
});

describe('layout-ops: tabs', () => {
  it('loAddTab adds a tab with one empty full-width row', () => {
    const l = fixture();
    const a = lo.loAddTab(l, 'wT', 'New', 0);
    const t = node(a, 'wT').params.tabs[0];
    assert.equal(t.title, 'New');
    assert.equal(t.rows.length, 1);
    assert.deepEqual(t.rows[0].slots.map((s: J) => [s.span, s.widgets.length]), [[12, 0]]);
    valid(a);
    assert.equal(node(lo.loAddTab(l, 'wT', 'End'), 'wT').params.tabs[2].title, 'End');
    throwsLo(() => lo.loAddTab(l, 'wA', 'x'), /not a tab group/);
    throwsLo(() => lo.loAddTab(l, 'wT', 'x', 5), /out of range/);
  });

  it('loRemoveTab removes, but not the last tab', () => {
    const l = fixture();
    const a = lo.loRemoveTab(l, 'tab1');
    assert.deepEqual(ids(node(a, 'wT').params.tabs), ['tab2']);
    throwsLo(() => lo.loRemoveTab(a, 'tab2'), /Cannot remove the last tab/);
    throwsLo(() => lo.loRemoveTab(l, 'wT'), /not a tab/);
  });

  it('loRenameTab and loMoveTab', () => {
    const l = fixture();
    assert.equal(node(lo.loRenameTab(l, 'tab2', 'Two!'), 'tab2').title, 'Two!');
    assert.deepEqual(ids(node(lo.loMoveTab(l, 'wT', 'tab2', 0), 'wT').params.tabs), ['tab2', 'tab1']);
    const dup = lo.loDuplicateWidget(l, 'wT');
    const other = node(dup, 'slot2').widgets[1].id;
    throwsLo(() => lo.loMoveTab(dup, other, 'tab1', 0), /is not in tab group/);
    throwsLo(() => lo.loMoveTab(l, 'wT', 'tab1', 2), /out of range/);
    throwsLo(() => lo.loRenameTab(l, 'tab1', null), /Title must be text/);
  });
});

describe('layout-ops: purity', () => {
  it('no op mutates its (deep-frozen) input, and every op returns a new object', () => {
    const l = fixture();
    const before = JSON.stringify(l);
    const results = [
      lo.loAddWidget(l, 'slotT1', w('n1')),
      lo.loRemoveWidget(l, 'wC'),
      lo.loDuplicateWidget(l, 'wT'),
      lo.loMoveWidget(l, 'wC', 'slot1', 0),
      lo.loSetWidgetSize(l, 'wA', 'S'),
      lo.loSetWidgetParams(l, 'wA', { text: 'x' }),
      lo.loAddRow(l, 'tab1', 0, [6, 6]),
      lo.loRemoveRow(l, 'rowT2'),
      lo.loMoveRow(l, 'rowT1', 'sec2', 0),
      lo.loSetRowHeight(l, 'row1', 6),
      lo.loSetSpans(l, 'row2', [6, 6]),
      lo.loAddSection(l, 0, 'x'),
      lo.loRemoveSection(l, 'sec2'),
      lo.loRenameSection(l, 'sec1', 'x'),
      lo.loMoveSection(l, 'sec2', 0),
      lo.loSetCollapsed(l, 'sec2', true),
      lo.loAddTab(l, 'wT', 'x'),
      lo.loRemoveTab(l, 'tab1'),
      lo.loRenameTab(l, 'tab1', 'x'),
      lo.loMoveTab(l, 'wT', 'tab2', 0),
    ];
    for (const r of results) {
      assert.notEqual(r, l);
      assert.ok(!Object.isFrozen(r));
      valid(r);
    }
    assert.equal(JSON.stringify(l), before);
  });
});

// ── parity with the server's validateLayout ──

function bigLayout(sections: number, rowsPer: number, widgetsPer: number) {
  let n = 0;
  return {
    version: 1,
    sections: Array.from({ length: sections }, () => ({
      id: `s${++n}`,
      title: 's',
      rows: Array.from({ length: rowsPer }, () => ({
        id: `r${++n}`,
        height: 1,
        slots: [{ id: `sl${++n}`, span: 12, widgets: Array.from({ length: widgetsPer }, () => w(`w${++n}`)) }],
      })),
    })),
  };
}

function mutate(fn: (l: J) => void) {
  const l = structuredClone(fixture()) as J;
  fn(l);
  return l;
}

const tabsIn = (l: J) => l.sections[0].rows[0].slots[1].widgets[0];

const fixtures: [string, unknown][] = [
  ...[false, true].flatMap((ws) =>
    builtinTemplates(ws).map((t) => [`builtin ${t.name} (${ws ? 'workspace' : 'solo'})`, t.layout] as [string, unknown]),
  ),
  ['fixture', fixture()],
  ['empty', { version: 1, sections: [] }],
  ['collapsed section', mutate((l) => (l.sections[1].collapsed = false))],
  ['not an object', 'nope'],
  ['null', null],
  ['array', []],
  ['bad version', mutate((l) => (l.version = 2))],
  ['sections not array', { version: 1, sections: {} }],
  ['section not object', { version: 1, sections: [3] }],
  ['section missing id + title', { version: 1, sections: [{ rows: [] }] }],
  ['collapsed not boolean', mutate((l) => (l.sections[0].collapsed = 'yes'))],
  ['rows not array', mutate((l) => (l.sections[0].rows = null))],
  ['row not object', mutate((l) => (l.sections[1].rows = [7]))],
  ['height 0', mutate((l) => (l.sections[0].rows[1].height = 0))],
  ['height 13 in tab', mutate((l) => (tabsIn(l).params.tabs[0].rows[0].height = 13))],
  ['slots not array', mutate((l) => (l.sections[0].rows[1].slots = 'x'))],
  ['slot not object', mutate((l) => (l.sections[0].rows[1].slots = [null]))],
  ['span 13', mutate((l) => (l.sections[0].rows[1].slots[0].span = 13))],
  ['spans sum 13', mutate((l) => (l.sections[0].rows[0].slots[0].span = 7))],
  ['spans sum 13 in tab', mutate((l) => tabsIn(l).params.tabs[1].rows[0].slots.push({ id: 'zz', span: 7, widgets: [] }))],
  ['widgets not array', mutate((l) => (l.sections[0].rows[1].slots[0].widgets = {}))],
  ['widget not object', mutate((l) => l.sections[0].rows[1].slots[0].widgets.push('w'))],
  [
    'agentic types',
    mutate((l) =>
      l.sections[1].rows[0].slots[0].widgets.push(
        ...['autonomy-index', 'agent-stops', 'batch-size', 'spec-adherence', 'governance-posture', 'rework-cost', 'decision-latency-cost', 'cost-anomaly', 'usage-runway', 'steering-pack', 'agent-hourly-rate', 'perception-gap'].map((t, i) => w(`ag${i}`, t)),
      ),
    ),
  ],
  ['unknown type', mutate((l) => (l.sections[1].rows[0].slots[0].widgets[0].type = 'chart'))],
  ['bad size', mutate((l) => (l.sections[1].rows[0].slots[0].widgets[0].size = 'XXL'))],
  ['params missing', mutate((l) => delete l.sections[1].rows[0].slots[0].widgets[0].params)],
  ['kpi bad metric', mutate((l) => (l.sections[0].rows[0].slots[0].widgets[1].params.metric = 'velocity'))],
  ['placeholder text not string', mutate((l) => (l.sections[1].rows[0].slots[0].widgets[0].params.text = 5))],
  ['duplicate id', mutate((l) => (l.sections[1].id = 'sec1'))],
  ['duplicate id inside tab', mutate((l) => (tabsIn(l).params.tabs[1].rows[0].slots[0].id = 'slot1'))],
  ['empty id', mutate((l) => (l.sections[0].rows[0].id = ''))],
  ['nested tabs', mutate((l) => tabsIn(l).params.tabs[1].rows[0].slots[0].widgets.push(w('inner', 'tabs', { tabs: [] })))],
  ['tabs not array', mutate((l) => (tabsIn(l).params.tabs = {}))],
  ['tab not object', mutate((l) => tabsIn(l).params.tabs.push(1))],
  ['tab missing title', mutate((l) => delete tabsIn(l).params.tabs[0].title)],
  ['tab rows not array', mutate((l) => (tabsIn(l).params.tabs[0].rows = undefined))],
  ['21 sections', bigLayout(21, 0, 0)],
  ['20 sections ok', bigLayout(20, 1, 1)],
  ['51 rows', bigLayout(3, 17, 0)],
  ['50 rows ok', bigLayout(2, 25, 0)],
  ['201 widgets', bigLayout(1, 3, 67)],
  ['200 widgets ok', bigLayout(1, 4, 50)],
];

describe('layout-ops: loValidate parity with validateLayout', () => {
  it('has at least 15 fixtures incl. every builtin template', () => {
    assert.ok(fixtures.length >= 15);
    assert.equal(fixtures.filter(([n]) => n.startsWith('builtin')).length, builtinTemplates(false).length * 2);
    assert.ok(fixtures.some(([, l]) => validateLayout(l).length === 0));
    assert.ok(fixtures.some(([, l]) => validateLayout(l).length > 0));
  });

  it('LO_SCHEMA types and sizes match WIDGET_TYPES / WIDGET_SIZES', () => {
    const schema = vm.runInThisContext('LO_SCHEMA') as { types: string[]; sizes: string[] };
    assert.deepEqual(schema.types, [...WIDGET_TYPES]);
    assert.deepEqual(schema.sizes, [...WIDGET_SIZES]);
  });

  for (const [name, layout] of fixtures) {
    it(name, () => {
      const server = validateLayout(layout);
      const client = lo.loValidate(layout);
      assert.equal(client.length === 0, server.length === 0, 'same pass/fail');
      assert.deepEqual(client, server, 'same errors');
    });
  }
});
