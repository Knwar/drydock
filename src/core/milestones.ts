import type { DB } from './db.js';
import { isIsoDate, now, shortId } from './board.js';
import { GovernanceError, projectScope, workspaceOf, type Listed, type Scope } from './decisions.js';

// ── milestones: dated markers on a board's roadmap, optionally tied to a phase ──
//
// Like decisions/risks, a milestone belongs to one board (project_id); listing a
// workspace includes its verticals', listing a vertical includes its workspace's.
// Errors reuse GovernanceError: code 'not_found' → 404, anything else → 400.

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  date: string; // YYYY-MM-DD
  phase_id: string | null;
  created_at: number;
  updated_at: number;
}

type Input = Record<string, unknown>;

const invalid = (message: string) => new GovernanceError('invalid', message);
const notFound = (message: string) => new GovernanceError('not_found', message);

function asObject(input: unknown): Input {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('body must be an object');
  return input as Input;
}

function title(b: Input): string {
  if (typeof b.title !== 'string' || !b.title.trim()) throw invalid('title (non-empty string) required');
  return b.title.trim();
}

function date(b: Input): string {
  if (!isIsoDate(b.date)) throw invalid('date (YYYY-MM-DD) required');
  return b.date;
}

/** A phase_id must name a phase in the milestone's workspace; null clears it. */
function phaseId(db: DB, b: Input, projectId: string): string | null {
  const v = b.phase_id;
  if (v === null) return null;
  if (typeof v !== 'string' || !v) throw invalid('phase_id must be a phase id or null');
  const row = db.prepare('SELECT project_id FROM phases WHERE id = ?').get(v) as { project_id: string } | undefined;
  if (!row) throw notFound(`no such phase: ${v}`);
  if (workspaceOf(db, row.project_id) !== workspaceOf(db, projectId)) throw invalid(`phase ${v} is in another workspace`);
  return v;
}

export function getMilestone(db: DB, id: string): Milestone {
  const row = db.prepare('SELECT * FROM milestones WHERE id = ?').get(id) as Milestone | undefined;
  if (!row) throw notFound(`no such milestone: ${id}`);
  return row;
}

/** Add a milestone: {project_id, title, date, phase_id?}. */
export function createMilestone(db: DB, input: unknown): Milestone {
  const b = asObject(input);
  if (typeof b.project_id !== 'string' || !b.project_id) throw invalid('project_id (string) required');
  const projectId = b.project_id;
  workspaceOf(db, projectId);
  const t = now();
  const row: Milestone = {
    id: shortId(),
    project_id: projectId,
    title: title(b),
    date: date(b),
    phase_id: b.phase_id === undefined ? null : phaseId(db, b, projectId),
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    'INSERT INTO milestones (id, project_id, title, date, phase_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.project_id, row.title, row.date, row.phase_id, row.created_at, row.updated_at);
  return row;
}

/** Patch a milestone's title, date and/or phase_id (null unlinks). */
export function updateMilestone(db: DB, id: string, input: unknown): Milestone {
  const b = asObject(input);
  const current = getMilestone(db, id);
  const next = {
    title: b.title === undefined ? current.title : title(b),
    date: b.date === undefined ? current.date : date(b),
    phase_id: b.phase_id === undefined ? current.phase_id : phaseId(db, b, current.project_id),
  };
  db.prepare('UPDATE milestones SET title = ?, date = ?, phase_id = ?, updated_at = ? WHERE id = ?').run(
    next.title,
    next.date,
    next.phase_id,
    now(),
    id,
  );
  return getMilestone(db, id);
}

export function deleteMilestone(db: DB, id: string): Milestone {
  const current = getMilestone(db, id);
  db.prepare('DELETE FROM milestones WHERE id = ?').run(id);
  return current;
}

/** Milestones of a project plus its workspace's / verticals', each tagged with its scope; soonest first. */
export function listMilestones(db: DB, projectId: string): Listed<Milestone>[] {
  const scope: Map<string, Scope> = projectScope(db, projectId);
  const ids = [...scope.keys()];
  const rows = db
    .prepare(
      `SELECT * FROM milestones WHERE project_id IN (${ids.map(() => '?').join(', ')}) ORDER BY date, created_at, rowid`,
    )
    .all(...ids) as Milestone[];
  return rows.map((r) => ({ ...r, scope: scope.get(r.project_id)! }));
}
