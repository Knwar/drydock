import type { DB } from './db.js';
import { now, shortId } from './board.js';

// ── decision log + risk register ──
//
// Decisions and risks belong to one board (project_id): a workspace-level item
// uses the workspace id, a vertical's item its own. Both link to cards, phases
// and plan drafts through the single governance_links table.

export const DECISION_STATUSES = ['active', 'superseded'] as const;
export const RISK_STATUSES = ['open', 'mitigating', 'closed', 'occurred'] as const;
export const LINK_TARGETS = ['card', 'phase', 'plan'] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export type RiskStatus = (typeof RISK_STATUSES)[number];
export type LinkTarget = (typeof LINK_TARGETS)[number];
type Kind = 'decision' | 'risk';

export interface Link {
  target_type: LinkTarget;
  target_id: string;
}

export interface Decision {
  id: string;
  project_id: string;
  title: string;
  decision: string;
  rationale: string | null;
  decided_by: string | null;
  decided_at: number;
  status: DecisionStatus;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
  links: Link[];
}

export interface Risk {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  likelihood: number;
  impact: number;
  score: number; // likelihood × impact
  owner: string | null;
  mitigation: string | null;
  status: RiskStatus;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  links: Link[];
}

export interface ListFilter {
  status?: string;
  q?: string; // case-insensitive substring over the text fields
  card?: string; // only items linked to this card
  phase?: string; // only items linked to this phase
}

/** Where a listed item comes from, relative to the listed board: its own, its workspace's, or one of its verticals'. */
export type Scope = 'own' | 'workspace' | 'vertical';
export type Listed<T> = T & { scope: Scope };

/** A governance write or lookup failed; nothing was changed. code 'not_found' → 404, anything else → 400. */
export class GovernanceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
  }
}

const invalid = (message: string) => new GovernanceError('invalid', message);
const notFound = (message: string) => new GovernanceError('not_found', message);

type Input = Record<string, unknown>;

function requiredText(input: Input, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) throw invalid(`${key} (non-empty string) required`);
  return v;
}

/** undefined = not given; null clears; otherwise must be a string. */
function optionalText(input: Input, key: string): string | null | undefined {
  const v = input[key];
  if (v === undefined || v === null) return v as undefined | null;
  if (typeof v !== 'string') throw invalid(`${key} must be a string or null`);
  return v;
}

function rating(input: Input, key: string): number | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) throw invalid(`${key} must be an integer 1-5`);
  return v;
}

function oneOf<T extends string>(input: Input, key: string, allowed: readonly T[]): T | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) throw invalid(`${key} must be one of ${allowed.join('|')}`);
  return v as T;
}

function asObject(input: unknown): Input {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('body must be an object');
  return input as Input;
}

/** The workspace a project belongs to (itself when top-level). Unknown → not_found. */
export function workspaceOf(db: DB, projectId: string): string {
  const row = db.prepare('SELECT id, parent_id FROM projects WHERE id = ?').get(projectId) as
    | { id: string; parent_id: string | null }
    | undefined;
  if (!row) throw notFound(`no such project: ${projectId}`);
  return row.parent_id ?? row.id;
}

/**
 * The boards a list covers, each with its scope: the project itself ('own'),
 * plus its verticals ('vertical') when it is a workspace, or its parent
 * workspace ('workspace') when it is a vertical.
 */
export function projectScope(db: DB, projectId: string): Map<string, Scope> {
  const ws = workspaceOf(db, projectId);
  const scope = new Map<string, Scope>([[projectId, 'own']]);
  if (ws !== projectId) scope.set(ws, 'workspace');
  else
    for (const c of db.prepare('SELECT id FROM projects WHERE parent_id = ?').all(projectId) as { id: string }[])
      scope.set(c.id, 'vertical');
  return scope;
}

/** Case- and accent-form-insensitive substring match, folded in JS so non-ASCII letters (É/é) match. */
const fold = (s: string) => s.normalize('NFC').toLowerCase();
function matchesText(row: Record<string, unknown>, q: string | undefined, textCols: string[]): boolean {
  if (!q) return true;
  const needle = fold(q);
  return textCols.some((c) => typeof row[c] === 'string' && fold(row[c] as string).includes(needle));
}

function parseLinks(raw: unknown, key: string): Link[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid(`${key} must be an array of {target_type, target_id}`);
  return raw.map((l) => {
    const o = typeof l === 'object' && l !== null ? (l as Input) : {};
    if (!LINK_TARGETS.includes(o.target_type as LinkTarget))
      throw invalid(`${key}: target_type must be one of ${LINK_TARGETS.join('|')}`);
    if (typeof o.target_id !== 'string' || !o.target_id) throw invalid(`${key}: target_id (string) required`);
    return { target_type: o.target_type as LinkTarget, target_id: o.target_id };
  });
}

/** The board owning a link target (a plan's workspace), or undefined when it no longer exists. */
function targetOwner(db: DB, link: Link): string | undefined {
  const sql = {
    card: 'SELECT project_id AS owner FROM tasks WHERE id = ?',
    phase: 'SELECT project_id AS owner FROM phases WHERE id = ?',
    plan: 'SELECT workspace_id AS owner FROM plan_drafts WHERE id = ?',
  }[link.target_type];
  return (db.prepare(sql).get(link.target_id) as { owner: string } | undefined)?.owner;
}

const targetExists = (db: DB, link: Link) => targetOwner(db, link) !== undefined;

/** A link target must exist and sit in the same workspace as the item. */
function checkTarget(db: DB, workspaceId: string, link: Link): void {
  const owner = targetOwner(db, link);
  if (owner === undefined) throw notFound(`no such ${link.target_type}: ${link.target_id}`);
  if (workspaceOf(db, owner) !== workspaceId)
    throw invalid(`${link.target_type} ${link.target_id} is in another workspace`);
}

function addLinks(db: DB, kind: Kind, itemId: string, projectId: string, links: Link[]): void {
  const ws = workspaceOf(db, projectId);
  for (const l of links) {
    checkTarget(db, ws, l);
    db.prepare(
      'INSERT OR IGNORE INTO governance_links (kind, item_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(kind, itemId, l.target_type, l.target_id, now());
  }
}

function removeLinks(db: DB, kind: Kind, itemId: string, links: Link[]): void {
  for (const l of links)
    db.prepare('DELETE FROM governance_links WHERE kind = ? AND item_id = ? AND target_type = ? AND target_id = ?').run(
      kind,
      itemId,
      l.target_type,
      l.target_id,
    );
}

function linksOf(db: DB, kind: Kind, itemId: string): Link[] {
  return db
    .prepare(
      'SELECT target_type, target_id FROM governance_links WHERE kind = ? AND item_id = ? ORDER BY target_type, target_id',
    )
    .all(kind, itemId) as Link[];
}

/** Shared WHERE for both lists: project scope, status, linked card/phase. Text search runs in JS (matchesText). */
function listWhere(
  db: DB,
  kind: Kind,
  scope: Map<string, Scope>,
  filter: ListFilter,
  table: 'decisions' | 'risks',
): { clause: string; params: string[] } {
  const where = [`project_id IN (${[...scope.keys()].map(() => '?').join(', ')})`];
  const params: string[] = [...scope.keys()];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  for (const [type, id] of [
    ['card', filter.card],
    ['phase', filter.phase],
  ] as const) {
    if (!id) continue;
    where.push(
      `EXISTS (SELECT 1 FROM governance_links g WHERE g.kind = ? AND g.item_id = ${table}.id AND g.target_type = ? AND g.target_id = ?)`,
    );
    params.push(kind, type, id);
  }
  return { clause: where.join(' AND '), params };
}

// ── decisions ──

type DecisionRow = Omit<Decision, 'links'>;

export function getDecision(db: DB, id: string): Decision {
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DecisionRow | undefined;
  if (!row) throw notFound(`no such decision: ${id}`);
  return { ...row, links: linksOf(db, 'decision', id) };
}

/** Record a decision: {project_id, title, decision, rationale?, decided_by?, decided_at?, links?}. */
export function createDecision(db: DB, input: unknown): Decision {
  const b = asObject(input);
  return db.transaction(() => {
    const projectId = requiredText(b, 'project_id');
    workspaceOf(db, projectId);
    const title = requiredText(b, 'title');
    const decision = requiredText(b, 'decision');
    const rationale = optionalText(b, 'rationale') ?? null;
    const decidedBy = optionalText(b, 'decided_by') ?? null;
    if (b.decided_at !== undefined && (typeof b.decided_at !== 'number' || !Number.isFinite(b.decided_at)))
      throw invalid('decided_at must be epoch ms');
    const links = parseLinks(b.links, 'links');
    const t = now();
    const id = shortId();
    db.prepare(
      `INSERT INTO decisions (id, project_id, title, decision, rationale, decided_by, decided_at, status, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    ).run(id, projectId, title, decision, rationale, decidedBy, (b.decided_at as number | undefined) ?? t, t, t);
    addLinks(db, 'decision', id, projectId, links);
    return getDecision(db, id);
  })();
}

/** Patch a decision's text fields and/or its links ({link, unlink} arrays). Status changes only via supersede. */
export function updateDecision(db: DB, id: string, input: unknown): Decision {
  const b = asObject(input);
  return db.transaction(() => {
    const current = getDecision(db, id);
    if (b.status !== undefined) throw invalid('status changes only through supersede');
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const key of ['title', 'decision'] as const)
      if (b[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(requiredText(b, key));
      }
    for (const key of ['rationale', 'decided_by'] as const) {
      const v = optionalText(b, key);
      if (v !== undefined) {
        sets.push(`${key} = ?`);
        params.push(v);
      }
    }
    if (b.decided_at !== undefined) {
      if (typeof b.decided_at !== 'number' || !Number.isFinite(b.decided_at)) throw invalid('decided_at must be epoch ms');
      sets.push('decided_at = ?');
      params.push(b.decided_at);
    }
    const link = parseLinks(b.link, 'link');
    const unlink = parseLinks(b.unlink, 'unlink');
    sets.push('updated_at = ?');
    params.push(now());
    db.prepare(`UPDATE decisions SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    removeLinks(db, 'decision', id, unlink);
    addLinks(db, 'decision', id, current.project_id, link);
    return getDecision(db, id);
  })();
}

/**
 * Replace an active decision with a new one on the same board. The new one
 * inherits the old one's links whose target still exists, plus any given; the
 * old one is marked superseded and points at it. A project_id other than the
 * old one's board is rejected. Returns both.
 */
export function supersedeDecision(db: DB, id: string, input: unknown): { superseded: Decision; decision: Decision } {
  const b = asObject(input);
  return db.transaction(() => {
    const old = getDecision(db, id);
    if (old.status !== 'active') throw new GovernanceError('already_superseded', `decision ${id} is already superseded`);
    if (b.project_id !== undefined && b.project_id !== old.project_id)
      throw invalid(`project_id ${String(b.project_id)} does not match decision ${id}'s board (${old.project_id})`);
    const created = createDecision(db, { ...b, project_id: old.project_id });
    for (const l of old.links.filter((l) => targetExists(db, l)))
      db.prepare(
        'INSERT OR IGNORE INTO governance_links (kind, item_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('decision', created.id, l.target_type, l.target_id, now());
    const fresh = getDecision(db, created.id);
    db.prepare(`UPDATE decisions SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`).run(
      fresh.id,
      now(),
      id,
    );
    return { superseded: getDecision(db, id), decision: fresh };
  })();
}

/**
 * Decisions of a project plus its workspace's (for a vertical) or its
 * verticals' (for a workspace), each tagged with its scope; newest decided first.
 */
export function listDecisions(db: DB, projectId: string, filter: ListFilter = {}): Listed<Decision>[] {
  if (filter.status !== undefined && !DECISION_STATUSES.includes(filter.status as DecisionStatus))
    throw invalid(`status must be one of ${DECISION_STATUSES.join('|')}`);
  const scope = projectScope(db, projectId);
  const { clause, params } = listWhere(db, 'decision', scope, filter, 'decisions');
  const rows = db
    .prepare(`SELECT * FROM decisions WHERE ${clause} ORDER BY decided_at DESC, created_at DESC, rowid DESC`)
    .all(...params) as DecisionRow[];
  return rows
    .filter((r) => matchesText(r, filter.q, ['title', 'decision', 'rationale']))
    .map((r) => ({ ...r, links: linksOf(db, 'decision', r.id), scope: scope.get(r.project_id)! }));
}

// ── risks ──

type RiskRow = Omit<Risk, 'links' | 'score'>;

const toRisk = (db: DB, row: RiskRow): Risk => ({
  ...row,
  score: row.likelihood * row.impact,
  links: linksOf(db, 'risk', row.id),
});

const isClosed = (s: RiskStatus) => s === 'closed' || s === 'occurred';

export function getRisk(db: DB, id: string): Risk {
  const row = db.prepare('SELECT * FROM risks WHERE id = ?').get(id) as RiskRow | undefined;
  if (!row) throw notFound(`no such risk: ${id}`);
  return toRisk(db, row);
}

/** Open a risk: {project_id, title, likelihood, impact, description?, owner?, mitigation?, status?, links?}. */
export function createRisk(db: DB, input: unknown): Risk {
  const b = asObject(input);
  return db.transaction(() => {
    const projectId = requiredText(b, 'project_id');
    workspaceOf(db, projectId);
    const title = requiredText(b, 'title');
    const likelihood = rating(b, 'likelihood');
    const impact = rating(b, 'impact');
    if (likelihood === undefined || impact === undefined) throw invalid('likelihood and impact (1-5) required');
    const status = oneOf(b, 'status', RISK_STATUSES) ?? 'open';
    const links = parseLinks(b.links, 'links');
    const t = now();
    const id = shortId();
    db.prepare(
      `INSERT INTO risks (id, project_id, title, description, likelihood, impact, owner, mitigation, status, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      title,
      optionalText(b, 'description') ?? null,
      likelihood,
      impact,
      optionalText(b, 'owner') ?? null,
      optionalText(b, 'mitigation') ?? null,
      status,
      t,
      t,
      isClosed(status) ? t : null,
    );
    addLinks(db, 'risk', id, projectId, links);
    return getRisk(db, id);
  })();
}

/** Patch a risk (fields, status, {link, unlink}). Entering closed|occurred stamps closed_at; reopening clears it. */
export function updateRisk(db: DB, id: string, input: unknown): Risk {
  const b = asObject(input);
  return db.transaction(() => {
    const current = getRisk(db, id);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (b.title !== undefined) {
      sets.push('title = ?');
      params.push(requiredText(b, 'title'));
    }
    for (const key of ['description', 'owner', 'mitigation'] as const) {
      const v = optionalText(b, key);
      if (v !== undefined) {
        sets.push(`${key} = ?`);
        params.push(v);
      }
    }
    for (const key of ['likelihood', 'impact'] as const) {
      const v = rating(b, key);
      if (v !== undefined) {
        sets.push(`${key} = ?`);
        params.push(v);
      }
    }
    const status = oneOf(b, 'status', RISK_STATUSES);
    const t = now();
    if (status !== undefined) {
      sets.push('status = ?');
      params.push(status);
      if (isClosed(status) !== isClosed(current.status)) {
        sets.push('closed_at = ?');
        params.push(isClosed(status) ? t : null);
      }
    }
    const link = parseLinks(b.link, 'link');
    const unlink = parseLinks(b.unlink, 'unlink');
    sets.push('updated_at = ?');
    params.push(t);
    db.prepare(`UPDATE risks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    removeLinks(db, 'risk', id, unlink);
    addLinks(db, 'risk', id, current.project_id, link);
    return getRisk(db, id);
  })();
}

/**
 * Risks of a project plus its workspace's (for a vertical) or its verticals'
 * (for a workspace), each tagged with its scope; highest score first.
 */
export function listRisks(db: DB, projectId: string, filter: ListFilter = {}): Listed<Risk>[] {
  if (filter.status !== undefined && !RISK_STATUSES.includes(filter.status as RiskStatus))
    throw invalid(`status must be one of ${RISK_STATUSES.join('|')}`);
  const scope = projectScope(db, projectId);
  const { clause, params } = listWhere(db, 'risk', scope, filter, 'risks');
  const rows = db
    .prepare(`SELECT * FROM risks WHERE ${clause} ORDER BY likelihood * impact DESC, updated_at DESC, rowid DESC`)
    .all(...params) as RiskRow[];
  return rows
    .filter((r) => matchesText(r, filter.q, ['title', 'description', 'mitigation']))
    .map((r) => ({ ...toRisk(db, r), scope: scope.get(r.project_id)! }));
}
