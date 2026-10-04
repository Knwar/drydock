import type { DB } from './db.js';
import { listVerticals, now, shortId } from './board.js';
import type { DashboardLayout, DashRow, DashSection, DashSlot, DashWidget } from './types.js';

// ── dashboard layouts: per-board widget grids, builtin + user-saved templates ──
//
// A board with no saved layout shows a builtin template chosen by board type
// (solo vs workspace). Builtin templates are code; user templates are rows in
// dashboard_templates. Every stored layout passes validateLayout first.

export const WIDGET_TYPES = [
  'now-building',
  'active-agents',
  'verticals',
  'up-next',
  'send-to-agent',
  'kpi',
  'tabs',
  'workspace-boards',
  'placeholder',
] as const;

export const WIDGET_SIZES = ['S', 'M', 'L', 'XL'] as const;
export const KPI_METRICS = ['schedule', 'budget', 'decisions', 'throughput'] as const;

export const LAYOUT_CAPS = { sections: 20, rows: 50, widgets: 200 } as const;

export interface LayoutError {
  path: string; // e.g. sections[0].rows[1].slots[2].span
  message: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Every problem with a candidate layout (empty = valid). Pure; accepts any JSON. */
export function validateLayout(input: unknown): LayoutError[] {
  const errors: LayoutError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const seen = new Map<string, string>(); // id → first path
  let rowCount = 0;
  let widgetCount = 0;

  const id = (o: Obj, path: string) => {
    if (typeof o.id !== 'string' || !o.id) return err(`${path}.id`, 'id (non-empty string) required');
    const first = seen.get(o.id);
    if (first !== undefined) err(`${path}.id`, `duplicate id "${o.id}" (also at ${first})`);
    else seen.set(o.id, path);
  };

  const rows = (list: unknown, path: string, inTab: boolean) => {
    if (!Array.isArray(list)) return err(path, 'rows must be an array');
    list.forEach((r, i) => row(r, `${path}[${i}]`, inTab));
  };

  const row = (r: unknown, path: string, inTab: boolean) => {
    if (!isObj(r)) return err(path, 'row must be an object');
    rowCount++;
    id(r, path);
    if (!isIntIn(r.height, 1, 12)) err(`${path}.height`, 'height must be an integer 1-12');
    if (!Array.isArray(r.slots)) return err(`${path}.slots`, 'slots must be an array');
    let spans = 0;
    r.slots.forEach((s, i) => {
      const sp = `${path}.slots[${i}]`;
      if (!isObj(s)) return err(sp, 'slot must be an object');
      id(s, sp);
      if (!isIntIn(s.span, 1, 12)) err(`${sp}.span`, 'span must be an integer 1-12');
      else spans += s.span as number;
      if (!Array.isArray(s.widgets)) return err(`${sp}.widgets`, 'widgets must be an array');
      s.widgets.forEach((w, j) => widget(w, `${sp}.widgets[${j}]`, inTab));
    });
    if (spans > 12) err(`${path}.slots`, `slot spans sum to ${spans} (max 12)`);
  };

  const widget = (w: unknown, path: string, inTab: boolean) => {
    if (!isObj(w)) return err(path, 'widget must be an object');
    widgetCount++;
    id(w, path);
    if (!(WIDGET_TYPES as readonly unknown[]).includes(w.type)) err(`${path}.type`, `unknown widget type "${String(w.type)}"`);
    if (!(WIDGET_SIZES as readonly unknown[]).includes(w.size)) err(`${path}.size`, 'size must be S, M, L or XL');
    if (!isObj(w.params)) return err(`${path}.params`, 'params must be an object');
    const p = w.params;
    if (w.type === 'kpi' && !(KPI_METRICS as readonly unknown[]).includes(p.metric))
      err(`${path}.params.metric`, `kpi metric must be one of ${KPI_METRICS.join(', ')}`);
    if (w.type === 'placeholder' && p.text !== undefined && typeof p.text !== 'string')
      err(`${path}.params.text`, 'text must be a string');
    if (w.type !== 'tabs') return;
    if (inTab) return err(`${path}.type`, 'tabs may not contain another tabs widget');
    if (!Array.isArray(p.tabs)) return err(`${path}.params.tabs`, 'tabs must be an array');
    p.tabs.forEach((t, i) => {
      const tp = `${path}.params.tabs[${i}]`;
      if (!isObj(t)) return err(tp, 'tab must be an object');
      id(t, tp);
      if (typeof t.title !== 'string') err(`${tp}.title`, 'title (string) required');
      rows(t.rows, `${tp}.rows`, true);
    });
  };

  if (!isObj(input)) return [{ path: '', message: 'layout must be an object' }];
  if (input.version !== 1) err('version', 'version must be 1');
  if (!Array.isArray(input.sections)) {
    err('sections', 'sections must be an array');
    return errors;
  }
  if (input.sections.length > LAYOUT_CAPS.sections) err('sections', `at most ${LAYOUT_CAPS.sections} sections`);
  input.sections.forEach((s, i) => {
    const path = `sections[${i}]`;
    if (!isObj(s)) return err(path, 'section must be an object');
    id(s, path);
    if (typeof s.title !== 'string') err(`${path}.title`, 'title (string) required');
    if (s.collapsed !== undefined && typeof s.collapsed !== 'boolean') err(`${path}.collapsed`, 'collapsed must be a boolean');
    rows(s.rows, `${path}.rows`, false);
  });
  if (rowCount > LAYOUT_CAPS.rows) err('sections', `at most ${LAYOUT_CAPS.rows} rows in total (has ${rowCount})`);
  if (widgetCount > LAYOUT_CAPS.widgets) err('sections', `at most ${LAYOUT_CAPS.widgets} widgets (has ${widgetCount})`);
  return errors;
}

// ── builtin templates ──

export interface DashTemplate {
  id: string;
  name: string;
  builtin: boolean;
  layout: DashboardLayout;
}

export const DEFAULT_TEMPLATE = 'Delivery lead';

/** Builds one template's layout with deterministic ids (prefix + counter), unique within it. */
function builder(prefix: string) {
  let n = 0;
  const id = (kind: string) => `${prefix}-${kind}${++n}`;
  const w = (type: string, size: DashWidget['size'], params: Record<string, unknown> = {}): DashWidget => ({
    id: id('w'),
    type,
    size,
    params,
  });
  const slot = (span: number, ...widgets: DashWidget[]): DashSlot => ({ id: id('slot'), span, widgets });
  const row = (height: number, ...slots: DashSlot[]): DashRow => ({ id: id('row'), height, slots });
  const tab = (title: string, ...rows: DashRow[]) => ({ id: id('tab'), title, rows });
  const section = (title: string, ...rows: DashRow[]): DashSection => ({ id: id('sec'), title, rows });
  const kpi = (metric: string, size: DashWidget['size']) => w('kpi', size, { metric });
  const placeholder = (text: string) => w('placeholder', 'M', { text });
  return { w, slot, row, tab, section, kpi, placeholder };
}

function kpiRow(b: ReturnType<typeof builder>): DashRow {
  return b.row(2, ...KPI_METRICS.map((m) => b.slot(3, b.kpi(m, 'S'))));
}

const PLACEHOLDER = {
  needsYou: 'Blocked cards and open decisions arrive with the needs-you widgets',
  delivery: 'Forecast range, milestones and scope change arrive with the delivery widgets',
  flow: 'Cycle time, WIP and review queue arrive with the flow widgets',
  spend: 'Cost per card and usage runway arrive with the spend widgets',
  quality: 'First-pass rate, rework and top risks arrive with the quality widgets',
};

/**
 * The tab group. Each tab pairs its kpi (span 6) with a placeholder for the widgets still to come.
 * `upNext`: Needs you shows up-next beside the decisions kpi (else a placeholder) — off where
 * up-next is already elsewhere on the template or out of focus. `delivery`: include the Delivery tab.
 */
function tabsRow(b: ReturnType<typeof builder>, opts: { upNext: boolean; delivery: boolean }): DashRow {
  const { row, slot, tab, kpi, placeholder, w } = b;
  return row(
    5,
    slot(
      12,
      w('tabs', 'L', {
        tabs: [
          tab('Needs you', row(4, slot(6, kpi('decisions', 'M')), slot(6, opts.upNext ? w('up-next', 'M') : placeholder(PLACEHOLDER.needsYou)))),
          ...(opts.delivery ? [tab('Delivery', row(4, slot(6, kpi('schedule', 'M')), slot(6, placeholder(PLACEHOLDER.delivery))))] : []),
          tab('Flow', row(4, slot(6, kpi('throughput', 'M')), slot(6, placeholder(PLACEHOLDER.flow)))),
          tab('Spend', row(4, slot(6, kpi('budget', 'M')), slot(6, placeholder(PLACEHOLDER.spend)))),
          tab('Quality and risk', row(4, slot(12, placeholder(PLACEHOLDER.quality)))),
        ],
      }),
    ),
  );
}

function workspaceRow(b: ReturnType<typeof builder>): DashRow {
  return b.row(4, b.slot(12, b.w('workspace-boards', 'L')));
}

function sendRow(b: ReturnType<typeof builder>): DashRow {
  return b.row(3, b.slot(12, b.w('send-to-agent', 'M')));
}

function deliveryLead(workspace: boolean): DashboardLayout {
  const b = builder('dl');
  const rows = [
    b.row(4, b.slot(6, b.w('now-building', 'M')), b.slot(6, b.w('active-agents', 'M'))),
    kpiRow(b),
    ...(workspace ? [workspaceRow(b)] : []),
    tabsRow(b, { upNext: true, delivery: true }),
    sendRow(b),
  ];
  return { version: 1, sections: [b.section('Overview', ...rows)] };
}

function execRollup(workspace: boolean): DashboardLayout {
  const b = builder('ex');
  const rows = [kpiRow(b), ...(workspace ? [workspaceRow(b)] : []), tabsRow(b, { upNext: false, delivery: true })];
  return { version: 1, sections: [b.section('Overview', ...rows)] };
}

function agentOps(): DashboardLayout {
  const b = builder('ao');
  const rows = [
    b.row(4, b.slot(8, b.w('active-agents', 'L')), b.slot(4, b.w('now-building', 'M'))),
    b.row(4, b.slot(12, b.w('up-next', 'M'))),
    sendRow(b),
  ];
  const overview = b.section('Overview', ...rows);
  // Tabs built last so the existing ao- ids keep their numbers; placed before send-to-agent.
  // Agent-focused: up-next already has its own row; schedule is a delivery-lead concern.
  overview.rows.splice(2, 0, tabsRow(b, { upNext: false, delivery: false }));
  return { version: 1, sections: [overview] };
}

/** The three builtin templates for a board type, default (Delivery lead) first. */
export function builtinTemplates(workspace: boolean): DashTemplate[] {
  return [
    { id: 'builtin-delivery-lead', name: DEFAULT_TEMPLATE, builtin: true, layout: deliveryLead(workspace) },
    { id: 'builtin-exec-rollup', name: 'Exec roll-up', builtin: true, layout: execRollup(workspace) },
    { id: 'builtin-agent-ops', name: 'Agent ops', builtin: true, layout: agentOps() },
  ];
}

export function defaultLayout(workspace: boolean): DashboardLayout {
  return deliveryLead(workspace);
}

// ── storage ──

/** A workspace board: a project with verticals, or a vertical of a workspace. */
export function isWorkspaceBoard(db: DB, projectId: string): boolean {
  const row = db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(projectId) as
    | { parent_id: string | null }
    | undefined;
  return !!row && (row.parent_id !== null || listVerticals(db, projectId).length > 0);
}

export interface BoardLayout {
  layout: DashboardLayout;
  source: 'saved' | 'default';
  template: string | null; // the builtin template name when source is 'default'
}

export function getLayout(db: DB, projectId: string): BoardLayout {
  const row = db.prepare('SELECT layout FROM dashboard_layouts WHERE project_id = ?').get(projectId) as
    | { layout: string }
    | undefined;
  if (row) return { layout: JSON.parse(row.layout) as DashboardLayout, source: 'saved', template: null };
  return { layout: defaultLayout(isWorkspaceBoard(db, projectId)), source: 'default', template: DEFAULT_TEMPLATE };
}

/** Save a board's layout; the caller validates first (validateLayout must be empty). */
export function saveLayout(db: DB, projectId: string, layout: DashboardLayout): void {
  db.prepare(
    `INSERT INTO dashboard_layouts (project_id, layout, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
  ).run(projectId, JSON.stringify(layout), now());
}

/** Drop a board's saved layout so it shows its default again. */
export function resetLayout(db: DB, projectId: string): BoardLayout {
  db.prepare('DELETE FROM dashboard_layouts WHERE project_id = ?').run(projectId);
  return getLayout(db, projectId);
}

/** Builtins (in their solo variant) first, then user templates oldest first. */
export function listTemplates(db: DB, workspace = false): DashTemplate[] {
  const rows = db.prepare('SELECT id, name, layout FROM dashboard_templates ORDER BY created_at, rowid').all() as {
    id: string;
    name: string;
    layout: string;
  }[];
  return [
    ...builtinTemplates(workspace),
    ...rows.map((r) => ({ id: r.id, name: r.name, builtin: false, layout: JSON.parse(r.layout) as DashboardLayout })),
  ];
}

/** Save a user template; the caller validates the layout first. */
export function saveTemplate(db: DB, name: string, layout: DashboardLayout): DashTemplate {
  const id = shortId();
  db.prepare('INSERT INTO dashboard_templates (id, name, layout, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    JSON.stringify(layout),
    now(),
  );
  return { id, name, builtin: false, layout };
}
