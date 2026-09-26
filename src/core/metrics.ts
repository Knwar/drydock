/**
 * Flow-metrics core: derives each card's lane history from its task_events and
 * computes per-card metrics (lead/cycle time, time in lane, blocked time,
 * review rounds, current age). The derivation functions are pure (plain data
 * in, plain data out, `now` passed in); the DB reader `loadCardHistories` is
 * the only part that touches SQLite.
 *
 * What the event log actually records (see board.ts):
 *  - create   {title, phase_id}        card always starts in 'backlog'
 *  - move     {from, to}               only when the lane really changes
 *  - redirect {from, note}             lane -> 'backlog', clears the blocker
 *  - assign   {worktree, branch, skill} clears the blocker (no unblock event);
 *                                       a backlog/queued card then gets a move
 *  - block    {reason} / unblock {note}
 *  - review   {verdict, round, findings}
 *  - delete   {id, title}              task_id is NULL and the card's own
 *                                       events are deleted with it
 */
import type { DB } from './db.js';
import { LANES, type Lane, type Task } from './types.js';

// ---------- types ----------

/** The task columns the metrics need. */
export type MetricsCard = Pick<
  Task,
  | 'id'
  | 'project_id'
  | 'phase_id'
  | 'title'
  | 'lane'
  | 'tag'
  | 'assigned_agent'
  | 'blocked_at'
  | 'blocked_reason'
  | 'review_rounds'
  | 'created_at'
  | 'updated_at'
>;

/** A task_events row (payload may be the raw JSON string or already parsed). */
export interface MetricsEvent {
  id: number;
  type: string;
  payload: string | Record<string, unknown> | null;
  agent?: string | null;
  created_at: number;
}

export interface CardHistory {
  card: MetricsCard;
  events: MetricsEvent[];
}

export interface LaneInterval {
  lane: Lane;
  from: number;
  to: number | null; // null = still in this lane
}

export interface BlockedInterval {
  from: number;
  to: number | null; // null = still blocked
  reason: string | null;
}

export interface LaneHistory {
  intervals: LaneInterval[];
  blocked: BlockedInterval[];
  reviews: { at: number; verdict: string | null; round: number | null }[];
  /** true when the history had to be reconstructed from created_at/updated_at or had gaps. */
  partial: boolean;
  deletedAt: number | null;
}

export interface CardMetrics {
  id: string;
  project_id: string;
  phase_id: string | null;
  title: string;
  tag: string | null;
  agent: string | null;
  lane: Lane; // current lane (last derived interval)
  createdAt: number; // start of the first interval
  doneAt: number | null; // last entry into 'done', only if the card is currently done
  leadTimeMs: number | null; // created -> done
  cycleStartAt: number | null; // first queued, else first in_progress
  cycleTimeMs: number | null; // cycleStartAt -> done
  timeInLaneMs: Record<Lane, number>; // open intervals count up to `now`
  blockedMs: number; // open blocker counts up to `now`
  blocked: boolean; // currently blocked
  reviewRounds: number;
  reviewRoundsSource: 'reviews' | 'in_review_entries' | 'task';
  ageMs: number; // now - createdAt
  ageInLaneMs: number | null; // now - entry into the current lane; null when deleted
  deleted: boolean;
  partial: boolean;
}

/** Shared filter for every metrics query. All fields optional (AND-ed). */
export interface MetricsFilter {
  /** Project ids; a workspace id expands to itself + its verticals. */
  projectIds?: string[];
  phaseId?: string;
  tag?: string;
  /** Card's assigned agent, or any agent recorded on its events / card_activity. */
  agent?: string;
  /** Epoch ms window: keeps cards whose life (created -> done/deleted/open) overlaps it. */
  from?: number;
  to?: number;
}

// ---------- pure derivation ----------

const isLane = (x: unknown): x is Lane => typeof x === 'string' && (LANES as readonly string[]).includes(x);

function parsePayload(p: MetricsEvent['payload']): Record<string, unknown> {
  if (p == null) return {};
  if (typeof p !== 'string') return p;
  try {
    const v = JSON.parse(p) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Events in true order: by timestamp, ties (and equal ms) broken by rowid. */
export function sortEvents<E extends MetricsEvent>(events: E[]): E[] {
  return [...events].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
}

/**
 * Derive a card's ordered lane intervals and blocked intervals from its events.
 * Robust to: no events at all, a missing create event, moves whose `from`
 * disagrees with the derived lane, out-of-order rows, repeated round trips,
 * and a final derived lane that disagrees with the card's current lane (each
 * of these sets `partial`).
 */
export function deriveLaneHistory(card: MetricsCard, events: MetricsEvent[]): LaneHistory {
  const sorted = sortEvents(events);
  let partial = false;
  const intervals: LaneInterval[] = [];
  const blocked: BlockedInterval[] = [];
  const reviews: LaneHistory['reviews'] = [];
  let deletedAt: number | null = null;

  const start = Math.min(card.created_at, sorted.length ? sorted[0].created_at : card.created_at);

  // Initial lane: a create event means backlog. Otherwise infer it from the
  // first lane-changing event's `from`, else the card's current lane.
  const hasCreate = sorted.some((e) => e.type === 'create');
  let initial: Lane = 'backlog';
  if (!hasCreate) {
    partial = true;
    const first = sorted.find((e) => e.type === 'move' || e.type === 'redirect');
    const from = first ? parsePayload(first.payload).from : undefined;
    initial = isLane(from) ? from : first ? 'backlog' : card.lane;
  }
  intervals.push({ lane: initial, from: start, to: null });

  const current = () => intervals[intervals.length - 1];
  const enter = (lane: Lane, at: number) => {
    const cur = current();
    if (cur.lane === lane) return;
    cur.to = at;
    intervals.push({ lane, from: at, to: null });
  };
  const openBlock = () => {
    const last = blocked[blocked.length - 1];
    return last && last.to === null ? last : null;
  };
  const closeBlock = (at: number) => {
    const b = openBlock();
    if (b) b.to = at;
  };

  for (const e of sorted) {
    if (deletedAt !== null) break;
    const p = parsePayload(e.payload);
    const at = e.created_at;
    switch (e.type) {
      case 'move': {
        if (isLane(p.from) && p.from !== current().lane) partial = true; // a transition is missing
        if (!isLane(p.to)) {
          partial = true;
          break;
        }
        enter(p.to, at);
        if (p.to === 'done') closeBlock(at);
        break;
      }
      case 'redirect':
        if (isLane(p.from) && p.from !== current().lane) partial = true;
        enter('backlog', at);
        closeBlock(at);
        break;
      case 'assign':
        closeBlock(at); // assignCard clears the blocker without an unblock event
        break;
      case 'block': {
        const reason = typeof p.reason === 'string' ? p.reason : null;
        const b = openBlock();
        if (b) b.reason = reason; // re-raised while blocked: keep the start, latest reason
        else blocked.push({ from: at, to: null, reason });
        break;
      }
      case 'unblock':
        closeBlock(at);
        break;
      case 'review':
        reviews.push({
          at,
          verdict: typeof p.verdict === 'string' ? p.verdict : null,
          round: typeof p.round === 'number' ? p.round : null,
        });
        break;
      case 'delete':
        deletedAt = at;
        current().to = at;
        closeBlock(at);
        break;
    }
  }

  if (deletedAt === null) {
    const lastTs = sorted.length ? sorted[sorted.length - 1].created_at : start;
    const fixAt = Math.max(card.updated_at, lastTs);
    // The row's lane is authoritative: reconcile a history that ends elsewhere.
    if (current().lane !== card.lane) {
      partial = true;
      enter(card.lane, fixAt);
    }
    const b = openBlock();
    if (card.blocked_at != null && !b) {
      partial = true;
      blocked.push({ from: card.blocked_at, to: null, reason: card.blocked_reason });
    } else if (card.blocked_at == null && b) {
      partial = true;
      b.to = fixAt;
    }
  }

  return { intervals, blocked, reviews, partial, deletedAt };
}

const span = (from: number, to: number | null, now: number) => Math.max(0, (to ?? now) - from);

/** Per-card metrics from a derived history. `now` closes any open interval. */
export function computeCardMetrics(card: MetricsCard, history: LaneHistory, now: number): CardMetrics {
  const { intervals, blocked, reviews, deletedAt } = history;
  const last = intervals[intervals.length - 1];
  const createdAt = intervals[0].from;

  const timeInLaneMs = Object.fromEntries(LANES.map((l) => [l, 0])) as Record<Lane, number>;
  for (const i of intervals) timeInLaneMs[i.lane] += span(i.from, i.to, now);

  const doneAt = last.lane === 'done' && deletedAt === null ? last.from : null;
  const firstEntry = (lane: Lane) => intervals.find((i) => i.lane === lane)?.from ?? null;
  const cycleStartAt = firstEntry('queued') ?? firstEntry('in_progress');

  let reviewRounds: number;
  let reviewRoundsSource: CardMetrics['reviewRoundsSource'];
  const inReviewEntries = intervals.filter((i) => i.lane === 'in_review').length;
  if (reviews.length) {
    reviewRounds = reviews.length;
    reviewRoundsSource = 'reviews';
  } else if (inReviewEntries) {
    reviewRounds = inReviewEntries;
    reviewRoundsSource = 'in_review_entries';
  } else {
    reviewRounds = card.review_rounds;
    reviewRoundsSource = 'task';
  }

  const openBlocked = blocked.some((b) => b.to === null);
  return {
    id: card.id,
    project_id: card.project_id,
    phase_id: card.phase_id,
    title: card.title,
    tag: card.tag,
    agent: card.assigned_agent,
    lane: last.lane,
    createdAt,
    doneAt,
    leadTimeMs: doneAt === null ? null : Math.max(0, doneAt - createdAt),
    cycleStartAt,
    cycleTimeMs: doneAt === null || cycleStartAt === null ? null : Math.max(0, doneAt - cycleStartAt),
    timeInLaneMs,
    blockedMs: blocked.reduce((s, b) => s + span(b.from, b.to, now), 0),
    blocked: openBlocked,
    reviewRounds,
    reviewRoundsSource,
    ageMs: Math.max(0, (deletedAt ?? now) - createdAt),
    ageInLaneMs: deletedAt === null ? span(last.from, null, now) : null,
    deleted: deletedAt !== null,
    partial: history.partial,
  };
}

/** Convenience: derive + compute in one call. */
export function cardMetrics(h: CardHistory, now: number): CardMetrics {
  return computeCardMetrics(h.card, deriveLaneHistory(h.card, h.events), now);
}

/** Does a card's life [created, done|deleted|open) overlap the filter's date window? */
export function inDateRange(m: Pick<CardMetrics, 'createdAt' | 'doneAt'> & { deletedAt?: number | null }, filter: MetricsFilter): boolean {
  const end = m.doneAt ?? m.deletedAt ?? Infinity;
  if (filter.to !== undefined && m.createdAt > filter.to) return false;
  if (filter.from !== undefined && end < filter.from) return false;
  return true;
}

// ---------- DB reader ----------

/** SQL WHERE (over tasks aliased `t`) for the non-date parts of a filter. */
function filterWhere(filter: MetricsFilter): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.projectIds) {
    if (filter.projectIds.length === 0) return { sql: 'WHERE 0', params };
    const qs = filter.projectIds.map(() => '?').join(', ');
    where.push(`(t.project_id IN (${qs}) OR t.project_id IN (SELECT id FROM projects WHERE parent_id IN (${qs})))`);
    params.push(...filter.projectIds, ...filter.projectIds);
  }
  if (filter.phaseId !== undefined) {
    where.push('t.phase_id = ?');
    params.push(filter.phaseId);
  }
  if (filter.tag !== undefined) {
    where.push('t.tag = ?');
    params.push(filter.tag);
  }
  if (filter.agent !== undefined) {
    where.push(
      `(t.assigned_agent = ?
        OR EXISTS (SELECT 1 FROM task_events a WHERE a.task_id = t.id AND a.agent = ?)
        OR EXISTS (SELECT 1 FROM card_activity c WHERE c.task_id = t.id AND c.agent = ?))`,
    );
    params.push(filter.agent, filter.agent, filter.agent);
  }
  // Coarse date prefilter; the precise overlap check needs the derived done time.
  if (filter.to !== undefined) {
    where.push('t.created_at <= ?');
    params.push(filter.to);
  }
  if (filter.from !== undefined) {
    // updated_at >= the done move, so this never drops a card that overlaps.
    where.push(`(t.lane != 'done' OR t.updated_at >= ?)`);
    params.push(filter.from);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Load the cards matching `filter` with their full event histories, in two
 * queries (cards, then all their events). Deleted cards are not returned: their
 * rows and events are removed by deleteTask.
 */
export function loadCardHistories(db: DB, filter: MetricsFilter = {}): CardHistory[] {
  const { sql, params } = filterWhere(filter);
  const cards = db
    .prepare(
      `SELECT t.id, t.project_id, t.phase_id, t.title, t.lane, t.tag, t.assigned_agent, t.blocked_at,
              t.blocked_reason, t.review_rounds, t.created_at, t.updated_at
       FROM tasks t ${sql} ORDER BY t.created_at, t.id`,
    )
    .all(...params) as MetricsCard[];
  const events = db
    .prepare(
      `SELECT e.id, e.task_id, e.type, e.payload, e.agent, e.created_at
       FROM task_events e JOIN tasks t ON t.id = e.task_id ${sql}
       ORDER BY e.created_at, e.id`,
    )
    .all(...params) as (MetricsEvent & { task_id: string })[];

  const byCard = new Map<string, MetricsEvent[]>(cards.map((c) => [c.id, []]));
  for (const { task_id, ...e } of events) byCard.get(task_id)?.push(e);
  const histories = cards.map((card) => ({ card, events: byCard.get(card.id)! }));
  if (filter.from === undefined && filter.to === undefined) return histories;
  return histories.filter((h) => {
    const d = deriveLaneHistory(h.card, h.events);
    const last = d.intervals[d.intervals.length - 1];
    return inDateRange({ createdAt: d.intervals[0].from, doneAt: last.lane === 'done' ? last.from : null }, filter);
  });
}
