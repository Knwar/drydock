import { relative, sep } from 'node:path';
import type { DB } from './db.js';
import {
  createPhase,
  createTask,
  deleteTask,
  getActivePhase,
  getTask,
  getWorkspace,
  moveTask,
  now,
  relocateCardHistory,
  setAutopilot,
  setSubtasks,
  shortId,
  updateTask,
} from './board.js';
import { layoutColumns, validatePlan } from './plan-graph.js';
import {
  PLAN_TAGS,
  type DraftOp,
  type Lane,
  type Phase,
  type PlanContext,
  type PlanData,
  type PlanDraft,
  type PlanDraftSummary,
  type PlanIssue,
  type PlanNode,
  type Project,
  type Subtask,
  type Task,
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

/** Commit/run refused (409): a stale version, validation errors, or a draft that isn't committed/clean. */
export class DraftConflict extends DraftError {
  errors?: PlanIssue[];
  version?: number;
  constructor(code: string, message: string, extra: { errors?: PlanIssue[]; version?: number } = {}) {
    super(code, message);
    this.name = 'DraftConflict';
    this.errors = extra.errors;
    this.version = extra.version;
  }
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

// ── commit: turn a draft into board state ──
//
// Each node commits onto its own board; `committed` maps node → card. Only
// unblocked backlog/queued cards are editable: a started, done or blocked card is
// never changed, moved or deleted by a commit (it's reported as locked or kept
// instead). Phases match by trimmed name per board (new names are appended). A node without a
// phase leaves its card's phase alone (a new/moved card goes to the board's
// active phase, else its first planned one, so it can be picked).

export type DiffField = 'title' | 'requirements' | 'subtasks' | 'tag' | 'phase' | 'depends_on' | 'board';

export interface DiffUpdate {
  node_id: string;
  card_id: string;
  title: string;
  /** Only the fields that change. depends_on is in node ids (plan-internal deps only). */
  changes: Partial<Record<DiffField, { from: unknown; to: unknown }>>;
}

export interface BoardDiff {
  board_id: string;
  /** New phases, appended after the board's existing ones in this order. */
  phases: { name: string; position: number }[];
  create: { node_id: string; title: string; phase: string | null }[];
  update: DiffUpdate[];
  /** Removed nodes whose card is still in backlog/queued (and not blocked). */
  delete: { node_id: string; card_id: string; title: string }[];
  /** Removed nodes whose card has started or is done: left on the board. */
  kept: { node_id: string; card_id: string; title: string; lane: Lane; note: string }[];
  /**
   * Cards a commit won't touch: nodes that differ from a started/done card
   * (reason 'started'), or nodes that differ from or were removed while their card
   * is blocked (reason 'blocked'; `fields` is empty for a removed node).
   */
  locked: { node_id: string; card_id: string; title: string; lane: Lane; fields: DiffField[]; reason: LockReason }[];
}

export interface DraftDiff {
  draft_id: string;
  version: number;
  /** validatePlan errors: they block commit. */
  errors: PlanIssue[];
  /** Boards with something to do, in workspace board order. */
  boards: BoardDiff[];
}

export interface CommitResult {
  draft: PlanDraft;
  diff: DraftDiff;
  /** Cards created or changed (incl. depends_on), to announce. */
  touched: string[];
  deleted: { id: string; title: string; project_id: string; unblocked: string[] }[];
  moved: { id: string; from: string; to: string }[];
  /** Boards whose phases or phase progress changed. */
  boards: string[];
}

export type LockReason = 'started' | 'blocked';

const EDITABLE: readonly Lane[] = ['backlog', 'queued'];
/** Why a commit may not change/move/delete this card, or null if it may. */
const lockOf = (t: Task): LockReason | null => (t.blocked_at ? 'blocked' : EDITABLE.includes(t.lane) ? null : 'started');
const KEPT_NOTE = 'kept, no longer in plan';

const reqOf = (n: PlanNode): string | null => (n.requirements && n.requirements.trim() ? n.requirements : null);
const phaseOf = (n: PlanNode): string | null => n.phase?.trim() || null;
const depsOf = (t: Task): string[] => (t.depends_on ? (JSON.parse(t.depends_on) as string[]) : []);
const subsOf = (t: Task): Subtask[] => (t.subtasks ? (JSON.parse(t.subtasks) as Subtask[]) : []);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a: string[], b: string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

interface CommitPlan {
  diff: DraftDiff;
  order: PlanNode[]; // current nodes in column order (stable by node order)
  live: Map<string, Task>; // node → its live mapped card (current nodes only)
  creates: Set<string>;
  updates: Map<string, DiffField[]>;
  deletes: Task[];
  planCards: Set<string>; // every live card this draft has committed (incl. removed nodes)
  cardToNode: Map<string, string>;
}

function boardPhases(db: DB, boardId: string): Phase[] {
  return db.prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position').all(boardId) as Phase[];
}

/** Everything a commit would do, computed from the draft and the live board (read-only). */
function planCommit(db: DB, draft: PlanDraft): CommitPlan {
  const { nodes, edges, committed } = draft.data;
  const ctx = draftContext(db, draft.workspace_id);
  const { errors } = validatePlan(draft.data, ctx);

  const cols = layoutColumns(nodes, edges);
  const order = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (cols?.[a.n.id] ?? 0) - (cols?.[b.n.id] ?? 0) || a.i - b.i)
    .map((x) => x.n);

  const cardById = (id: string) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  const phaseTitle = (id: string | null) =>
    id ? ((db.prepare('SELECT title FROM phases WHERE id = ?').get(id) as { title: string } | undefined)?.title.trim() ?? null) : null;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const planCards = new Set<string>();
  const cardToNode = new Map<string, string>();
  const liveAll = new Map<string, Task>();
  for (const [nodeId, cardId] of Object.entries(committed)) {
    const card = cardById(cardId);
    if (!card) continue; // deleted elsewhere: the node (if still present) is created again
    liveAll.set(nodeId, card);
    planCards.add(card.id);
    cardToNode.set(card.id, nodeId);
  }
  const live = new Map([...liveAll].filter(([nodeId]) => nodeIds.has(nodeId)));

  const byBoard = new Map<string, BoardDiff>();
  const boardDiff = (id: string) => {
    let b = byBoard.get(id);
    if (!b) {
      b = { board_id: id, phases: [], create: [], update: [], delete: [], kept: [], locked: [] };
      byBoard.set(id, b);
    }
    return b;
  };

  const creates = new Set<string>();
  const updates = new Map<string, DiffField[]>();
  for (const n of order) {
    const card = live.get(n.id);
    if (!card) {
      creates.add(n.id);
      boardDiff(n.board_id).create.push({ node_id: n.id, title: n.title, phase: phaseOf(n) });
      continue;
    }
    const changes: DiffUpdate['changes'] = {};
    if (card.title !== n.title) changes.title = { from: card.title, to: n.title };
    if (card.requirements !== reqOf(n)) changes.requirements = { from: card.requirements, to: reqOf(n) };
    const texts = subsOf(card).map((s) => s.text);
    if (!sameList(texts, n.subtasks ?? [])) changes.subtasks = { from: texts, to: n.subtasks ?? [] };
    if ((card.tag ?? null) !== (n.tag ?? null)) changes.tag = { from: card.tag, to: n.tag ?? null };
    const phase = phaseOf(n);
    const current = phaseTitle(card.phase_id);
    if (phase !== null && phase !== current) changes.phase = { from: current, to: phase };
    const deps = depsOf(card).filter((id) => planCards.has(id)).map((id) => cardToNode.get(id)!);
    const want = [...new Set(edges.filter((e) => e.to === n.id && nodeIds.has(e.from)).map((e) => e.from))];
    if (!sameSet(deps, want)) changes.depends_on = { from: deps, to: want };
    if (card.project_id !== n.board_id) changes.board = { from: card.project_id, to: n.board_id };
    const fields = Object.keys(changes) as DiffField[];
    if (!fields.length) continue;
    const reason = lockOf(card);
    if (!reason) {
      updates.set(n.id, fields);
      boardDiff(n.board_id).update.push({ node_id: n.id, card_id: card.id, title: n.title, changes });
    } else {
      boardDiff(card.project_id).locked.push({ node_id: n.id, card_id: card.id, title: card.title, lane: card.lane, fields, reason });
    }
  }

  const deletes: Task[] = [];
  for (const [nodeId, card] of liveAll) {
    if (nodeIds.has(nodeId)) continue;
    const reason = lockOf(card);
    if (!reason) {
      deletes.push(card);
      boardDiff(card.project_id).delete.push({ node_id: nodeId, card_id: card.id, title: card.title });
    } else if (reason === 'blocked') {
      boardDiff(card.project_id).locked.push({ node_id: nodeId, card_id: card.id, title: card.title, lane: card.lane, fields: [], reason });
    } else {
      boardDiff(card.project_id).kept.push({ node_id: nodeId, card_id: card.id, title: card.title, lane: card.lane, note: KEPT_NOTE });
    }
  }

  // New phases: names that created/re-phased/moved cards need but their board lacks, first appearance in column order.
  const known = new Map<string, Set<string>>();
  const nextPos = new Map<string, number>();
  for (const n of order) {
    const name = phaseOf(n);
    const fields = updates.get(n.id);
    if (!name || !(creates.has(n.id) || fields?.includes('phase') || fields?.includes('board'))) continue;
    if (!known.has(n.board_id)) {
      const existing = boardPhases(db, n.board_id);
      known.set(n.board_id, new Set(existing.map((p) => p.title.trim())));
      nextPos.set(n.board_id, existing.reduce((m, p) => Math.max(m, p.position), 0));
    }
    const names = known.get(n.board_id)!;
    if (names.has(name)) continue;
    names.add(name);
    const position = nextPos.get(n.board_id)! + 1;
    nextPos.set(n.board_id, position);
    boardDiff(n.board_id).phases.push({ name, position });
  }

  const rank = new Map(ctx.boards.map((b, i) => [b.id, i]));
  const boards = [...byBoard.values()].sort(
    (a, b) => (rank.get(a.board_id) ?? Infinity) - (rank.get(b.board_id) ?? Infinity),
  );
  return {
    diff: { draft_id: draft.id, version: draft.version, errors, boards },
    order,
    live,
    creates,
    updates,
    deletes,
    planCards,
    cardToNode,
  };
}

/** Dry run: what commitDraft would do, per board, plus the validation errors that would block it. */
export function diffDraft(db: DB, id: string): DraftDiff {
  const draft = getDraft(db, id);
  if (!draft) throw new DraftError('not_found', `no such draft: ${id}`);
  return planCommit(db, draft).diff;
}

/** The board's home phase for a phaseless card: its active phase, else its first planned one. */
function homePhase(db: DB, boardId: string): string | null {
  const home =
    getActivePhase(db, boardId) ??
    (db
      .prepare(`SELECT * FROM phases WHERE project_id = ? AND status = 'planned' ORDER BY position LIMIT 1`)
      .get(boardId) as Phase | undefined);
  return home?.id ?? null;
}

/**
 * Apply a draft to the boards in ONE transaction (all or nothing). Refuses with
 * a DraftConflict on a stale `expectedVersion` or validation errors. External
 * depends_on entries (cards outside this plan) are preserved.
 */
export function commitDraft(db: DB, id: string, expectedVersion: number): CommitResult {
  return db.transaction((): CommitResult => {
    const draft = getDraft(db, id);
    if (!draft) throw new DraftError('not_found', `no such draft: ${id}`);
    if (draft.version !== expectedVersion)
      throw new DraftConflict('stale', `draft is at version ${draft.version}, not ${expectedVersion}`, {
        version: draft.version,
      });
    const plan = planCommit(db, draft);
    if (plan.diff.errors.length)
      throw new DraftConflict('invalid_plan', 'the plan has validation errors', { errors: plan.diff.errors });
    const { edges } = draft.data;

    const touched = new Set<string>();
    const boards = new Set<string>();
    const moved: CommitResult['moved'] = [];

    // phases: existing by trimmed name (first by position), then the new ones appended
    const phaseIds = new Map<string, string>();
    const phaseKey = (board: string, name: string) => `${board}\u0000${name}`;
    for (const b of plan.diff.boards) {
      for (const p of boardPhases(db, b.board_id).reverse()) phaseIds.set(phaseKey(b.board_id, p.title.trim()), p.id);
      for (const p of b.phases) {
        phaseIds.set(phaseKey(b.board_id, p.name), createPhase(db, b.board_id, p.name).id);
        boards.add(b.board_id);
      }
    }
    const phaseFor = (n: PlanNode) => {
      const name = phaseOf(n);
      return name ? phaseIds.get(phaseKey(n.board_id, name))! : homePhase(db, n.board_id);
    };

    const deleted = plan.deletes.map((card) => {
      boards.add(card.project_id);
      return deleteTask(db, card.id);
    });

    const cardOf = new Map([...plan.live].map(([nodeId, card]) => [nodeId, card.id]));
    for (const n of plan.order) {
      if (plan.creates.has(n.id)) {
        const card = createTask(db, n.board_id, n.title, {
          tag: n.tag,
          requirements: reqOf(n) ?? undefined,
          phase_id: phaseFor(n) ?? undefined,
        });
        if (n.subtasks?.length) setSubtasks(db, card.id, n.subtasks);
        cardOf.set(n.id, card.id);
        touched.add(card.id);
        boards.add(n.board_id);
        continue;
      }
      const fields = plan.updates.get(n.id);
      if (!fields) continue;
      const card = plan.live.get(n.id)!;
      touched.add(card.id);
      if (fields.includes('title'))
        db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?').run(n.title, now(), card.id);
      const patch: Parameters<typeof updateTask>[2] = {};
      if (fields.includes('requirements')) patch.requirements = reqOf(n);
      if (fields.includes('tag')) patch.tag = n.tag ?? null;
      if (Object.keys(patch).length) updateTask(db, card.id, patch);
      if (fields.includes('subtasks')) {
        const done = new Map(subsOf(card).map((s) => [s.text, s.done]));
        setSubtasks(db, card.id, (n.subtasks ?? []).map((text) => ({ text, done: done.get(text) ?? false })));
      }
      if (fields.includes('board')) {
        const { max } = db.prepare('SELECT MAX(position) AS max FROM tasks WHERE project_id = ?').get(n.board_id) as {
          max: number | null;
        };
        db.prepare('UPDATE tasks SET project_id = ?, phase_id = ?, position = ?, updated_at = ? WHERE id = ?').run(
          n.board_id,
          phaseFor(n),
          (max ?? 0) + 1,
          now(),
          card.id,
        );
        relocateCardHistory(db, card.id, n.board_id);
        moved.push({ id: card.id, from: card.project_id, to: n.board_id });
        boards.add(card.project_id).add(n.board_id);
      } else if (fields.includes('phase')) {
        db.prepare('UPDATE tasks SET phase_id = ?, updated_at = ? WHERE id = ?').run(phaseFor(n), now(), card.id);
        boards.add(n.board_id);
      }
    }

    // depends_on from the edges, keeping entries that point outside this plan
    for (const n of plan.order) {
      if (!plan.creates.has(n.id) && !plan.updates.get(n.id)?.includes('depends_on')) continue;
      const cardId = cardOf.get(n.id)!;
      const current = depsOf(getTask(db, cardId));
      const external = current.filter((d) => !plan.planCards.has(d));
      const internal = edges.filter((e) => e.to === n.id).map((e) => cardOf.get(e.from)!);
      const next = [...new Set([...external, ...internal])];
      if (sameSet(current, next)) continue;
      updateTask(db, cardId, { depends_on: next.length ? next : null });
      touched.add(cardId);
    }

    const committed: Record<string, string> = {};
    for (const n of draft.data.nodes) committed[n.id] = cardOf.get(n.id)!;
    const data: PlanData = { ...draft.data, committed };
    const committedAt = now();
    db.prepare('UPDATE plan_drafts SET data = ?, committed_version = ?, committed_at = ? WHERE id = ?').run(
      JSON.stringify(data),
      draft.version,
      committedAt,
      id,
    );
    return {
      draft: { ...draft, data, committed_version: draft.version, committed_at: committedAt },
      diff: plan.diff,
      touched: [...touched],
      deleted,
      moved,
      boards: [...boards],
    };
  })();
}

// ── run: hand a committed plan to agents ──

export type RunMode = 'queue' | 'autopilot';

export interface RunResult {
  draft_id: string;
  mode: RunMode;
  /** Backlog plan cards moved to queued. */
  queued: string[];
  /** Backlog plan cards left in backlog. */
  skipped: { card_id: string; node_id: string; title: string; reason: 'needs spec' }[];
  /** Autopilot report ('autopilot' mode only; empty lists for 'queue'). */
  autopilot: {
    enabled: { board_id: string; already_on: boolean }[];
    /** reason is 'main_session' (with a message) or 'no queued cards to work'. */
    not_enabled: { board_id: string; reason: string; message?: string }[];
  };
}

const MAIN_SESSION_MESSAGE = 'Autopilot never drives the main session; its cards are queued for you';

/**
 * Queue a committed, clean draft's spec'd backlog cards (requirements AND ≥1
 * subtask); the rest are skipped as "needs spec". 'autopilot' also turns on
 * autopilot for each involved VERTICAL board that has queued cards for it to
 * work. The workspace (or a standalone project) is the main session, which is
 * never auto-prompted: it's reported as not enabled ('main_session'), its cards
 * still queued for the human.
 */
export function runDraft(db: DB, id: string, mode: RunMode): RunResult {
  if (mode !== 'queue' && mode !== 'autopilot') throw new DraftError('invalid_op', "mode must be 'queue' or 'autopilot'");
  return db.transaction((): RunResult => {
    const draft = getDraft(db, id);
    if (!draft) throw new DraftError('not_found', `no such draft: ${id}`);
    if (draft.committed_version === null) throw new DraftConflict('not_committed', 'commit the draft before running it');
    if (draft.committed_version !== draft.version)
      throw new DraftConflict('dirty', 'the draft has changes since its last commit: commit them first', {
        version: draft.version,
      });

    const cards: { nodeId: string; card: Task }[] = [];
    for (const [nodeId, cardId] of Object.entries(draft.data.committed)) {
      const card = db.prepare('SELECT * FROM tasks WHERE id = ?').get(cardId) as Task | undefined;
      if (card) cards.push({ nodeId, card });
    }

    const result: RunResult = { draft_id: id, mode, queued: [], skipped: [], autopilot: { enabled: [], not_enabled: [] } };
    for (const { nodeId, card } of cards) {
      if (card.lane !== 'backlog') continue;
      if (card.requirements?.trim() && subsOf(card).length) {
        moveTask(db, card.id, 'queued');
        result.queued.push(card.id);
      } else {
        result.skipped.push({ card_id: card.id, node_id: nodeId, title: card.title, reason: 'needs spec' });
      }
    }

    if (mode === 'autopilot') {
      const rank = new Map(draftContext(db, draft.workspace_id).boards.map((b, i) => [b.id, i]));
      const involved = [...new Set(cards.map((c) => c.card.project_id))].sort(
        (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
      );
      for (const boardId of involved) {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(boardId) as Project;
        if (project.parent_id === null) {
          result.autopilot.not_enabled.push({ board_id: boardId, reason: 'main_session', message: MAIN_SESSION_MESSAGE });
          continue;
        }
        const { n } = db
          .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND lane = 'queued'`)
          .get(boardId) as { n: number };
        if (!n) {
          result.autopilot.not_enabled.push({ board_id: boardId, reason: 'no queued cards to work' });
          continue;
        }
        if (project.autopilot !== 1) setAutopilot(db, boardId, true);
        result.autopilot.enabled.push({ board_id: boardId, already_on: project.autopilot === 1 });
      }
    }
    return result;
  })();
}
