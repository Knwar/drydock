import { relative, sep } from 'node:path';
import type { DB } from './db.js';
import { getWorkspace, now, shortId } from './board.js';
import {
  PLAN_TAGS,
  type DraftOp,
  type PlanContext,
  type PlanData,
  type PlanDraft,
  type PlanDraftSummary,
  type PlanNode,
  type Project,
} from './types.js';

// ── plan drafts: workspace-wide visual plans kept off the board until committed ──
//
// A draft belongs to a top-level project (a workspace or a standalone project);
// each node picks its own board. Edits arrive as op batches applied atomically.
// Ops enforce structural sanity (unique ids, edges between existing nodes) but
// deliberately NOT acyclicity — validatePlan (plan-graph.ts) reports cycles.

/** A draft operation or lookup failed; nothing was changed. */
export class DraftError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
  }
}

interface DraftRow extends Omit<PlanDraft, 'data'> {
  data: string;
}

/** Parse stored data defensively: bad JSON or wrong-typed fields → DraftError('corrupt'); missing keys default to empty. */
function toDraft(row: DraftRow): PlanDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(row.data);
  } catch {
    throw new DraftError('corrupt', `draft ${row.id} has unreadable data`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new DraftError('corrupt', `draft ${row.id} data is not an object`);
  const { nodes = [], edges = [], committed = {} } = raw as Partial<PlanData>;
  if (!Array.isArray(nodes) || !Array.isArray(edges))
    throw new DraftError('corrupt', `draft ${row.id} nodes/edges must be arrays`);
  if (typeof committed !== 'object' || committed === null || Array.isArray(committed))
    throw new DraftError('corrupt', `draft ${row.id} committed must be an object`);
  return { ...row, data: { ...(raw as PlanData), nodes, edges, committed } };
}

function emptyData(): PlanData {
  return { nodes: [], edges: [], committed: {} };
}

const OPTIONAL_STRING = ['requirements', 'phase'] as const;
const OPTIONAL_STRING_ARRAY = ['subtasks', 'touches'] as const;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** Check a node's field types and copy only known fields. Title may be empty (validation reports it). */
function cleanNode(input: unknown): PlanNode {
  if (typeof input !== 'object' || input === null) throw new DraftError('invalid_node', 'node must be an object');
  const n = input as Record<string, unknown>;
  if (typeof n.id !== 'string' || !n.id) throw new DraftError('invalid_node', 'node id must be a non-empty string');
  if (typeof n.title !== 'string') throw new DraftError('invalid_node', `node "${n.id}": title must be a string`);
  if (typeof n.board_id !== 'string') throw new DraftError('invalid_node', `node "${n.id}": board_id must be a string`);
  const node: PlanNode = { id: n.id, title: n.title, board_id: n.board_id };
  for (const k of OPTIONAL_STRING) {
    if (n[k] === undefined || n[k] === null) continue;
    if (typeof n[k] !== 'string') throw new DraftError('invalid_node', `node "${n.id}": ${k} must be a string`);
    node[k] = n[k] as string;
  }
  for (const k of OPTIONAL_STRING_ARRAY) {
    if (n[k] === undefined || n[k] === null) continue;
    if (!isStringArray(n[k])) throw new DraftError('invalid_node', `node "${n.id}": ${k} must be a string array`);
    node[k] = [...(n[k] as string[])];
  }
  if (n.tag !== undefined && n.tag !== null) {
    if (!PLAN_TAGS.includes(n.tag as PlanNode['tag'] & string))
      throw new DraftError('invalid_node', `node "${n.id}": tag must be one of ${PLAN_TAGS.join('|')}`);
    node.tag = n.tag as PlanNode['tag'];
  }
  return node;
}

/** Apply one op to `data` in place (callers work on a copy). Returns a new title for set_title. */
function applyOp(data: PlanData, op: DraftOp): string | undefined {
  const findNode = (id: string) => {
    const i = data.nodes.findIndex((n) => n.id === id);
    if (i < 0) throw new DraftError('unknown_node', `no such node: ${id}`);
    return i;
  };
  switch (op?.op) {
    case 'add_node': {
      const node = cleanNode(op.node);
      if (data.nodes.some((n) => n.id === node.id))
        throw new DraftError('duplicate_node', `node id already exists: ${node.id}`);
      data.nodes.push(node);
      return;
    }
    case 'update_node': {
      const i = findNode(op.id);
      const patch = (op.patch ?? {}) as Record<string, unknown>;
      if ('id' in patch && patch.id !== op.id) throw new DraftError('invalid_op', 'update_node cannot change a node id');
      const merged: Record<string, unknown> = { ...data.nodes[i], ...patch, id: op.id };
      data.nodes[i] = cleanNode(merged); // null clears an optional field
      return;
    }
    case 'remove_node': {
      const i = findNode(op.id);
      data.nodes.splice(i, 1);
      data.edges = data.edges.filter((e) => e.from !== op.id && e.to !== op.id);
      return;
    }
    case 'add_edge': {
      const { from, to } = op;
      findNode(from);
      findNode(to);
      if (from === to) throw new DraftError('self_loop', `a node cannot depend on itself: ${from}`);
      if (data.edges.some((e) => e.from === from && e.to === to))
        throw new DraftError('duplicate_edge', `edge already exists: ${from} -> ${to}`);
      data.edges.push({ from, to });
      return;
    }
    case 'remove_edge': {
      const i = data.edges.findIndex((e) => e.from === op.from && e.to === op.to);
      if (i < 0) throw new DraftError('unknown_edge', `no such edge: ${op.from} -> ${op.to}`);
      data.edges.splice(i, 1);
      return;
    }
    case 'set_title': {
      if (typeof op.title !== 'string' || !op.title.trim())
        throw new DraftError('invalid_op', 'draft title must be a non-empty string');
      return op.title.trim();
    }
    default:
      throw new DraftError('invalid_op', `unknown op: ${JSON.stringify((op as { op?: unknown })?.op)}`);
  }
}

function requireTopLevel(db: DB, workspaceId: string): Project {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(workspaceId) as Project | undefined;
  if (!project) throw new DraftError('not_found', `no such project: ${workspaceId}`);
  if (project.parent_id !== null)
    throw new DraftError('vertical', `project ${workspaceId} is a vertical; drafts belong to its workspace`);
  return project;
}

/**
 * Create a draft on a top-level project. Optional initial nodes/edges go through
 * the same checks as ops. `committed` always starts empty (only commit writes it).
 */
export function createDraft(
  db: DB,
  workspaceId: string,
  title: string,
  data?: Partial<Pick<PlanData, 'nodes' | 'edges'>>,
): PlanDraft {
  return db.transaction(() => {
    requireTopLevel(db, workspaceId);
    if (typeof title !== 'string' || !title.trim()) throw new DraftError('invalid_op', 'draft title must be a non-empty string');
    const d = emptyData();
    for (const node of data?.nodes ?? []) applyOp(d, { op: 'add_node', node });
    for (const e of data?.edges ?? []) applyOp(d, { op: 'add_edge', from: e.from, to: e.to });
    const ts = now();
    const draft: PlanDraft = {
      id: shortId(),
      workspace_id: workspaceId,
      title: title.trim(),
      version: 1,
      data: d,
      committed_version: null,
      committed_at: null,
      created_at: ts,
      updated_at: ts,
    };
    db.prepare(
      `INSERT INTO plan_drafts (id, workspace_id, title, version, data, committed_version, committed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(draft.id, draft.workspace_id, draft.title, draft.version, JSON.stringify(d), null, null, ts, ts);
    return draft;
  })();
}

/** A draft with its data, or null. */
export function getDraft(db: DB, id: string): PlanDraft | null {
  const row = db.prepare('SELECT * FROM plan_drafts WHERE id = ?').get(id) as DraftRow | undefined;
  return row ? toDraft(row) : null;
}

/** A workspace's drafts without their data (node/edge counts instead), most recently updated first. */
export function listDrafts(db: DB, workspaceId: string): PlanDraftSummary[] {
  return db
    .prepare(
      `SELECT id, workspace_id, title, version, committed_version, committed_at, created_at, updated_at,
              json_array_length(data, '$.nodes') AS node_count,
              json_array_length(data, '$.edges') AS edge_count
       FROM plan_drafts WHERE workspace_id = ? ORDER BY updated_at DESC, rowid DESC`,
    )
    .all(workspaceId) as PlanDraftSummary[];
}

/** Remove a draft; returns whether a row was deleted. */
export function deleteDraft(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM plan_drafts WHERE id = ?').run(id).changes > 0;
}

/** Rename a draft (a set_title op: bumps version). */
export function renameDraft(db: DB, id: string, title: string): PlanDraft {
  return applyDraftOps(db, id, [{ op: 'set_title', title }]);
}

/**
 * Apply an ops batch atomically and bump `version` once. Any invalid op throws
 * a DraftError and the draft is left exactly as it was.
 */
export function applyDraftOps(db: DB, id: string, ops: DraftOp[]): PlanDraft {
  return db.transaction(() => {
    const draft = getDraft(db, id);
    if (!draft) throw new DraftError('not_found', `no such draft: ${id}`);
    if (!Array.isArray(ops)) throw new DraftError('invalid_op', 'ops must be an array');
    const data = structuredClone(draft.data);
    let title = draft.title;
    for (const op of ops) title = applyOp(data, op) ?? title;
    const updated: PlanDraft = { ...draft, title, data, version: draft.version + 1, updated_at: now() };
    db.prepare('UPDATE plan_drafts SET title = ?, data = ?, version = ?, updated_at = ? WHERE id = ?').run(
      updated.title,
      JSON.stringify(data),
      updated.version,
      updated.updated_at,
      id,
    );
    return updated;
  })();
}

/** validatePlan's ctx: the workspace board (root '') + its verticals, roots relative to the workspace root. */
export function draftContext(db: DB, workspaceId: string): PlanContext {
  const workspace = requireTopLevel(db, workspaceId);
  const { verticals } = getWorkspace(db, workspace.id);
  return {
    boards: [
      { id: workspace.id, name: workspace.name, root: '' },
      ...verticals.map((v) => ({
        id: v.id,
        name: v.name,
        root: relative(workspace.root_path, v.root_path).split(sep).join('/'),
      })),
    ],
  };
}
