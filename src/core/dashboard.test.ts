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

  it('Exec roll-up starts with KPIs then phase health + RAG trend, no send-to-agent; Agent ops leads with agents', () => {
    const [, exec, ops] = builtinTemplates(true);
    const execTypes = exec.layout.sections[0].rows.map((r) => r.slots[0].widgets[0].type);
    assert.deepEqual(execTypes, ['kpi', 'phase-health', 'workspace-boards', 'tabs']);
    const health = exec.layout.sections[0].rows[1];
    assert.equal(health.height, 5);
    assert.deepEqual(
      health.slots.map((s) => [s.widgets[0].type, s.widgets[0].size, s.span]),
      [
        ['phase-health', 'L', 8],
        ['rag-trend', 'M', 4],
      ],
    );
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
  /** title → each row as "height: type size/span + …" */
  const shape = (l: DashboardLayout) =>
    Object.fromEntries(
      tabsOf(l).map((t) => [
        t.title,
        t.rows.map((r) => `${r.height}: ${r.slots.map((s) => `${s.widgets.map((w) => `${w.type} ${w.size}`).join(',')}/${s.span}`).join(' + ')}`),
      ]),
    );
  const tabWidgets = (l: DashboardLayout) => tabsOf(l).flatMap((t) => t.rows.flatMap((r) => r.slots.flatMap((s) => s.widgets)));
  const topWidgets = (l: DashboardLayout) => l.sections[0].rows.flatMap((r) => r.slots.flatMap((s) => s.widgets)).filter((w) => w.type !== 'tabs');

  for (const workspace of [false, true]) {
    const [dl, ex, ao] = builtinTemplates(workspace);
    const v = workspace ? 'workspace' : 'solo';

    it(`Delivery lead (${v}): the delivery lead's tabs`, () => {
      assert.deepEqual(shape(dl.layout), {
        'Needs you': ['4: up-next M/6 + review-queue M/6', '4: escalation M/6 + gate-readiness M/6'],
        Delivery: ['5: phase-health L/8 + forecast M/4', '4: milestones M/4 + scope-change M/4 + planned-delivered M/4'],
        Flow: ['5: throughput-trend L/8 + wip M/4', '5: cycle-breakdown L/12'],
        Spend: ['4: ai-spend M/6 + investment-mix M/6', '5: budget-burn L/12'],
        'Quality and risk': ['4: quality M/6 + speed-stability M/6', '5: top-risks L/8 + rag-trend M/4'],
      });
      const top = dl.layout.sections[0].rows[0].slots.flatMap((s) => s.widgets.map((w) => w.type));
      const inTabs = tabWidgets(dl.layout).map((w) => w.type);
      assert.deepEqual(top.filter((t) => inTabs.includes(t)), []);
    });

    it(`Exec roll-up (${v}): delivery, spend and risk; no flow detail`, () => {
      assert.deepEqual(shape(ex.layout), {
        Delivery: ['4: forecast M/6 + milestones M/6', '4: scope-change M/6 + planned-delivered M/6'],
        Spend: ['4: ai-spend M/6 + investment-mix M/6', '5: budget-burn L/12'],
        'Quality and risk': ['5: top-risks L/8 + quality M/4', '4: speed-stability M/12'],
      });
      const types = [...topWidgets(ex.layout), ...tabWidgets(ex.layout)].map((w) => w.type);
      for (const t of ['review-queue', 'wip', 'cycle-breakdown']) assert.equal(types.includes(t), false, t);
      // phase-health and rag-trend sit in the top row, not again in the tabs
      assert.equal(types.filter((t) => t === 'phase-health' || t === 'rag-trend').length, 2);
    });

    it(`Agent ops (${v}): flow and quality tabs before send-to-agent, up-next not repeated`, () => {
      assert.deepEqual(shape(ao.layout), {
        'Needs you': ['4: review-queue M/6 + escalation M/6', '4: gate-readiness M/6 + top-risks M/6'],
        Flow: ['5: throughput-trend L/8 + wip M/4', '5: cycle-breakdown L/12'],
        Quality: ['5: quality L/12', '4: speed-stability M/12'],
      });
      assert.deepEqual(
        ao.layout.sections[0].rows.map((r) => r.slots[0].widgets[0].type),
        ['active-agents', 'up-next', 'tabs', 'send-to-agent'],
      );
    });

    it(`no placeholders; every tab has 1-3 rows, M rows height 4, L rows 5-6 (${v})`, () => {
      for (const t of [dl, ex, ao]) {
        assert.deepEqual(
          tabWidgets(t.layout).filter((w) => w.type === 'placeholder'),
          [],
          t.name,
        );
        for (const tab of tabsOf(t.layout)) {
          assert.ok(tab.rows.length >= 1 && tab.rows.length <= 3, `${t.name} / ${tab.title}: ${tab.rows.length} rows`);
          for (const r of tab.rows) {
            const large = r.slots.some((s) => s.widgets.some((w) => w.size === 'L' || w.size === 'XL'));
            assert.ok(large ? r.height >= 5 && r.height <= 6 : r.height === 4, `${t.name} / ${tab.title}: ${r.id} height ${r.height}`);
          }
        }
      }
    });

    it(`no tab holds more than 10 units of rows, so the tabs row fits it without scrolling (${v})`, () => {
      for (const t of [dl, ex, ao])
        for (const tab of tabsOf(t.layout)) {
          const h = tab.rows.reduce((sum, r) => sum + r.height, 0);
          assert.ok(h <= 10, `${t.name} / ${tab.title}: ${h}`);
        }
    });

    it(`no tab holds less than 60% of the tallest tab's units: no frame left mostly empty (${v})`, () => {
      for (const t of [dl, ex, ao]) {
        const units = tabsOf(t.layout).map((tab) => tab.rows.reduce((h, r) => h + r.height, 0));
        const tallest = Math.max(...units);
        for (const [i, h] of units.entries()) assert.ok(h >= 0.6 * tallest, `${t.name} / ${tabsOf(t.layout)[i].title}: ${h} of ${tallest}`);
      }
    });

    it(`the tabs row fits its tallest tab, capped at 12 (${v})`, () => {
      for (const t of [dl, ex, ao]) {
        const row = t.layout.sections[0].rows.find((r) => r.slots.some((s) => s.widgets.some((w) => w.type === 'tabs')))!;
        const tallest = Math.max(...tabsOf(t.layout).map((tab) => tab.rows.reduce((h, r) => h + r.height, 0)));
        assert.equal(row.height, Math.min(12, tallest + 1), `${t.name}: height ${row.height}, tallest tab ${tallest}`);
      }
    });

    it(`no tab repeats a KPI metric from the template's top KPI row (${v})`, () => {
      for (const t of [dl, ex, ao]) {
        const top = new Set(topWidgets(t.layout).filter((w) => w.type === 'kpi').map((w) => w.params.metric));
        const repeated = tabWidgets(t.layout).filter((w) => w.type === 'kpi' && top.has(w.params.metric));
        assert.deepEqual(repeated, [], t.name);
      }
    });
  }

  it('existing ids keep their numbers', () => {
    const [dl, ex, ao] = builtinTemplates(false);
    assert.deepEqual(
      ao.layout.sections[0].rows.map((r) => r.id),
      ['ao-row5', 'ao-row8', 'ao-row37', 'ao-row11'],
    );
    assert.equal(ao.layout.sections[0].id, 'ao-sec12');
    assert.deepEqual(
      tabsOf(ao.layout).map((t) => t.id),
      ['ao-tab18', 'ao-tab24', 'ao-tab34'],
    );
    // the tab group, its tabs, up-next and send-to-agent keep the ids they had beside the kpi placeholders
    assert.deepEqual(
      dl.layout.sections[0].rows.map((r) => r.id),
      ['dl-row5', 'dl-row14', 'dl-row45', 'dl-row48'],
    );
    assert.equal(dl.layout.sections[0].rows[2].slots[0].widgets[0].id, 'dl-w43');
    assert.deepEqual(
      tabsOf(dl.layout).map((t) => t.id),
      ['dl-tab20', 'dl-tab26', 'dl-tab32', 'dl-tab38', 'dl-tab42'],
    );
    assert.equal(tabsOf(dl.layout)[0].rows[0].slots[0].widgets[0].id, 'dl-w17');
    assert.equal(dl.layout.sections[0].id, 'dl-sec49');
    const exRows = ex.layout.sections[0].rows.map((r) => r.id);
    assert.deepEqual([exRows[0], exRows[2]], ['ex-row9', 'ex-row40']); // the new phase-health row sits between
    assert.deepEqual(
      tabsOf(ex.layout).map((t) => t.id),
      ['ex-tab21', 'ex-tab33', 'ex-tab37'],
    );
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
