import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { DB } from './db.js';
import { buildWhere } from './sql-util.js';
import {
  LANES,
  type AgentStat,
  type AttentionItem,
  type AttentionSeverity,
  type CardSummary,
  type CardTotals,
  type ProjectStats,
  type EventType,
  type Lane,
  type Phase,
  type PhaseStatus,
  type PhaseView,
  type Project,
  type ReviewFinding,
  type SyncLink,
  type Subtask,
  type Task,
  type TaskEvent,
  type TeamMember,
  type Verdict,
} from './types.js';

export function now(): number {
  return Date.now();
}

export function shortId(): string {
  return randomBytes(4).toString('hex');
}

function assertLane(lane: string): asserts lane is Lane {
  if (!LANES.includes(lane as Lane)) throw new Error(`invalid lane: ${lane}`);
}

export function getTask(db: DB, taskId: string): Task {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
  if (!task) throw new Error(`no such task: ${taskId}`);
  return task;
}

/**
 * Deterministic SHA-256 (hex) over a card's SYNCABLE content — the loop/change
 * detector the bridge sync engine will compare against remote hashes. Hashes a
 * CANONICAL JSON of exactly these fields, in fixed order: title, requirements,
 * lane, tag, subtasks. Subtasks are normalized to an ordered [{text,done}] list
 * so equal content → equal hash regardless of object key order, extra fields
 * (id/timestamps/position), or how subtasks arrive (JSON string or array).
 */
export function taskContentHash(
  task: Pick<Task, 'title' | 'requirements' | 'lane' | 'tag'> & {
    subtasks: Task['subtasks'] | Subtask[];
  },
): string {
  const raw = task.subtasks;
  const list: Subtask[] =
    raw == null ? [] : typeof raw === 'string' ? (JSON.parse(raw) as Subtask[]) : raw;
  const subtasks = list.map((s) => ({ text: s.text, done: !!s.done }));
  const canonical = JSON.stringify({
    title: task.title,
    requirements: task.requirements ?? null,
    lane: task.lane,
    tag: task.tag ?? null,
    subtasks,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function appendEvent(
  db: DB,
  e: {
    project_id: string;
    task_id?: string | null;
    type: EventType;
    payload?: unknown;
    agent?: string | null;
    // Loop-prevention tag written to the OUTBOX row only (task_events has no such
    // column). Optional with a 'local' default so no existing caller changes.
    origin?: string;
  },
): TaskEvent {
  const created_at = now();
  const payload = e.payload === undefined ? null : JSON.stringify(e.payload);
  const origin = e.origin ?? 'local';
  // Tee every event into the outbox in the SAME transaction: both inserts commit
  // or neither does. better-sqlite3 transactions nest via savepoints, so when a
  // caller (e.g. deleteTask) already holds a transaction this joins it; called
  // standalone it opens its own — atomic either way, never a partial write.
  const result = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO task_events (project_id, task_id, type, payload, agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.project_id, e.task_id ?? null, e.type, payload, e.agent ?? null, created_at);
    db.prepare(
      `INSERT INTO outbox (project_id, task_id, type, payload, created_at, status, attempts, last_attempt_at, origin)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?)`,
    ).run(e.project_id, e.task_id ?? null, e.type, payload, created_at, origin);
    return r;
  })();
  return {
    id: Number(result.lastInsertRowid),
    project_id: e.project_id,
    task_id: e.task_id ?? null,
    type: e.type,
    payload,
    agent: e.agent ?? null,
    created_at,
  };
}

/** Canonical form of a project's root path — the dedup key. Strips trailing
 *  slashes and collapses `.`/`..` so the SAME folder registered via the UI
 *  folder picker (macOS hands back a trailing slash) and via init-project.sh
 *  (`cd … && pwd`) map to one row instead of two. */
function normalizeRoot(rootPath: string): string {
  return resolve(rootPath);
}

export function getOrCreateProject(db: DB, rootPath: string, name?: string): Project {
  const root = normalizeRoot(rootPath);
  const existing = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(root) as
    | Project
    | undefined;
  if (existing) return existing;
  const project: Project = {
    id: randomUUID(),
    name: name ?? basename(root),
    root_path: root,
    created_at: now(),
  };
  db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run(
    project.id,
    project.name,
    project.root_path,
    project.created_at,
  );
  return project;
}

/** Read-only lookup by root path — never creates (for hooks/transient cwds). */
export function findProject(db: DB, rootPath: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE root_path = ?').get(normalizeRoot(rootPath)) as
    | Project
    | undefined;
}

/** Unregister a project and everything it owns from the board. The folder on disk is left untouched. */
export function deleteProject(db: DB, projectId: string): void {
  db.transaction(() => {
    const tasks = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(projectId) as { id: string }[];
    for (const { id } of tasks) db.prepare('DELETE FROM reviews WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM card_activity WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM task_events WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM phases WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  })();
}

export function createTask(
  db: DB,
  projectId: string,
  title: string,
  opts: { tag?: string; requirements?: string; depends_on?: string[]; phase_id?: string } = {},
): Task {
  const ts = now();
  const max = db
    .prepare('SELECT MAX(position) AS max FROM tasks WHERE project_id = ?')
    .get(projectId) as { max: number | null };
  const task: Task = {
    id: shortId(),
    project_id: projectId,
    phase_id: opts.phase_id ?? null,
    title,
    lane: 'backlog',
    requirements: opts.requirements ?? null,
    tag: opts.tag ?? null,
    skill: null,
    assigned_agent: null,
    worktree_path: null,
    branch: null,
    depends_on: opts.depends_on ? JSON.stringify(opts.depends_on) : null,
    subtasks: null,
    blocked_at: null,
    blocked_reason: null,
    review_rounds: 0,
    position: (max.max ?? 0) + 1,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO tasks (id, project_id, phase_id, title, lane, requirements, tag, depends_on, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.project_id,
    task.phase_id,
    task.title,
    task.lane,
    task.requirements,
    task.tag,
    task.depends_on,
    task.position,
    task.created_at,
    task.updated_at,
  );
  appendEvent(db, {
    project_id: projectId,
    task_id: task.id,
    type: 'create',
    payload: { title, phase_id: task.phase_id },
  });
  return task;
}

const UPDATABLE = [
  'requirements',
  'tag',
  'depends_on',
  'assigned_agent',
  'worktree_path',
  'branch',
] as const;
type UpdatableField = (typeof UPDATABLE)[number];

export function updateTask(
  db: DB,
  taskId: string,
  patch: Partial<Record<UpdatableField, string | string[] | null>>,
): Task {
  getTask(db, taskId); // existence check
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const field of UPDATABLE) {
    if (!(field in patch)) continue;
    const raw = patch[field];
    sets.push(`${field} = ?`);
    values.push(Array.isArray(raw) ? JSON.stringify(raw) : (raw ?? null));
  }
  if (sets.length === 0) throw new Error('empty patch');
  db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...values,
    now(),
    taskId,
  );
  return getTask(db, taskId);
}

export function moveTask(db: DB, taskId: string, lane: string, agent?: string): Task {
  assertLane(lane);
  const task = getTask(db, taskId);
  if (task.lane !== lane) {
    // reaching the terminal lane clears any open blocker
    const clearBlock = lane === 'done' ? ', blocked_at = NULL, blocked_reason = NULL' : '';
    db.prepare(`UPDATE tasks SET lane = ?, updated_at = ?${clearBlock} WHERE id = ?`).run(lane, now(), taskId);
    appendEvent(db, {
      project_id: task.project_id,
      task_id: taskId,
      type: 'move',
      payload: { from: task.lane, to: lane },
      agent,
    });
  }
  return getTask(db, taskId);
}

/**
 * A builder flags that this card needs a human decision it can't make itself —
 * an ambiguous or contradictory spec, a destructive/irreversible action to
 * confirm, a missing secret, an architectural fork the requirements don't
 * resolve. It's a flag in place (the lane doesn't change): the card surfaces as
 * a top-priority Attention item until the human resolves it.
 */
export function raiseBlocker(db: DB, taskId: string, reason: string, agent?: string): Task {
  const task = getTask(db, taskId);
  const ts = now();
  db.prepare('UPDATE tasks SET blocked_at = ?, blocked_reason = ?, updated_at = ? WHERE id = ?').run(ts, reason, ts, taskId);
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'block',
    payload: { reason },
    agent: agent ?? task.assigned_agent,
  });
  return getTask(db, taskId);
}

/** Clear a card's blocker once the human has answered — work can resume. */
export function resolveBlocker(db: DB, taskId: string, note?: string): Task {
  const task = getTask(db, taskId);
  db.prepare('UPDATE tasks SET blocked_at = NULL, blocked_reason = NULL, updated_at = ? WHERE id = ?').run(now(), taskId);
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'unblock',
    payload: { note: note ?? null },
  });
  return getTask(db, taskId);
}

/**
 * Permanently remove a card and its history (reviews, events), and strip it
 * from any other card's depends_on so nothing is left blocked on a ghost.
 * Irreversible — for mistakes and throwaways.
 */
export function deleteTask(db: DB, taskId: string): { id: string; title: string; project_id: string } {
  const task = getTask(db, taskId);
  db.transaction(() => {
    // unblock dependents: drop this id from their depends_on arrays
    const dependents = db
      .prepare(`SELECT id, depends_on FROM tasks WHERE project_id = ? AND depends_on LIKE ?`)
      .all(task.project_id, `%"${taskId}"%`) as { id: string; depends_on: string }[];
    for (const d of dependents) {
      const deps = (JSON.parse(d.depends_on) as string[]).filter((x) => x !== taskId);
      db.prepare('UPDATE tasks SET depends_on = ? WHERE id = ?').run(deps.length ? JSON.stringify(deps) : null, d.id);
    }
    db.prepare('DELETE FROM reviews WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    appendEvent(db, { project_id: task.project_id, type: 'delete', payload: { id: taskId, title: task.title } });
  })();
  return { id: taskId, title: task.title, project_id: task.project_id };
}

/**
 * Abandon a card's current approach and reset it for a fresh start: clears the
 * assignment/worktree/branch, resets the review-round counter and acceptance
 * criteria, and returns it to the backlog. Pass requirements to set the new
 * direction. The old git worktree is removed separately by the orchestrator.
 */
export function redirectTask(
  db: DB,
  taskId: string,
  opts: { requirements?: string; note?: string } = {},
): Task {
  const task = getTask(db, taskId);
  db.prepare(
    `UPDATE tasks SET lane = 'backlog', assigned_agent = NULL, worktree_path = NULL, branch = NULL,
     review_rounds = 0, subtasks = NULL, blocked_at = NULL, blocked_reason = NULL,
     requirements = COALESCE(?, requirements), updated_at = ? WHERE id = ?`,
  ).run(opts.requirements ?? null, now(), taskId);
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'redirect',
    payload: { from: task.lane, note: opts.note ?? null },
  });
  return getTask(db, taskId);
}

/** Match an assignment label to a team member — by agent id first, then name. */
function teamMemberByLabel(db: DB, label: string): TeamMember | undefined {
  return db.prepare('SELECT * FROM team_members WHERE id = ? OR name = ? LIMIT 1').get(label, label) as
    | TeamMember
    | undefined;
}

export function assignCard(
  db: DB,
  taskId: string,
  agent: string,
  worktreePath: string,
  branch: string,
  skill?: string | null,
): Task {
  // The card picks up the assigned agent's skill (persona): an explicit skill
  // wins, else the matching team member's, so the builder knows which to load.
  const resolvedSkill = skill ?? teamMemberByLabel(db, agent)?.skill ?? null;
  updateTask(db, taskId, { assigned_agent: agent, worktree_path: worktreePath, branch });
  // re-dispatching a builder means the human has acted on any blocker → clear it
  db.prepare('UPDATE tasks SET skill = ?, blocked_at = NULL, blocked_reason = NULL, updated_at = ? WHERE id = ?').run(resolvedSkill, now(), taskId);
  const task = getTask(db, taskId);
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'assign',
    payload: { worktree: worktreePath, branch, skill: resolvedSkill },
    agent,
  });
  // Invariant: an assigned card is actively owned by an agent, so it belongs in
  // in_progress — never left behind in backlog/queued. Enforced here (the card id
  // is known exactly) so several cards dispatched at once each advance reliably,
  // instead of racing on a hook's "first queued card" guess.
  if (task.lane === 'backlog' || task.lane === 'queued') {
    return moveTask(db, taskId, 'in_progress', agent);
  }
  return task;
}

export function recordReview(
  db: DB,
  taskId: string,
  verdict: Verdict,
  findings: ReviewFinding[] = [],
): { task_id: string; round: number; verdict: Verdict } {
  if (verdict !== 'pass' && verdict !== 'fail') throw new Error(`invalid verdict: ${verdict}`);
  const task = getTask(db, taskId);
  const round = task.review_rounds + 1;
  db.prepare(
    'INSERT INTO reviews (task_id, round, verdict, findings, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(taskId, round, verdict, JSON.stringify(findings), now());
  db.prepare('UPDATE tasks SET review_rounds = ?, updated_at = ? WHERE id = ?').run(
    round,
    now(),
    taskId,
  );
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'review',
    payload: { verdict, round, findings: findings.length },
  });
  return { task_id: taskId, round, verdict };
}

// ── phases ────────────────────────────────────────────────────────
export function createPhase(
  db: DB,
  projectId: string,
  title: string,
  opts: { goal?: string; plan?: string } = {},
): Phase {
  const ts = now();
  const max = db
    .prepare('SELECT MAX(position) AS max FROM phases WHERE project_id = ?')
    .get(projectId) as { max: number | null };
  const phase: Phase = {
    id: shortId(),
    project_id: projectId,
    title,
    goal: opts.goal ?? null,
    plan: opts.plan ?? null,
    status: 'planned',
    position: (max.max ?? 0) + 1,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO phases (id, project_id, title, goal, plan, status, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    phase.id,
    phase.project_id,
    phase.title,
    phase.goal,
    phase.plan,
    phase.status,
    phase.position,
    phase.created_at,
    phase.updated_at,
  );
  appendEvent(db, { project_id: projectId, type: 'phase_create', payload: { phase_id: phase.id, title } });
  return phase;
}

export function getPhase(db: DB, phaseId: string): Phase {
  const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId) as Phase | undefined;
  if (!phase) throw new Error(`no such phase: ${phaseId}`);
  return phase;
}

export function getActivePhase(db: DB, projectId: string): Phase | null {
  return (
    (db
      .prepare(`SELECT * FROM phases WHERE project_id = ? AND status = 'active' ORDER BY position LIMIT 1`)
      .get(projectId) as Phase | undefined) ?? null
  );
}

export function getNextPhase(db: DB, projectId: string): Phase | null {
  return (
    (db
      .prepare(`SELECT * FROM phases WHERE project_id = ? AND status = 'planned' ORDER BY position LIMIT 1`)
      .get(projectId) as Phase | undefined) ?? null
  );
}

/** Phases with card progress — powers the drawer and the orchestrator's judgment. */
export function getPhases(db: DB, projectId: string): PhaseView[] {
  const phases = db
    .prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position')
    .all(projectId) as Phase[];
  const prog = db.prepare(
    `SELECT COUNT(*) AS total, SUM(lane = 'done') AS done FROM tasks WHERE phase_id = ?`,
  );
  return phases.map((p) => {
    const { total, done } = prog.get(p.id) as { total: number; done: number | null };
    return {
      id: p.id,
      title: p.title,
      goal: p.goal,
      status: p.status,
      position: p.position,
      progress: { done: done ?? 0, total },
    };
  });
}

function setPhaseStatus(db: DB, phaseId: string, status: PhaseStatus, type: EventType): Phase {
  const phase = getPhase(db, phaseId);
  db.prepare('UPDATE phases SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), phaseId);
  appendEvent(db, { project_id: phase.project_id, type, payload: { phase_id: phaseId, title: phase.title } });
  return getPhase(db, phaseId);
}

/**
 * Scrum move: complete the current active phase (if any), then activate the
 * next planned one. Returns the newly active phase, or null when none remain.
 * Doubles as kickoff — with nothing active yet, it just activates the first.
 */
export function advancePhase(db: DB, projectId: string): Phase | null {
  const active = getActivePhase(db, projectId);
  if (active) setPhaseStatus(db, active.id, 'done', 'phase_done');
  const next = getNextPhase(db, projectId);
  return next ? setPhaseStatus(db, next.id, 'active', 'phase_activate') : null;
}

/** Acceptance-criteria progress for a card's subtasks JSON, or null if none. */
export function progressOf(json: string | null): { done: number; total: number } | null {
  if (!json) return null;
  const subs = JSON.parse(json) as Subtask[];
  if (subs.length === 0) return null;
  return { done: subs.filter((s) => s.done).length, total: subs.length };
}

/** Replace a card's acceptance criteria. Strings arrive unchecked. */
export function setSubtasks(
  db: DB,
  taskId: string,
  items: (string | Subtask)[],
  agent?: string,
): Task {
  const task = getTask(db, taskId);
  const subs: Subtask[] = items.map((item) =>
    typeof item === 'string' ? { text: item, done: false } : { text: item.text, done: !!item.done },
  );
  db.prepare('UPDATE tasks SET subtasks = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(subs),
    now(),
    taskId,
  );
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'subtasks',
    payload: { total: subs.length },
    agent,
  });
  return getTask(db, taskId);
}

/**
 * Check (or uncheck) one acceptance criterion. Deterministic rule: when the
 * last one is checked on an in_progress card, the card moves to in_review.
 */
export function checkSubtask(
  db: DB,
  taskId: string,
  index: number,
  done = true,
  agent?: string,
): { task: Task; moved: boolean } {
  const task = getTask(db, taskId);
  const subs: Subtask[] = task.subtasks ? JSON.parse(task.subtasks) : [];
  if (!subs[index]) throw new Error(`no subtask ${index} on ${taskId}`);
  subs[index].done = done;
  db.prepare('UPDATE tasks SET subtasks = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(subs),
    now(),
    taskId,
  );
  appendEvent(db, {
    project_id: task.project_id,
    task_id: taskId,
    type: 'check',
    payload: { index, text: subs[index].text, done, progress: progressOf(JSON.stringify(subs)) },
    agent,
  });
  let moved = false;
  if (done && task.lane === 'in_progress' && subs.every((s) => s.done)) {
    moveTask(db, taskId, 'in_review', agent ?? 'auto');
    moved = true;
  }
  return { task: getTask(db, taskId), moved };
}

const CARD_COLUMNS =
  'id, title, lane, tag, skill, assigned_agent AS agent, review_rounds AS rounds, updated_at, phase_id, blocked_at, blocked_reason, subtasks';

type CardRow = Omit<CardSummary, 'subs' | 'blocked'> & { subtasks: string | null; blocked_at: number | null };

function toSummary(row: CardRow): CardSummary {
  const { subtasks, blocked_at, ...card } = row;
  return { ...card, blocked: !!blocked_at, subs: progressOf(subtasks) };
}

export function getBoard(db: DB, projectId: string): CardSummary[] {
  return (
    db
      .prepare(`SELECT ${CARD_COLUMNS} FROM tasks WHERE project_id = ? ORDER BY lane, position`)
      .all(projectId) as CardRow[]
  ).map(toSummary);
}

export function getActiveCards(db: DB, projectId: string): CardSummary[] {
  return (
    db
      .prepare(
        `SELECT ${CARD_COLUMNS} FROM tasks WHERE project_id = ? AND lane = 'in_progress' ORDER BY position`,
      )
      .all(projectId) as CardRow[]
  ).map(toSummary);
}

/**
 * Top backlog card whose depends_on are all done, or null. Scoped to the active
 * phase when the project has one; otherwise (flat/legacy) the whole backlog.
 */
export function getNextCard(db: DB, projectId: string): Task | null {
  const active = getActivePhase(db, projectId);
  const backlog = (
    active
      ? db.prepare(
          `SELECT * FROM tasks WHERE project_id = ? AND lane = 'backlog' AND phase_id = ? ORDER BY position`,
        ).all(projectId, active.id)
      : db.prepare(
          `SELECT * FROM tasks WHERE project_id = ? AND lane = 'backlog' ORDER BY position`,
        ).all(projectId)
  ) as Task[];
  const isDone = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND lane = 'done'`);
  for (const task of backlog) {
    const deps: string[] = task.depends_on ? JSON.parse(task.depends_on) : [];
    if (deps.every((id) => isDone.get(id))) return task;
  }
  return null;
}

export function getRecentEvents(db: DB, projectId: string, limit = 20): TaskEvent[] {
  return db
    .prepare('SELECT * FROM task_events WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as TaskEvent[];
}

// ── team roster: named agents + their assigned skill (persona) ──────
export function listTeam(db: DB): TeamMember[] {
  return db.prepare('SELECT * FROM team_members ORDER BY created_at').all() as TeamMember[];
}

export function createTeamMember(
  db: DB,
  name: string,
  opts: { skill?: string | null; color?: string | null } = {},
): TeamMember {
  const member: TeamMember = {
    id: shortId(),
    name,
    skill: opts.skill ?? null,
    color: opts.color ?? null,
    created_at: now(),
  };
  db.prepare('INSERT INTO team_members (id, name, skill, color, created_at) VALUES (?, ?, ?, ?, ?)').run(
    member.id,
    member.name,
    member.skill,
    member.color,
    member.created_at,
  );
  return member;
}

const TEAM_FIELDS = ['name', 'skill', 'color'] as const;

export function updateTeamMember(
  db: DB,
  id: string,
  patch: Partial<Pick<TeamMember, 'name' | 'skill' | 'color'>>,
): TeamMember {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const field of TEAM_FIELDS) {
    if (!(field in patch)) continue;
    sets.push(`${field} = ?`);
    values.push(patch[field] ?? null);
  }
  if (sets.length) db.prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  const member = db.prepare('SELECT * FROM team_members WHERE id = ?').get(id) as TeamMember | undefined;
  if (!member) throw new Error(`no such team member: ${id}`);
  return member;
}

export function deleteTeamMember(db: DB, id: string): void {
  db.prepare('DELETE FROM team_members WHERE id = ?').run(id);
}

// ── activity stats: tokens / lines / time per build run ─────────────
export function recordActivity(
  db: DB,
  a: {
    project_id: string;
    task_id: string;
    agent?: string | null;
    agent_id?: string | null;
    tokens: number;
    tokens_out: number;
    lines_added: number;
    lines_removed: number;
    ms: number;
  },
): void {
  db.prepare(
    `INSERT INTO card_activity (project_id, task_id, agent, agent_id, tokens, tokens_out, lines_added, lines_removed, ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.project_id,
    a.task_id,
    a.agent ?? null,
    a.agent_id ?? null,
    a.tokens,
    a.tokens_out,
    a.lines_added,
    a.lines_removed,
    a.ms,
    now(),
  );
}

const TOTALS_SELECT = `COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(tokens_out),0) AS tokens_out,
  COALESCE(SUM(lines_added),0) AS lines_added, COALESCE(SUM(lines_removed),0) AS lines_removed, COALESCE(SUM(ms),0) AS ms`;

export function cardTotals(db: DB, taskId: string): CardTotals {
  return db
    .prepare(`SELECT ${TOTALS_SELECT} FROM card_activity WHERE task_id = ?`)
    .get(taskId) as CardTotals;
}

export function getStats(db: DB, projectId: string): ProjectStats {
  const agents = db
    .prepare(
      `SELECT COALESCE(agent, '—') AS agent, COUNT(DISTINCT task_id) AS cards, ${TOTALS_SELECT}
       FROM card_activity WHERE project_id = ? GROUP BY agent ORDER BY tokens DESC`,
    )
    .all(projectId) as AgentStat[];
  const totals = db
    .prepare(`SELECT COUNT(DISTINCT task_id) AS cards, ${TOTALS_SELECT} FROM card_activity WHERE project_id = ?`)
    .get(projectId) as CardTotals & { cards: number };
  return { totals, agents };
}

// ── attention: the "manage by exception" queue ──────────────────────
const STALL_WARN_MS = 15 * 60_000;
const STALL_HARD_MS = 40 * 60_000;
const REVIEW_GRACE_MS = 10 * 60_000;
const MERGE_GRACE_MS = 10 * 60_000;
const SEV_RANK: Record<AttentionSeverity, number> = { blocker: 0, warn: 1, info: 2 };

/**
 * Cards that need a human decision, ranked. Pure reads over tasks/reviews/
 * task_events. One row per card — the most severe applicable reason wins.
 */
export function getAttention(db: DB, projectId: string): AttentionItem[] {
  const nowTs = now();
  const tasks = db
    .prepare(
      `SELECT id, title, lane, requirements, subtasks, depends_on, assigned_agent, phase_id, created_at, blocked_at, blocked_reason
       FROM tasks WHERE project_id = ? AND lane != 'done'`,
    )
    .all(projectId) as Pick<
    Task,
    'id' | 'title' | 'lane' | 'requirements' | 'subtasks' | 'depends_on' | 'assigned_agent' | 'phase_id' | 'created_at' | 'blocked_at' | 'blocked_reason'
  >[];

  // impact: how many open cards depend on each card
  const blocking = new Map<string, number>();
  for (const t of tasks) {
    const deps: string[] = t.depends_on ? JSON.parse(t.depends_on) : [];
    for (const d of deps) blocking.set(d, (blocking.get(d) ?? 0) + 1);
  }

  const lastEventAt = db.prepare(`SELECT MAX(created_at) AS t FROM task_events WHERE task_id = ?`);
  const failCount = db.prepare(`SELECT COUNT(*) AS c FROM reviews WHERE task_id = ? AND verdict = 'fail'`);
  const lastFailAt = db.prepare(`SELECT MAX(created_at) AS t FROM reviews WHERE task_id = ? AND verdict = 'fail'`);
  const latestReview = db.prepare(`SELECT verdict, created_at FROM reviews WHERE task_id = ? ORDER BY id DESC LIMIT 1`);
  const enteredInReview = db.prepare(
    `SELECT MAX(created_at) AS t FROM task_events WHERE task_id = ? AND type = 'move' AND payload LIKE '%"to":"in_review"%'`,
  );

  const mins = (ms: number) => Math.round(ms / 60_000);
  const items: AttentionItem[] = [];

  for (const t of tasks) {
    const base = {
      card_id: t.id,
      title: t.title,
      blocking: blocking.get(t.id) ?? 0,
      agent: t.assigned_agent,
      phase_id: t.phase_id,
    };
    const fails = (failCount.get(t.id) as { c: number }).c;
    const latest = latestReview.get(t.id) as { verdict: string; created_at: number } | undefined;

    // a builder-raised blocker outranks every derived signal — we know exactly why it's stuck
    if (t.blocked_at) {
      items.push({
        ...base,
        kind: 'blocked',
        severity: 'blocker',
        reason: t.blocked_reason ?? 'Blocked — needs your decision',
        since: t.blocked_at,
      });
      continue;
    }
    if (fails >= 2) {
      items.push({
        ...base,
        kind: 'review_failed',
        severity: 'blocker',
        reason: `Failed review ${fails}× — hard cap, needs your call`,
        since: (lastFailAt.get(t.id) as { t: number | null }).t ?? t.created_at,
      });
      continue;
    }
    if (latest?.verdict === 'pass' && nowTs - latest.created_at > MERGE_GRACE_MS) {
      items.push({
        ...base,
        kind: 'merge_conflict',
        severity: 'blocker',
        reason: 'Passed review but not merged — check for conflict',
        since: latest.created_at,
      });
      continue;
    }
    if (t.lane === 'in_progress') {
      const last = (lastEventAt.get(t.id) as { t: number | null }).t ?? t.created_at;
      const idle = nowTs - last;
      if (idle > STALL_WARN_MS) {
        items.push({
          ...base,
          kind: 'stalled',
          severity: idle > STALL_HARD_MS ? 'blocker' : 'warn',
          reason: `Agent quiet ${mins(idle)}m — may be stuck`,
          since: last,
        });
        continue;
      }
    }
    if (t.lane === 'in_review') {
      const entered = (enteredInReview.get(t.id) as { t: number | null }).t ?? t.created_at;
      if ((!latest || latest.created_at < entered) && nowTs - entered > REVIEW_GRACE_MS) {
        items.push({
          ...base,
          kind: 'awaiting_review',
          severity: 'warn',
          reason: `In review ${mins(nowTs - entered)}m, no verdict — dispatch reviewer`,
          since: entered,
        });
        continue;
      }
    }
    if (t.lane === 'backlog' && !t.requirements && !t.subtasks) {
      items.push({
        ...base,
        kind: 'needs_spec',
        severity: 'warn',
        reason: 'No spec yet — write requirements before dispatch',
        since: t.created_at,
      });
      continue;
    }
  }

  // sync conflicts: derived purely from sync_link hash state (no remote fetch).
  // One blocker item per conflicted link, keyed to its local card. detectSyncConflicts
  // already skips links whose local card is gone, so getTask below is safe.
  for (const { link, reason } of detectSyncConflicts(db, projectId)) {
    const card = getTask(db, link.local_id);
    items.push({
      card_id: link.local_id,
      title: card.title,
      kind: 'sync_conflict',
      severity: 'blocker',
      reason,
      since: link.last_synced_at ?? link.updated_at,
      blocking: blocking.get(link.local_id) ?? 0,
      agent: card.assigned_agent,
      phase_id: card.phase_id,
    });
  }

  // a builder-raised blocker is an explicit "I need you" — it outranks other
  // same-severity (derived) signals, then most-depended-on, then oldest.
  const blockedFirst = (i: AttentionItem) => (i.kind === 'blocked' ? 0 : 1);
  items.sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      blockedFirst(a) - blockedFirst(b) ||
      b.blocking - a.blocking ||
      a.since - b.since,
  );
  return items;
}

// ── sync_links: local<->remote link state for the bridge (Phase 5 foundations) ──

export interface CreateSyncLinkInput {
  project_id?: string | null;
  local_id: string;
  provider: string;
  external_id?: string | null;
}

/**
 * Create a local<->remote link row. The sync bookkeeping fields
 * (local_hash/remote_hash/last_synced_at) start null — the sync engine sets
 * them later via updateSyncLink. Emits no events (pure bridge metadata).
 */
export function createSyncLink(db: DB, input: CreateSyncLinkInput): SyncLink {
  if (!input.local_id) throw new Error('sync_link local_id is required');
  if (!input.provider) throw new Error('sync_link provider is required');
  const ts = now();
  const link: SyncLink = {
    id: shortId(),
    project_id: input.project_id ?? null,
    local_id: input.local_id,
    provider: input.provider,
    external_id: input.external_id ?? null,
    local_hash: null,
    remote_hash: null,
    last_synced_at: null,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO sync_links (id, project_id, local_id, provider, external_id, local_hash, remote_hash, last_synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    link.id,
    link.project_id,
    link.local_id,
    link.provider,
    link.external_id,
    link.local_hash,
    link.remote_hash,
    link.last_synced_at,
    link.created_at,
    link.updated_at,
  );
  return link;
}

/** Lookup a sync link by id, or null. */
export function getSyncLink(db: DB, id: string): SyncLink | null {
  const row = db.prepare('SELECT * FROM sync_links WHERE id = ?').get(id) as SyncLink | undefined;
  return row ?? null;
}

/** Lookup the sync link for a (provider, local_id) pair, or null (the engine's key). */
export function getSyncLinkByLocal(db: DB, provider: string, localId: string): SyncLink | null {
  const row = db
    .prepare('SELECT * FROM sync_links WHERE provider = ? AND local_id = ?')
    .get(provider, localId) as SyncLink | undefined;
  return row ?? null;
}

/**
 * List sync links, oldest-first (created_at). Optional filters — applied only
 * when provided — narrow by provider and/or project_id.
 */
export function listSyncLinks(
  db: DB,
  opts: { provider?: string; project_id?: string } = {},
): SyncLink[] {
  const { clause, params } = buildWhere({
    provider: opts.provider,
    project_id: opts.project_id,
  });
  return db
    .prepare(`SELECT * FROM sync_links ${clause}ORDER BY created_at`)
    .all(...params) as SyncLink[];
}

const SYNC_LINK_FIELDS = ['external_id', 'local_hash', 'remote_hash', 'last_synced_at'] as const;

/**
 * Patch a sync link's mutable fields (external_id, local_hash, remote_hash,
 * last_synced_at) — this is how the sync engine records a sync. Only provided
 * keys are written; updated_at is always bumped. Returns the updated SyncLink.
 */
export function updateSyncLink(
  db: DB,
  id: string,
  patch: {
    external_id?: string | null;
    local_hash?: string | null;
    remote_hash?: string | null;
    last_synced_at?: number | null;
  },
): SyncLink {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const field of SYNC_LINK_FIELDS) {
    if (!(field in patch)) continue;
    sets.push(`${field} = ?`);
    params.push(patch[field] ?? null);
  }
  sets.push('updated_at = ?');
  params.push(now());
  db.prepare(`UPDATE sync_links SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  const link = getSyncLink(db, id);
  if (!link) throw new Error(`no such sync_link: ${id}`);
  return link;
}

/** A sync link whose local and remote both diverged from the last synced state. */
export interface SyncConflict {
  link: SyncLink;
  reason: string; // human sentence for the Attention row
}

/**
 * The project's CONFLICTED sync links — derived PURELY from stored hash state
 * (no HTTP, no remote fetch). A link conflicts when ALL hold:
 *   - it's been synced: local_hash != null AND last_synced_at != null
 *   - local moved: taskContentHash(getTask(link.local_id)) != link.local_hash
 *   - remote moved: remote_hash != null AND remote_hash != link.local_hash
 *   - they disagree: currentLocalHash != remote_hash
 * A link whose local card is gone (getTask throws) is skipped, not crashed —
 * mirroring detectChanges in src/daemon/sync.ts.
 */
export function detectSyncConflicts(db: DB, projectId: string): SyncConflict[] {
  const conflicts: SyncConflict[] = [];
  for (const link of listSyncLinks(db, { project_id: projectId })) {
    // never synced → not a conflict
    if (link.local_hash == null || link.last_synced_at == null) continue;
    // remote never moved (or unknown) → a plain local change, not a conflict
    if (link.remote_hash == null || link.remote_hash === link.local_hash) continue;

    let task: Task;
    try {
      task = getTask(db, link.local_id);
    } catch {
      // local card is gone — skip this link, don't crash the sweep.
      continue;
    }
    const currentLocalHash = taskContentHash(task);
    // local must have moved since last sync, and now disagree with remote
    if (currentLocalHash === link.local_hash) continue;
    if (currentLocalHash === link.remote_hash) continue;

    conflicts.push({
      link,
      reason: `Sync conflict with ${link.provider}: local and remote both changed since last sync`,
    });
  }
  return conflicts;
}

/**
 * Resolve a sync conflict by reconciling the link's stored HASH STATE so
 * detectSyncConflicts no longer flags it (and the sync_conflict Attention item
 * clears). LOCAL-ONLY — this reconciles bookkeeping, it does NOT fetch/merge/apply
 * any provider content.
 *   - 'local'  (accept local): stamp both hashes to the card's CURRENT content →
 *     "local moved" (currentLocalHash != local_hash) becomes false.
 *   - 'remote' (accept remote): set local_hash = remote_hash → "remote moved"
 *     (remote_hash != local_hash) becomes false.
 * Throws if the id doesn't exist (mirrors resolveBlocker / updateSyncLink).
 */
export function resolveSyncConflict(db: DB, linkId: string, resolution: 'local' | 'remote'): SyncLink {
  const link = getSyncLink(db, linkId);
  if (!link) throw new Error(`no such sync_link: ${linkId}`);
  if (resolution === 'local') {
    const currentLocalHash = taskContentHash(getTask(db, link.local_id));
    return updateSyncLink(db, linkId, {
      local_hash: currentLocalHash,
      remote_hash: currentLocalHash,
      last_synced_at: now(),
    });
  }
  // 'remote': reconcile the hash only. Actually applying the remote CONTENT to
  // the local card is Phase 9; here we just make local_hash == remote_hash so
  // the "remote moved" divergence — and its conflict Attention item — clears.
  return updateSyncLink(db, linkId, {
    local_hash: link.remote_hash,
    last_synced_at: now(),
  });
}
