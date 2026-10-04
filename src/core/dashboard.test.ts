import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createVertical, deleteProject, getOrCreateProject } from './board.js';
import {
  builtinTemplates,
  getLayout,
  isWorkspaceBoard,
  listTemplates,
  resetLayout,
  saveLayout,
  saveTemplate,
  validateLayout,
  WIDGET_TYPES,
} from './dashboard.js';
import { openDb } from './db.js';
import type { DashboardLayout, DashWidget } from './types.js';

const widget = (id: string, extra: Partial<DashWidget> = {}): DashWidget => ({
  id,
  type: 'now-building',
  size: 'M',
  params: {},
  ...extra,
});

/** One section, one row, one slot holding `widgets`. */
const layoutWith = (...widgets: DashWidget[]): DashboardLayout => ({
  version: 1,
  sections: [{ id: 's', title: 'S', rows: [{ id: 'r', height: 4, slots: [{ id: 'sl', span: 12, widgets }] }] }],
});

const paths = (input: unknown) => validateLayout(input).map((e) => e.path);

describe('builtin templates', () => {
  for (const workspace of [false, true]) {
    for (const t of builtinTemplates(workspace)) {
      it(`${t.name} (${workspace ? 'workspace' : 'solo'}) passes validateLayout`, () => {
        assert.deepEqual(validateLayout(t.layout), []);
      });
    }
  }

  it('Delivery lead adds workspace-boards only for workspaces; send-to-agent last', () => {
    const types = (l: DashboardLayout) => l.sections[0].rows.map((r) => r.slots.map((s) => s.widgets[0].type).join('+'));
    const [solo] = builtinTemplates(false);
    const [ws] = builtinTemplates(true);
    assert.deepEqual(types(solo.layout), ['now-building+active-agents', 'kpi+kpi+kpi+kpi', 'tabs', 'send-to-agent']);
    assert.deepEqual(types(ws.layout), [
      'now-building+active-agents',
      'kpi+kpi+kpi+kpi',
      'workspace-boards',
      'tabs',
      'send-to-agent',
    ]);
    const tabs = ws.layout.sections[0].rows[3].slots[0].widgets[0].params.tabs as { title: string }[];
    assert.deepEqual(
      tabs.map((t) => t.title),
      ['Needs you', 'Delivery', 'Flow', 'Spend', 'Quality and risk'],
    );
  });

  it('Exec roll-up starts with KPIs and has no send-to-agent; Agent ops leads with agents', () => {
    const [, exec, ops] = builtinTemplates(true);
    const execTypes = exec.layout.sections[0].rows.map((r) => r.slots[0].widgets[0].type);
    assert.deepEqual(execTypes, ['kpi', 'workspace-boards', 'tabs']);
    const top = ops.layout.sections[0].rows[0].slots;
    assert.deepEqual(
      top.map((s) => [s.widgets[0].type, s.widgets[0].size, s.span]),
      [
        ['active-agents', 'L', 8],
        ['now-building', 'M', 4],
      ],
    );
    assert.equal(WIDGET_TYPES.includes('send-to-agent'), true);
  });
});

describe('builtin tab groups', () => {
  type Tab = { id: string; title: string; rows: DashboardLayout['sections'][0]['rows'] };
  const tabsOf = (l: DashboardLayout) =>
    l.sections[0].rows.flatMap((r) => r.slots.flatMap((s) => s.widgets)).find((w) => w.type === 'tabs')!.params.tabs as Tab[];
  /** title → each slot as "type[:metric]/span" */
  const shape = (l: DashboardLayout) =>
    Object.fromEntries(
      tabsOf(l).map((t) => [
        t.title,
        t.rows.flatMap((r) => r.slots.map((s) => `${s.widgets.map((w) => (w.type === 'kpi' ? `kpi:${w.params.metric}` : w.type)).join(',')}/${s.span}`)),
      ]),
    );
  const placeholderTexts = (l: DashboardLayout) =>
    tabsOf(l).flatMap((t) => t.rows.flatMap((r) => r.slots.flatMap((s) => s.widgets.filter((w) => w.type === 'placeholder').map((w) => w.params.text as string))));

  for (const workspace of [false, true]) {
    const [dl, ex, ao] = builtinTemplates(workspace);
    const v = workspace ? 'workspace' : 'solo';

    it(`Delivery lead (${v}): each tab pairs its kpi with up-next or a placeholder`, () => {
      assert.deepEqual(shape(dl.layout), {
        'Needs you': ['kpi:decisions/6', 'up-next/6'],
        Delivery: ['kpi:schedule/6', 'placeholder/6'],
        Flow: ['kpi:throughput/6', 'placeholder/6'],
        Spend: ['kpi:budget/6', 'placeholder/6'],
        'Quality and risk': ['placeholder/12'],
      });
      const top = dl.layout.sections[0].rows[0].slots.flatMap((s) => s.widgets.map((w) => w.type));
      const inTabs = tabsOf(dl.layout).flatMap((t) => t.rows.flatMap((r) => r.slots.flatMap((s) => s.widgets.map((w) => w.type))));
      assert.deepEqual(top.filter((t) => inTabs.includes(t)), []);
      assert.deepEqual(placeholderTexts(dl.layout), [
        'Forecast range, milestones and scope change arrive with the delivery widgets',
        'Cycle time, WIP and review queue arrive with the flow widgets',
        'Cost per card and usage runway arrive with the spend widgets',
        'First-pass rate, rework and top risks arrive with the quality widgets',
      ]);
    });

    it(`Exec roll-up (${v}): Needs you has no up-next`, () => {
      assert.deepEqual(shape(ex.layout), {
        'Needs you': ['kpi:decisions/6', 'placeholder/6'],
        Delivery: ['kpi:schedule/6', 'placeholder/6'],
        Flow: ['kpi:throughput/6', 'placeholder/6'],
        Spend: ['kpi:budget/6', 'placeholder/6'],
        'Quality and risk': ['placeholder/12'],
      });
    });

    it(`Agent ops (${v}): agent-focused tabs before send-to-agent, up-next not repeated`, () => {
      assert.deepEqual(shape(ao.layout), {
        'Needs you': ['kpi:decisions/6', 'placeholder/6'],
        Flow: ['kpi:throughput/6', 'placeholder/6'],
        Spend: ['kpi:budget/6', 'placeholder/6'],
        'Quality and risk': ['placeholder/12'],
      });
      assert.deepEqual(
        ao.layout.sections[0].rows.map((r) => r.slots[0].widgets[0].type),
        ['active-agents', 'up-next', 'tabs', 'send-to-agent'],
      );
    });

    it(`every placeholder (${v}) says what it arrives with`, () => {
      for (const t of [dl, ex, ao])
        for (const text of placeholderTexts(t.layout)) assert.match(text, / arrive with the [a-z-]+ widgets$/, `${t.name}: ${text}`);
    });
  }

  it('existing ids keep their numbers', () => {
    const [dl, , ao] = builtinTemplates(false);
    assert.deepEqual(
      ao.layout.sections[0].rows.map((r) => r.id),
      ['ao-row5', 'ao-row8', 'ao-row37', 'ao-row11'],
    );
    assert.equal(ao.layout.sections[0].id, 'ao-sec12');
    assert.equal(tabsOf(dl.layout)[0].rows[0].slots[1].widgets[0].id, 'dl-w17');
  });
});

describe('validateLayout', () => {
  it('accepts a minimal valid layout', () => {
    assert.deepEqual(validateLayout(layoutWith(widget('a'))), []);
    assert.deepEqual(validateLayout({ version: 1, sections: [] }), []);
  });

  it('rejects non-objects and a wrong version', () => {
    assert.deepEqual(paths(null), ['']);
    assert.deepEqual(paths({ version: 2, sections: [] }), ['version']);
    assert.deepEqual(paths({ version: 1 }), ['sections']);
  });

  it('unknown widget type', () => {
    assert.deepEqual(paths(layoutWith(widget('a', { type: 'bogus' }))), ['sections[0].rows[0].slots[0].widgets[0].type']);
  });

  it('span and height out of range or non-integer', () => {
    for (const span of [0, 13, 2.5, '6']) {
      const l = layoutWith(widget('a'));
      (l.sections[0].rows[0].slots[0] as { span: unknown }).span = span;
      assert.deepEqual(paths(l), ['sections[0].rows[0].slots[0].span'], String(span));
    }
    for (const height of [0, 13, 1.5]) {
      const l = layoutWith(widget('a'));
      l.sections[0].rows[0].height = height;
      assert.deepEqual(paths(l), ['sections[0].rows[0].height'], String(height));
    }
  });

  it('row spans summing past 12', () => {
    const l = layoutWith(widget('a'));
    l.sections[0].rows[0].slots = [
      { id: 'x', span: 8, widgets: [] },
      { id: 'y', span: 5, widgets: [] },
    ];
    assert.deepEqual(paths(l), ['sections[0].rows[0].slots']);
    l.sections[0].rows[0].slots[1].span = 4;
    assert.deepEqual(paths(l), []);
  });

  it('duplicate ids across the layout, including inside tabs', () => {
    assert.deepEqual(paths(layoutWith(widget('a'), widget('a'))), ['sections[0].rows[0].slots[0].widgets[1].id']);
    assert.deepEqual(paths(layoutWith(widget('r'))), ['sections[0].rows[0].slots[0].widgets[0].id']); // clashes with the row
    const tabs = widget('t', {
      type: 'tabs',
      params: { tabs: [{ id: 'tab', title: 'T', rows: [{ id: 'r2', height: 2, slots: [{ id: 'sl2', span: 6, widgets: [widget('a')] }] }] }] },
    });
    assert.deepEqual(paths(layoutWith(widget('a'), tabs)), [
      'sections[0].rows[0].slots[0].widgets[1].params.tabs[0].rows[0].slots[0].widgets[0].id',
    ]);
  });

  it('bad size', () => {
    assert.deepEqual(paths(layoutWith(widget('a', { size: 'XXL' as 'S' }))), ['sections[0].rows[0].slots[0].widgets[0].size']);
  });

  it('bad or missing kpi metric', () => {
    assert.deepEqual(paths(layoutWith(widget('a', { type: 'kpi', params: { metric: 'velocity' } }))), [
      'sections[0].rows[0].slots[0].widgets[0].params.metric',
    ]);
    assert.deepEqual(paths(layoutWith(widget('a', { type: 'kpi' }))), ['sections[0].rows[0].slots[0].widgets[0].params.metric']);
    assert.deepEqual(paths(layoutWith(widget('a', { type: 'kpi', params: { metric: 'budget' } }))), []);
  });

  it('nested tabs', () => {
    const inner = widget('inner', { type: 'tabs', params: { tabs: [] } });
    const outer = widget('outer', {
      type: 'tabs',
      params: { tabs: [{ id: 'tab', title: 'T', rows: [{ id: 'r2', height: 2, slots: [{ id: 'sl2', span: 6, widgets: [inner] }] }] }] },
    });
    assert.deepEqual(paths(layoutWith(outer)), [
      'sections[0].rows[0].slots[0].widgets[0].params.tabs[0].rows[0].slots[0].widgets[0].type',
    ]);
  });

  it('caps: sections, total rows (incl. tab rows) and widgets', () => {
    const sections = Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, title: '', rows: [] }));
    assert.deepEqual(paths({ version: 1, sections }), ['sections']);

    const rows = Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, height: 1, slots: [] }));
    assert.deepEqual(paths({ version: 1, sections: [{ id: 's', title: '', rows }] }), ['sections']);
    const tabRows = rows.slice(0, 2).map((r) => ({ ...r, id: `t${r.id}` }));
    const tabs = widget('tw', { type: 'tabs', params: { tabs: [{ id: 'tab', title: 'T', rows: tabRows }] } });
    const fifty = rows.slice(0, 49);
    fifty[0] = { ...fifty[0], slots: [{ id: 'sl', span: 12, widgets: [tabs] }] } as never;
    assert.deepEqual(paths({ version: 1, sections: [{ id: 's', title: '', rows: fifty }] }), ['sections']); // 49 + 2 tab rows

    const many = Array.from({ length: 201 }, (_, i) => widget(`w${i}`));
    assert.deepEqual(paths(layoutWith(...many)), ['sections']);
    assert.deepEqual(paths(layoutWith(...many.slice(0, 200))), []);
  });
});

describe('layout storage', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-dashboard-'));
    mkdirSync(join(dir, 'web'), { recursive: true });
    mkdirSync(join(dir, 'solo'), { recursive: true });
    const db = openDb();
    const ws = getOrCreateProject(db, dir, 'Shop');
    const web = createVertical(db, ws.id, 'web', join(dir, 'web'));
    const solo = getOrCreateProject(db, join(dir, 'solo'), 'Solo');
    return { db, ws, web, solo, cleanup: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
  }

  it('defaults per board type, saves, resets, and drops on project delete', () => {
    const { db, ws, web, solo, cleanup } = setup();
    try {
      assert.equal(isWorkspaceBoard(db, ws.id), true);
      assert.equal(isWorkspaceBoard(db, web.id), true);
      assert.equal(isWorkspaceBoard(db, solo.id), false);
      assert.deepEqual(getLayout(db, solo.id), { layout: builtinTemplates(false)[0].layout, source: 'default', template: 'Delivery lead' });
      assert.deepEqual(getLayout(db, web.id).layout, builtinTemplates(true)[0].layout);

      const mine = layoutWith(widget('a'));
      saveLayout(db, solo.id, mine);
      assert.deepEqual(getLayout(db, solo.id), { layout: mine, source: 'saved', template: null });
      assert.equal(resetLayout(db, solo.id).source, 'default');

      saveLayout(db, solo.id, mine);
      deleteProject(db, solo.id);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM dashboard_layouts').get() as { n: number }).n, 0);
    } finally {
      cleanup();
    }
  });

  it('lists builtins first, then user templates', () => {
    const { db, cleanup } = setup();
    try {
      const saved = saveTemplate(db, 'Mine', layoutWith(widget('a')));
      const list = listTemplates(db);
      assert.deepEqual(
        list.map((t) => [t.name, t.builtin]),
        [
          ['Delivery lead', true],
          ['Exec roll-up', true],
          ['Agent ops', true],
          ['Mine', false],
        ],
      );
      assert.deepEqual(list[3], saved);
    } finally {
      cleanup();
    }
  });
});
