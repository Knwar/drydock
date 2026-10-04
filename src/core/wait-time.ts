/**
 * Time waiting on the human: how long work sits on "needs you" (a session
 * waiting on a permission prompt or question) and on raised blockers.
 *
 *  - needs_you intervals are persisted in wait_intervals from the daemon's
 *    in-memory session state changes (recordSessionChange); a daemon restart
 *    closes the ones left open (closeOpenWaits). needs_you is exempt from the
 *    10-minute offline rule (a session on a prompt sends no pings): it ends at
 *    the main session's next ping, a forget, or a 24h ceiling.
 *  - The Notification hook (.claude/hooks/on-notify.js) maps permission_prompt,
 *    elicitation_dialog and unknown types to 'needs you', and idle_prompt (or a
 *    "waiting for your input" message) to 'idle'. Its idle ping is marked
 *    source 'notification', and the daemon ignores it while the session is in
 *    needs_you: Claude Code fires idle_prompt after ~60s on screen, so during
 *    the same waiting period it means "still waiting", not "answered". (An
 *    unmarked idle, i.e. the Stop hook or an older hook copy, ends the wait.)
 *  - Blocker intervals are derived from task_events by metrics.ts
 *    (deriveLaneHistory: block -> unblock / assign / redirect / done / delete).
 *
 * closed_by values:
 *  - 'working' | 'idle': the next main-session ping moved the session there
 *  - 'abandoned': no main ping for 24h (NEEDS_YOU_MAX_MS); ends at started + 24h
 *    (later only if a subagent stayed live past that)
 *  - 'forget': the project was removed / merged away
 *  - 'pty_exit': the project's embedded terminal exited while waiting
 *  - 'restart': left open by a previous daemon run; ends at min(startup, started + 24h)
 *  - 'superseded': defensive close of a stray open row when a new wait opens
 *
 * Window rules (for [from, to]; open intervals run to `now`):
 *  - count / totalMs: intervals overlapping the window; time clipped to it.
 *  - duration / resolution percentiles: completed intervals that ENDED in the
 *    window, full length (nearest-rank, as in metrics.ts).
 *  - waiting: what is open right now, regardless of the window.
 *  - A phase filter keeps needs_you intervals only when their card is in that
 *    phase (an interval with no known card is dropped); a workType filter
 *    likewise keeps only those whose card has that work type.
 */
import type { DB } from './db.js';
import {
  deriveLaneHistory,
  loadCardHistories,
  MetricsParamError,
  percentile,
  type MetricsFilter,
} from './metrics.js';

// ---------- types ----------

/** The session-state change the daemon reports (see daemon/session-state.ts). */
export interface SessionChange {
  projectId: string;
  from: string;
  to: string;
  at: number;
  cause?: string;
  view: { main: { agent: string; agent_id: string | null; task_id: string | null; detail: string } | null };
}

export interface WaitRow {
  id: number;
  project_id: string;
  agent_id: string | null;
  task_id: string | null;
  kind: string;
  started_at: number;
  ended_at: number | null;
  reason: string | null;
  closed_by: string | null;
}

/** A needs_you interval with its card's phase (null when no card / no phase). */
export type NeedsYouInterval = WaitRow & { phase_id: string | null };

export interface BlockerInterval {
  project_id: string;
  task_id: string;
  title: string;
  phase_id: string | null;
  from: number;
  to: number | null;
  reason: string | null;
}

export interface WaitTotals {
  count: number;
  totalMs: number;
}

export interface WaitMetrics {
  range: { from: number; to: number; tz: string };
  needsYou: WaitTotals & { duration: { p50: number | null; p85: number | null; count: number } };
  blocked: WaitTotals & { resolution: { p50: number | null; p85: number | null; count: number } };
  byPhase: { phase_id: string | null; title: string | null; needsYou: WaitTotals; blocked: WaitTotals }[];
  byBoard: { project_id: string; name: string | null; needsYou: WaitTotals; blocked: WaitTotals }[];
  waiting: {
    count: number;
    longestMs: number | null;
    needsYou: { project_id: string; agent_id: string | null; task_id: string | null; reason: string | null; since: number; waitingMs: number }[];
    blockers: { project_id: string; task_id: string; title: string; phase_id: string | null; reason: string | null; since: number; waitingMs: number }[];
  };
}

// ---------- persistence ----------

/** Open / close a project's needs_you interval on a session state change. */
export function recordSessionChange(db: DB, c: SessionChange): void {
  if (c.from === c.to) return;
  if (c.from === 'needs_you') closeWait(db, c.projectId, c.at, c.cause ?? c.to);
  if (c.to === 'needs_you') {
    closeWait(db, c.projectId, c.at, 'superseded'); // never two open at once
    const main = c.view.main;
    db.prepare(
      `INSERT INTO wait_intervals (project_id, agent_id, task_id, kind, started_at, reason)
       VALUES (?, ?, ?, 'needs_you', ?, ?)`,
    ).run(c.projectId, main ? (main.agent_id ?? main.agent) : null, main?.task_id ?? null, c.at, main?.detail || null);
  }
}

/** Close a project's open needs_you interval(s) at `at`. */
export function closeWait(db: DB, projectId: string, at: number, closedBy: string): number {
  return db
    .prepare(
      `UPDATE wait_intervals SET ended_at = MAX(started_at, ?), closed_by = ?
       WHERE project_id = ? AND kind = 'needs_you' AND ended_at IS NULL`,
    )
    .run(at, closedBy, projectId).changes;
}

/**
 * On daemon start: close every interval a previous run left open, marked
 * closed_by 'restart'. Each ends at `at`, capped at started_at + capMs (the
 * daemon passes the 24h needs_you ceiling), so a long downtime does not
 * inflate the wait beyond what the live ceiling would allow.
 */
export function closeOpenWaits(db: DB, at: number, capMs: number): number {
  return db
    .prepare(
      `UPDATE wait_intervals SET ended_at = MAX(started_at, MIN(?, started_at + ?)), closed_by = 'restart'
       WHERE ended_at IS NULL`,
    )
    .run(at, capMs).changes;
}

// ---------- aggregation (pure) ----------

const zero = (): WaitTotals => ({ count: 0, totalMs: 0 });

export interface WaitOptions {
  tz: string;
  now: number;
  from?: number;
  to?: number;
  /** Display names: phase id -> title, board (project) id -> name. */
  phaseTitles?: Map<string, string>;
  boardNames?: Map<string, string>;
}

export function computeWait(needs: NeedsYouInterval[], blockers: BlockerInterval[], opts: WaitOptions): WaitMetrics {
  const { now } = opts;
  const to = opts.to ?? now;
  const earliest = blockers.reduce((m, b) => Math.min(m, b.from), needs.reduce((m, n) => Math.min(m, n.started_at), to));
  const from = opts.from ?? earliest;
  if (from > to) throw new MetricsParamError('from must be <= to');
  const end = Math.min(to, now);

  // [start, stop|now] clipped to the window; null when it does not overlap
  const clip = (start: number, stop: number | null): number | null => {
    const e = stop ?? now;
    if (start > to || e < from) return null;
    return Math.max(0, Math.min(e, end) - Math.max(start, from));
  };
  const ended = (stop: number | null) => stop !== null && stop >= from && stop <= to;

  const phases = new Map<string | null, WaitMetrics['byPhase'][number]>();
  const boards = new Map<string, WaitMetrics['byBoard'][number]>();
  const phase = (id: string | null) => {
    let p = phases.get(id);
    if (!p) phases.set(id, (p = { phase_id: id, title: id === null ? null : (opts.phaseTitles?.get(id) ?? null), needsYou: zero(), blocked: zero() }));
    return p;
  };
  const board = (id: string) => {
    let b = boards.get(id);
    if (!b) boards.set(id, (b = { project_id: id, name: opts.boardNames?.get(id) ?? null, needsYou: zero(), blocked: zero() }));
    return b;
  };
  const add = (t: WaitTotals, ms: number) => {
    t.count++;
    t.totalMs += ms;
  };

  const needsTotals = zero();
  const needsDurations: number[] = [];
  for (const n of needs) {
    const ms = clip(n.started_at, n.ended_at);
    if (ms === null) continue;
    add(needsTotals, ms);
    add(phase(n.phase_id).needsYou, ms);
    add(board(n.project_id).needsYou, ms);
    if (ended(n.ended_at)) needsDurations.push(n.ended_at! - n.started_at);
  }

  const blockedTotals = zero();
  const resolutions: number[] = [];
  for (const b of blockers) {
    const ms = clip(b.from, b.to);
    if (ms === null) continue;
    add(blockedTotals, ms);
    add(phase(b.phase_id).blocked, ms);
    add(board(b.project_id).blocked, ms);
    if (ended(b.to)) resolutions.push(b.to! - b.from);
  }

  const p5085 = (values: number[]) => {
    const s = [...values].sort((a, b) => a - b);
    return { p50: percentile(s, 50), p85: percentile(s, 85), count: s.length };
  };

  const waitingNeeds = needs
    .filter((n) => n.ended_at === null)
    .map((n) => ({
      project_id: n.project_id,
      agent_id: n.agent_id,
      task_id: n.task_id,
      reason: n.reason,
      since: n.started_at,
      waitingMs: Math.max(0, now - n.started_at),
    }))
    .sort((a, b) => b.waitingMs - a.waitingMs);
  const waitingBlockers = blockers
    .filter((b) => b.to === null)
    .map((b) => ({
      project_id: b.project_id,
      task_id: b.task_id,
      title: b.title,
      phase_id: b.phase_id,
      reason: b.reason,
      since: b.from,
      waitingMs: Math.max(0, now - b.from),
    }))
    .sort((a, b) => b.waitingMs - a.waitingMs);
  const longest = Math.max(waitingNeeds[0]?.waitingMs ?? -Infinity, waitingBlockers[0]?.waitingMs ?? -Infinity);

  const byTotal = (a: { needsYou: WaitTotals; blocked: WaitTotals }, b: { needsYou: WaitTotals; blocked: WaitTotals }) =>
    b.needsYou.totalMs + b.blocked.totalMs - (a.needsYou.totalMs + a.blocked.totalMs);
  return {
    range: { from, to, tz: opts.tz },
    needsYou: { ...needsTotals, duration: p5085(needsDurations) },
    blocked: { ...blockedTotals, resolution: p5085(resolutions) },
    byPhase: [...phases.values()].sort(byTotal),
    byBoard: [...boards.values()].sort(byTotal),
    waiting: {
      count: waitingNeeds.length + waitingBlockers.length,
      longestMs: Number.isFinite(longest) ? longest : null,
      needsYou: waitingNeeds,
      blockers: waitingBlockers,
    },
  };
}

// ---------- DB reader ----------

/** Board ids in scope: each project id plus its verticals. */
function boardIds(db: DB, projectIds: string[]): string[] {
  if (!projectIds.length) return [];
  const qs = projectIds.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id FROM projects WHERE parent_id IN (${qs})`).all(...projectIds) as { id: string }[];
  return [...new Set([...projectIds, ...rows.map((r) => r.id)])];
}

/**
 * workType keeps only waits tied to a card of that work type ('none': an
 * unclassified card that still exists); a needs_you interval with no (or a
 * deleted) card is then dropped, as with a phase filter.
 */
export type WaitFilter = Pick<MetricsFilter, 'projectIds' | 'phaseId' | 'workType' | 'from' | 'to'>;

/** needs_you intervals in scope (open ones always; closed ones overlapping the window). */
export function loadNeedsYou(db: DB, filter: WaitFilter): NeedsYouInterval[] {
  const where = ["w.kind = 'needs_you'"];
  const params: (string | number)[] = [];
  if (filter.projectIds) {
    const ids = boardIds(db, filter.projectIds);
    if (!ids.length) return [];
    where.push(`w.project_id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (filter.phaseId !== undefined) {
    where.push('t.phase_id = ?');
    params.push(filter.phaseId);
  }
  if (filter.workType === 'none') where.push('t.id IS NOT NULL AND t.work_type IS NULL');
  else if (filter.workType !== undefined) {
    where.push('t.work_type = ?');
    params.push(filter.workType);
  }
  if (filter.to !== undefined) {
    where.push('w.started_at <= ?');
    params.push(filter.to);
  }
  if (filter.from !== undefined) {
    where.push('(w.ended_at IS NULL OR w.ended_at >= ?)');
    params.push(filter.from);
  }
  return db
    .prepare(
      `SELECT w.*, t.phase_id AS phase_id FROM wait_intervals w LEFT JOIN tasks t ON t.id = w.task_id
       WHERE ${where.join(' AND ')} ORDER BY w.started_at, w.id`,
    )
    .all(...params) as NeedsYouInterval[];
}

/** Blocker intervals of the cards in scope, derived from their events. */
export function loadBlockers(db: DB, filter: WaitFilter): BlockerInterval[] {
  return loadCardHistories(db, { projectIds: filter.projectIds, phaseId: filter.phaseId, workType: filter.workType }).flatMap(({ card, events }) =>
    deriveLaneHistory(card, events).blocked.map((b) => ({
      project_id: card.project_id,
      task_id: card.id,
      title: card.title,
      phase_id: card.phase_id,
      from: b.from,
      to: b.to,
      reason: b.reason,
    })),
  );
}

export function waitMetrics(db: DB, filter: WaitFilter, opts: { tz: string; now: number }): WaitMetrics {
  if (filter.from !== undefined && filter.from > (filter.to ?? opts.now)) throw new MetricsParamError('from must be <= to');
  const needs = loadNeedsYou(db, filter);
  const blockers = loadBlockers(db, filter);
  const phaseTitles = new Map((db.prepare('SELECT id, title FROM phases').all() as { id: string; title: string }[]).map((p) => [p.id, p.title]));
  const boardNames = new Map((db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  return computeWait(needs, blockers, { ...opts, from: filter.from, to: filter.to, phaseTitles, boardNames });
}
