// Project summaries for Home and the sidebar tree: the kankanban board data
// (phases, cards, verticals) plus AI Brain's lifecycle stage.
import type { DB } from '../core/db.js';
import { addMissingColumns, defineSchema } from './schema.js';
import { isType, projectPlugins, type ProjectType } from './plugins.js';

export const STAGES = ['idea', 'create', 'requirements', 'design', 'plan', 'build'] as const;
export type Stage = (typeof STAGES)[number];

defineSchema(`
CREATE TABLE IF NOT EXISTS brain_projects (
  project_id  TEXT PRIMARY KEY,
  stage       TEXT NOT NULL DEFAULT 'idea',
  description TEXT,
  repo_url    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`, (db) => addMissingColumns(db, 'brain_projects', { type: "TEXT NOT NULL DEFAULT 'software'", plugins: 'TEXT', origin: "TEXT NOT NULL DEFAULT 'new'" }));

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  stage: Stage;
  description: string | null;
  verticals: { id: string; name: string; done: number; total: number }[];
  containers: { id: string; name: string; components: number }[];
  phase: { index: number; count: number; title: string } | null;
  cards: { done: number; total: number };
  liveAgents: number;
  blocked: number;
  inReview: number;
  status: string;
  rag: string | null;
  type: ProjectType;
  plugins: string[];
  origin: 'new' | 'imported';
}

interface Row {
  id: string;
  name: string;
  root_path: string;
  parent_id: string | null;
  stage: string | null;
  description: string | null;
}

/** A project without an explicit stage gets one from its board: cards → build, phases → plan. */
function derivedStage(db: DB, ids: string[]): Stage {
  const q = (sql: string) => (db.prepare(sql.replace('$IDS', ids.map(() => '?').join(','))).get(...ids) as { n: number }).n;
  if (q('SELECT COUNT(*) AS n FROM tasks WHERE project_id IN ($IDS)') > 0) return 'build';
  if (q('SELECT COUNT(*) AS n FROM phases WHERE project_id IN ($IDS)') > 0) return 'plan';
  return 'idea';
}

export function setStage(db: DB, projectId: string, stage: Stage, description?: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO brain_projects (project_id, stage, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET stage = excluded.stage,
       description = COALESCE(excluded.description, brain_projects.description), updated_at = excluded.updated_at`,
  ).run(projectId, stage, description ?? null, now, now);
}

export function listProjects(db: DB, insideRoot: string | null): ProjectSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.root_path, p.parent_id, b.stage, b.description, b.*
       FROM projects p LEFT JOIN brain_projects b ON b.project_id = p.id
       ORDER BY p.created_at DESC`,
    )
    .all() as Row[];
  const children = new Map<string, Row[]>();
  for (const r of rows) if (r.parent_id) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);

  const lane = db.prepare(
    `SELECT COUNT(*) AS total, SUM(lane = 'done') AS done, SUM(lane = 'in_progress' AND assigned_agent IS NOT NULL) AS live,
            SUM(blocked_at IS NOT NULL AND lane != 'done') AS blocked, SUM(lane = 'in_review') AS review
     FROM tasks WHERE project_id = ? AND (? IS NULL OR phase_id = ?)`,
  );
  const phasesOf = db.prepare(`SELECT id, title, status FROM phases WHERE project_id = ? ORDER BY position`);
  const hasDesign = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'design_elements'`).get());
  const containersOf = hasDesign
    ? db.prepare(
        `SELECT e.id, e.name, (SELECT COUNT(*) FROM design_elements c WHERE c.project_id = e.project_id AND c.parent_id = e.id) AS components
         FROM design_elements e WHERE e.project_id = ? AND e.parent_id IS NULL AND e.kind = 'container' ORDER BY e.position, e.id`,
      )
    : null;

  return rows
    .filter((r) => r.parent_id === null)
    .filter((r) => insideRoot === null || r.root_path === insideRoot || r.root_path.startsWith(insideRoot + '/'))
    .map((r) => {
      const ids = [r.id, ...(children.get(r.id) ?? []).map((c) => c.id)];
      const phases = phasesOf.all(r.id) as { id: string; title: string; status: string }[];
      const activeIdx = phases.findIndex((p) => p.status === 'active');
      const active = activeIdx >= 0 ? phases[activeIdx] : null;
      let done = 0;
      let total = 0;
      let live = 0;
      let blocked = 0;
      let inReview = 0;
      for (const id of ids) {
        // a workspace's own phase scopes its own board; vertical boards count whole
        const phaseId = id === r.id && active ? active.id : null;
        const c = lane.get(id, phaseId, phaseId) as { total: number; done: number | null; live: number | null; blocked: number | null; review: number | null };
        total += c.total;
        done += c.done ?? 0;
        live += c.live ?? 0;
        blocked += c.blocked ?? 0;
        inReview += c.review ?? 0;
      }
      const verticals = (children.get(r.id) ?? []).map((v) => {
        const c = lane.get(v.id, null, null) as { total: number; done: number | null };
        return { id: v.id, name: v.name, done: c.done ?? 0, total: c.total };
      });
      return {
        id: r.id,
        name: r.name,
        root: r.root_path,
        stage: (STAGES as readonly string[]).includes(r.stage ?? '') ? (r.stage as Stage) : derivedStage(db, ids),
        description: r.description,
        verticals,
        containers: (containersOf?.all(r.id) as { id: string; name: string; components: number }[]) ?? [],
        phase: active ? { index: activeIdx + 1, count: phases.length, title: active.title } : null,
        cards: { done, total },
        liveAgents: live,
        blocked,
        inReview,
        status: (r as any).status ?? 'active',
        rag: (r as any).rag ?? null,
        type: isType((r as any).type) ? (r as any).type : 'software',
        plugins: projectPlugins(db, r.id),
        origin: (r as any).origin === 'imported' ? 'imported' : 'new',
      };
    });
}
