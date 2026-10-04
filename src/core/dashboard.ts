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
  'autonomy-index',
  'agent-stops',
  'batch-size',
  'spec-adherence',
  'governance-posture',
  'rework-cost',
  'decision-latency-cost',
  'cost-anomaly',
  'usage-runway',
  'steering-pack',
  'agent-hourly-rate',
  'perception-gap',
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
  /** Burn `count` ids (the retired contents' numbers) so the ids built after keep theirs. */
  const skip = (count: number) => {
    n += count;
  };
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
  /** A row of one widget per slot: [type, size, span]. */
  const line = (height: number, ...cells: [string, DashWidget['size'], number][]) =>
    row(height, ...cells.map(([type, size, span]) => slot(span, w(type, size))));
  return { w, slot, row, tab, section, kpi, line, skip };
}

type Builder = ReturnType<typeof builder>;

function kpiRow(b: Builder): DashRow {
  return b.row(2, ...KPI_METRICS.map((m) => b.slot(3, b.kpi(m, 'S'))));
}

/**
 * A tab of the group. `ids`: how many ids the tab took when each tab paired a kpi with a placeholder
 * (6, or 4 for Quality and risk). `rows` builds its contents (null drops the tab); `upNext`: the tab
 * keeps its up-next slot, which `rows` receives.
 */
interface TabPlan {
  title: string;
  ids: number;
  upNext?: boolean;
  rows: ((upNext?: DashSlot) => DashRow[]) | null;
}

/**
 * The tab group. Pass every tab in its old order: each tab, the group and everything built after
 * keep their ids (the retired kpi / placeholder ids are skipped, not reused). The tabs' contents
 * get new ids from `fill()`, called once the rest of the template is built; it also sizes the row.
 */
function tabsRow(b: Builder, plans: TabPlan[]): { row: DashRow; fill: () => void; extend: (title: string, ...rows: DashRow[]) => void } {
  const live: { tab: ReturnType<Builder['tab']>; plan: TabPlan; upNext?: DashSlot }[] = [];
  for (const plan of plans) {
    if (!plan.rows) {
      b.skip(plan.ids);
      continue;
    }
    let upNext: DashSlot | undefined;
    if (plan.upNext) {
      b.skip(2); // the kpi and its slot
      upNext = b.slot(6, b.w('up-next', 'M'));
      b.skip(1); // the row
    } else b.skip(plan.ids - 1);
    live.push({ tab: b.tab(plan.title), plan, upNext });
  }
  const row = b.row(5, b.slot(12, b.w('tabs', 'L', { tabs: live.map((t) => t.tab) })));
  // the row's height: the tallest tab's rows + 1 for the tab strip and gaps (max 12)
  const size = () => {
    const tallest = Math.max(...live.map((t) => t.tab.rows.reduce((h, r) => h + r.height, 0)));
    row.height = Math.min(12, tallest + 1);
  };
  const fill = () => {
    for (const t of live) t.tab.rows.push(...t.plan.rows!(t.upNext));
    size();
  };
  /** Rows added to a tab after everything else is built (so every earlier id keeps its number). */
  const extend = (title: string, ...rows: DashRow[]) => {
    live.find((t) => t.tab.title === title)!.tab.rows.push(...rows);
    size();
  };
  return { row, fill, extend };
}

function workspaceRow(b: Builder): DashRow {
  return b.row(4, b.slot(12, b.w('workspace-boards', 'L')));
}

function sendRow(b: Builder): DashRow {
  return b.row(3, b.slot(12, b.w('send-to-agent', 'M')));
}

// Tab rows: height 4 for M rows, 5 for rows holding an L widget; at most 3 rows per tab. No tab
// repeats a kpi from the template's top KPI row. Every tab holds at least ~60% of the tallest tab's
// units: the row is sized for the tallest, so a much shorter tab would leave the frame mostly empty.

function deliveryLead(workspace: boolean): DashboardLayout {
  const b = builder('dl');
  const { line } = b;
  const top = b.row(4, b.slot(6, b.w('now-building', 'M')), b.slot(6, b.w('active-agents', 'M')));
  const kpis = kpiRow(b);
  const ws = workspace ? [workspaceRow(b)] : [];
  const tabs = tabsRow(b, [
    {
      title: 'Needs you',
      ids: 6,
      upNext: true,
      rows: (upNext) => [b.row(4, upNext!, b.slot(6, b.w('review-queue', 'M'))), line(4, ['escalation', 'M', 6], ['gate-readiness', 'M', 6])],
    },
    {
      title: 'Delivery',
      ids: 6,
      rows: () => [
        line(5, ['phase-health', 'L', 8], ['forecast', 'M', 4]),
        line(4, ['milestones', 'M', 4], ['scope-change', 'M', 4], ['planned-delivered', 'M', 4]),
      ],
    },
    { title: 'Flow', ids: 6, rows: () => [line(5, ['throughput-trend', 'L', 8], ['wip', 'M', 4]), line(5, ['cycle-breakdown', 'L', 12])] },
    { title: 'Spend', ids: 6, rows: () => [line(4, ['ai-spend', 'M', 6], ['investment-mix', 'M', 6]), line(5, ['budget-burn', 'L', 12])] },
    {
      title: 'Quality and risk',
      ids: 4,
      rows: () => [line(4, ['quality', 'M', 6], ['speed-stability', 'M', 6]), line(5, ['top-risks', 'L', 8], ['rag-trend', 'M', 4])],
    },
  ]);
  const section = b.section('Overview', top, kpis, ...ws, tabs.row, sendRow(b));
  tabs.fill();
  return { version: 1, sections: [section] };
}

/** Delivery, spend and risk at a glance: no flow detail (review queue, WIP, cycle time). */
function execRollup(workspace: boolean): DashboardLayout {
  const b = builder('ex');
  const { line } = b;
  const kpis = kpiRow(b);
  const ws = workspace ? [workspaceRow(b)] : [];
  const tabs = tabsRow(b, [
    { title: 'Needs you', ids: 6, rows: null },
    { title: 'Delivery', ids: 6, rows: () => [line(4, ['forecast', 'M', 6], ['milestones', 'M', 6]), line(4, ['scope-change', 'M', 6], ['planned-delivered', 'M', 6])] },
    { title: 'Flow', ids: 6, rows: null },
    { title: 'Spend', ids: 6, rows: () => [line(4, ['ai-spend', 'M', 6], ['investment-mix', 'M', 6]), line(5, ['budget-burn', 'L', 12])] },
    { title: 'Quality and risk', ids: 4, rows: () => [line(5, ['top-risks', 'L', 8], ['quality', 'M', 4])] },
  ]);
  const section = b.section('Overview', kpis, ...ws, tabs.row);
  tabs.fill();
  // built last so the existing ex- ids keep their numbers; placed right after the KPI row
  section.rows.splice(1, 0, line(5, ['phase-health', 'L', 8], ['rag-trend', 'M', 4]));
  tabs.extend('Quality and risk', line(4, ['speed-stability', 'M', 12])); // 5 → 9 units (Spend: 9)
  return { version: 1, sections: [section] };
}

/** Agent-focused: flow and quality. */
function agentOps(): DashboardLayout {
  const b = builder('ao');
  const { line } = b;
  const rows = [
    b.row(4, b.slot(8, b.w('active-agents', 'L')), b.slot(4, b.w('now-building', 'M'))),
    b.row(4, b.slot(12, b.w('up-next', 'M'))),
    sendRow(b),
  ];
  const overview = b.section('Overview', ...rows);
  // Tabs built last so the existing ao- ids keep their numbers; placed before send-to-agent.
  const tabs = tabsRow(b, [
    { title: 'Needs you', ids: 6, rows: () => [line(4, ['review-queue', 'M', 6], ['escalation', 'M', 6])] },
    { title: 'Flow', ids: 6, rows: () => [line(5, ['throughput-trend', 'L', 8], ['wip', 'M', 4]), line(5, ['cycle-breakdown', 'L', 12])] },
    { title: 'Spend', ids: 6, rows: null },
    { title: 'Quality', ids: 4, rows: () => [line(5, ['quality', 'L', 12])] },
  ]);
  overview.rows.splice(2, 0, tabs.row);
  tabs.fill();
  // balance against Flow (10 units): Needs you 4 → 8 (the gate and the risks are human calls), Quality 5 → 9
  tabs.extend('Needs you', line(4, ['gate-readiness', 'M', 6], ['top-risks', 'M', 6]));
  tabs.extend('Quality', line(4, ['speed-stability', 'M', 12]));
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
