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
 *  - phase_change {from, to}           the card's phase_id changed (burn scope)
 *  - reassign {from, to}               assignee changed (agent = the new one);
 *                                       does NOT close a blocker: only assign does
 *                                       (assignCard logs reassign + assign and is
 *                                       the only path that clears blocked_at)
 *
 * Rules the derivation applies:
 *  - Event order: (created_at, rowid). rowid is the true insertion order within
 *    a task, so while clocks are monotonic the two agree; when created_at goes
 *    backwards within a task (a clock step), rowid wins and the event's time is
 *    clamped up to the previous event's, so no interval ever has a negative
 *    span. In effect: sort by rowid, clamp times to be non-decreasing.
 *  - Redirect = fresh start: redirectTask resets review_rounds, so cycle start
 *    and review rounds count only from the last redirect (lead time still runs
 *    from creation).
 *  - Cycle start: first entry (after the last redirect) into queued, else
 *    in_progress, else in_review; a done card that skipped all three starts at
 *    its done time (cycle time 0). A done card never has a null cycle time.
 *  - Review rounds: review events (after the last redirect); without any, the
 *    completed reviews, i.e. in_review entries followed by a move out of
 *    in_review (a card sitting in its first review has 0); else the task column.
 */
import type { DB } from './db.js';
import { LANES, WORK_TYPES, type Lane, type Task, type WorkType } from './types.js';

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
> &
  Partial<Pick<Task, 'work_type'>>;

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
  /** The last redirect: its time and the interval / review index the fresh start begins at. */
  lastRedirect: { at: number; interval: number; review: number } | null;
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
  cycleStartAt: number | null; // since the last redirect: first queued, else in_progress, else in_review (done: else doneAt)
  cycleTimeMs: number | null; // cycleStartAt -> done; never null for a done card
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
  /** A work type, or 'none' for unclassified cards (work_type IS NULL). */
  workType?: WorkType | 'none';
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

/**
 * Events in true order. (created_at, rowid) with rowid authoritative when
 * created_at goes backwards, which is exactly rowid order (see the header);
 * deriveLaneHistory clamps the out-of-step timestamps.
 */
export function sortEvents<E extends MetricsEvent>(events: E[]): E[] {
  return [...events].sort((a, b) => a.id - b.id);
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
  let lastRedirect: LaneHistory['lastRedirect'] = null;

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

  let prevAt = -Infinity;
  for (const e of sorted) {
    if (deletedAt !== null) break;
    const p = parsePayload(e.payload);
    const at = Math.max(e.created_at, prevAt); // clock stepped back: rowid order wins
    prevAt = at;
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
        lastRedirect = { at, interval: intervals.length - 1, review: reviews.length };
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
    const lastTs = sorted.length ? Math.max(prevAt, start) : start;
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

  return { intervals, blocked, reviews, lastRedirect, partial, deletedAt };
}

const span = (from: number, to: number | null, now: number) => Math.max(0, (to ?? now) - from);

/** Per-card metrics from a derived history. `now` closes any open interval. */
export function computeCardMetrics(card: MetricsCard, history: LaneHistory, now: number): CardMetrics {
  const { intervals, blocked, deletedAt, lastRedirect } = history;
  const last = intervals[intervals.length - 1];
  const createdAt = intervals[0].from;

  const timeInLaneMs = Object.fromEntries(LANES.map((l) => [l, 0])) as Record<Lane, number>;
  for (const i of intervals) timeInLaneMs[i.lane] += span(i.from, i.to, now);

  const doneAt = last.lane === 'done' && deletedAt === null ? last.from : null;
  // A redirect is a fresh start: cycle start and review rounds count from it.
  const freshFrom = lastRedirect?.interval ?? 0;
  const fresh = intervals.slice(freshFrom);
  const reviews = history.reviews.slice(lastRedirect?.review ?? 0);
  const firstEntry = (lane: Lane) => fresh.find((i) => i.lane === lane)?.from ?? null;
  const cycleStartAt = firstEntry('queued') ?? firstEntry('in_progress') ?? firstEntry('in_review') ?? doneAt;

  let reviewRounds: number;
  let reviewRoundsSource: CardMetrics['reviewRoundsSource'];
  const inReviewIdx = intervals.flatMap((i, idx) => (idx >= freshFrom && i.lane === 'in_review' ? [idx] : []));
  if (reviews.length) {
    reviewRounds = reviews.length;
    reviewRoundsSource = 'reviews';
  } else if (inReviewIdx.length) {
    // completed reviews only: an in_review entry followed by a move out of it
    reviewRounds = inReviewIdx.filter((idx) => idx < intervals.length - 1).length;
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

// ---------- aggregation (pure) ----------
//
// Day buckets are calendar days in an IANA time zone (default: the process's
// local zone). Weeks are ISO weeks (Monday start) of those local days. Every
// series is zero-filled over the requested range.

/** A bad request parameter (the daemon maps it to 400; anything else is a 500). */
export class MetricsParamError extends Error {}

/** The process's local IANA time zone. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** True when `tz` is a time zone Intl accepts. */
export function isValidTimeZone(tz: string): boolean {
  try {
    zoneFormat(tz);
    return true;
  } catch {
    return false;
  }
}

function zonedParts(ts: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(zoneFormat(tz).formatToParts(ts).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local calendar day (YYYY-MM-DD) of an instant in `tz`. */
export function dayKey(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

/** Offset of `tz` from UTC at instant `ts`, in ms (local = utc + offset). */
function tzOffsetMs(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/** The instant a local wall-clock time has in `tz` (DST-aware; month is 1-based). */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi, s, ms);
  const t = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(t, tz);
}

/** The instant a local day (YYYY-MM-DD) starts in `tz` (DST-aware). */
export function startOfDay(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number);
  let t = zonedTime(y, m, d, 0, 0, 0, 0, tz);
  if (dayKey(t, tz) < day) t += 3_600_000; // midnight skipped by a DST jump: the day starts at 01:00
  return t;
}

/** Calendar arithmetic on YYYY-MM-DD (no time zone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO week of a local day: its key (YYYY-Www) and the Monday it starts on. */
export function isoWeek(day: string): { week: string; start: string } {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; // Mon=1..Sun=7
  const thursday = new Date(Date.UTC(y, m - 1, d + 4 - dow));
  const isoYear = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7);
  return { week: `${isoYear}-W${pad(week)}`, start: addDays(day, 1 - dow) };
}

/** The local days from `from` to `to` inclusive. */
export function daysBetween(from: number, to: number, tz: string): string[] {
  const out: string[] = [];
  const last = dayKey(to, tz);
  for (let d = dayKey(from, tz); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Longest range the series are built for (a guard against from=0). */
export const MAX_RANGE_DAYS = 3660;

/**
 * The comparison window before [from, to] (to missing = now). When `from` starts a local day in
 * `tz` and `to` ends one (or is missing: "through today"), it is the same number of calendar
 * days immediately before, on day boundaries (DST-safe). Otherwise the equal-length ms window.
 */
export function previousPeriod(from: number, to: number | undefined, tz: string, now: number): { from: number; to: number } {
  const end = to ?? now;
  const fromDay = dayKey(from, tz);
  const startsDay = startOfDay(fromDay, tz) === from;
  const endsDay = to === undefined || startOfDay(addDays(dayKey(end, tz), 1), tz) - 1 === end;
  if (startsDay && endsDay && from <= end) {
    // calendar days spanned; rounding absorbs a DST hour (no day enumeration: from may be far back)
    const n = Math.round((startOfDay(addDays(dayKey(end, tz), 1), tz) - from) / 86_400_000);
    return { from: startOfDay(addDays(fromDay, -n), tz), to: from - 1 };
  }
  return { from: from - 1 - (end - from), to: from - 1 };
}

/** Validate a range cheaply (no day enumeration), before any loading. */
export function checkRange(from: number, to: number): void {
  if (from > to) throw new MetricsParamError('from must be <= to');
  if (Math.floor((to - from) / 86_400_000) + 1 > MAX_RANGE_DAYS) {
    throw new MetricsParamError(`range too long (max ${MAX_RANGE_DAYS} days)`);
  }
}

/** Nearest-rank percentile (an observed value); null for no data. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface Percentiles {
  p50: number | null;
  p85: number | null;
  p95: number | null;
  count: number;
}

export function percentiles(values: number[]): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p85: percentile(s, 85), p95: percentile(s, 95), count: s.length };
}

export type LaneCounts = Record<Lane, number>;
const zeroLanes = (): LaneCounts => Object.fromEntries(LANES.map((l) => [l, 0])) as LaneCounts;

/** Lane of a derived history at instant `t`, or null (not created yet / deleted). */
export function laneAt(intervals: LaneInterval[], t: number): Lane | null {
  for (const i of intervals) if (i.from <= t && (i.to === null || t < i.to)) return i.lane;
  return null;
}

export interface FlowPoint {
  id: string;
  title: string;
  doneAt: number;
  cycleTimeMs: number;
  leadTimeMs: number;
}

export interface FlowMetrics {
  range: { from: number; to: number; tz: string; days: number };
  throughput: {
    total: number;
    weekly: { week: string; start: string; count: number }[];
    /** Per local day; only for ranges of 31 days or fewer, else null. */
    daily: { date: string; count: number }[] | null;
  };
  cycleTime: Percentiles;
  leadTime: Percentiles;
  /** One point per card done in the range, for a scatter chart (by doneAt). */
  points: FlowPoint[];
  /**
   * Cumulative flow: lane counts at the end of each local day (or at `to` for
   * the last). Cumulative state, so cards done before `from` stay in the done
   * band: a day's row is the same whatever the window.
   */
  cfd: ({ date: string } & LaneCounts)[];
  /** Cards whose life overlaps the range, and how many of them had partial histories. */
  cards: number;
  partial: number;
}

export interface AggregateOptions {
  tz: string;
  now: number;
  from?: number;
  to?: number;
}

/** A card's history derived once, with its metrics. */
export interface DerivedCard {
  h: CardHistory;
  d: LaneHistory;
  m: CardMetrics;
}

export const deriveCards = (hs: CardHistory[], now: number): DerivedCard[] =>
  hs.map((h) => {
    const d = deriveLaneHistory(h.card, h.events);
    return { h, d, m: computeCardMetrics(h.card, d, now) };
  });

/**
 * Lane counts at the end of each day (snapshots at min(day end, `to`)). A
 * per-card cursor walks its ordered intervals once alongside the days, so the
 * cost is O(cards x days) (+ each card's intervals once).
 */
function laneSnapshots(ds: DerivedCard[], days: string[], to: number, tz: string): LaneCounts[] {
  const ends = days.map((day) => Math.min(startOfDay(addDays(day, 1), tz) - 1, to));
  const out = days.map(zeroLanes);
  for (const { d } of ds) {
    let k = 0;
    ends.forEach((t, i) => {
      while (k < d.intervals.length && d.intervals[k].to !== null && d.intervals[k].to! <= t) k++;
      const iv = d.intervals[k];
      if (iv && iv.from <= t && (iv.to === null || t < iv.to)) out[i][iv.lane]++;
    });
  }
  return out;
}

/**
 * Throughput, cycle/lead percentiles + points, and the CFD over a date range.
 * Pass every card up to `to`, NOT pre-filtered by `from`: cards done before
 * `from` are the CFD's done baseline. Throughput, percentiles and points only
 * count cards done inside [from, to].
 */
export function flowFromDerived(ds: DerivedCard[], opts: AggregateOptions): FlowMetrics {
  const { tz, now } = opts;
  const to = opts.to ?? now;
  const from = opts.from ?? ds.reduce((min, x) => Math.min(min, x.m.createdAt), to);
  checkRange(from, to);
  const days = daysBetween(from, to, tz);

  const done = ds
    .map((x) => x.m)
    .filter((m) => m.doneAt !== null && m.doneAt >= from && m.doneAt <= to)
    .sort((a, b) => a.doneAt! - b.doneAt!);
  const points: FlowPoint[] = done.map((m) => ({
    id: m.id,
    title: m.title,
    doneAt: m.doneAt!,
    cycleTimeMs: m.cycleTimeMs!,
    leadTimeMs: m.leadTimeMs!,
  }));

  const perDay = new Map(days.map((day) => [day, 0]));
  for (const p of points) {
    const k = dayKey(p.doneAt, tz);
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  const weekly: FlowMetrics['throughput']['weekly'] = [];
  for (const day of days) {
    const w = isoWeek(day);
    if (weekly[weekly.length - 1]?.week !== w.week) weekly.push({ ...w, count: 0 });
    weekly[weekly.length - 1].count += perDay.get(day)!;
  }

  const snaps = laneSnapshots(ds, days, to, tz);
  const inRange = ds.filter((x) => inDateRange({ ...x.m, deletedAt: x.d.deletedAt }, { from, to }));
  return {
    range: { from, to, tz, days: days.length },
    throughput: {
      total: points.length,
      weekly,
      daily: days.length <= 31 ? days.map((date) => ({ date, count: perDay.get(date)! })) : null,
    },
    cycleTime: percentiles(points.map((p) => p.cycleTimeMs)),
    leadTime: percentiles(points.map((p) => p.leadTimeMs)),
    points,
    cfd: days.map((date, i) => ({ date, ...snaps[i] })),
    cards: inRange.length,
    partial: inRange.filter((x) => x.m.partial).length,
  };
}

export const computeFlow = (histories: CardHistory[], opts: AggregateOptions): FlowMetrics =>
  flowFromDerived(deriveCards(histories, opts.now), opts);

export interface BurnPhase {
  id: string;
  title: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface BurnMetrics {
  phase: { id: string; title: string; status: string };
  range: { from: number; to: number; tz: string; days: number };
  /** Per local day, at the day's end: scope (burn-up total), done (burn-up), remaining (burn-down). */
  series: { date: string; scope: number; done: number; remaining: number }[];
  scope: number;
  done: number;
  /** Cards whose scope-entry (or exit) time is a guess: no phase_change event records when it happened. */
  approximated: number;
  partial: number;
}

/**
 * When a card was in `phaseId`, as [from, to) spans (to null = still in it).
 * Exact from its phase_change {from, to} events: it starts in its create
 * event's phase (else the first change's `from`) and follows each change.
 * Without phase_change events (or where the log disagrees with itself / the
 * card's current phase) the switch's time is unknown: it is placed at
 * max(the previous known time, the phase's creation), clamped to the next
 * known time, and the card counts as approximated.
 */
function phaseSpans(
  x: DerivedCard,
  phaseId: string,
  phaseCreatedAt: number,
): { spans: { from: number; to: number | null }[]; approximated: boolean } {
  const createdAt = x.m.createdAt;
  const changes = x.h.events.filter((e) => e.type === 'phase_change').map((e) => ({ e, p: parsePayload(e.payload) }));
  const create = x.h.events.find((e) => e.type === 'create');
  const phaseOf = (v: unknown) => (typeof v === 'string' ? v : null);
  const spans: { from: number; to: number | null }[] = [];
  let approximated = false;
  // no create event and no changes: the starting phase is unknown (null → an approximated entry)
  let cur: string | null = create
    ? phaseOf(parsePayload(create.payload).phase_id)
    : changes.length
      ? phaseOf(changes[0].p.from)
      : null;
  let at = createdAt;
  const enter = (to: string | null, t: number) => {
    if (cur !== phaseId && to === phaseId) spans.push({ from: t, to: null });
    if (cur === phaseId && to !== phaseId) spans[spans.length - 1].to = t;
    cur = to;
  };
  // an untracked switch somewhere in [at, bound]: earliest plausible time
  const guess = (to: string | null, bound: number) => {
    if (cur === to) return;
    approximated = true;
    enter(to, Math.min(bound, Math.max(at, phaseCreatedAt)));
  };
  if (cur === phaseId) spans.push({ from: createdAt, to: null });
  for (const { e, p } of changes) {
    const t = Math.max(e.created_at, at);
    guess(phaseOf(p.from), t);
    enter(phaseOf(p.to), t);
    at = t;
  }
  guess(x.h.card.phase_id, Infinity);
  return { spans, approximated };
}

/**
 * Burn-up / burn-down for one phase, over the phase's life (its creation, or
 * its first card if earlier, to now; a done phase ends at max(its last update,
 * last card done)).
 *
 * Scope on a day is the cards in the phase at the day's end, from their
 * phase_change events: a card moved in counts from its move, a card moved out
 * stops counting at its move (see phaseSpans). Fallback when a card has no
 * phase_change events (history from before they were logged):
 *  - A card whose create event carried this phase entered scope at creation.
 *    Any other card (placed, moved or committed into the phase later) enters
 *    at max(its creation, the phase's creation), counted in `approximated`.
 *  - A card that left without an event leaves no trace, and a deleted card's
 *    history is deleted with it.
 *  - Done follows the lane history, so a reopened card drops out of `done`
 *    again for the days it was not done.
 */
export function computeBurn(phase: BurnPhase, histories: CardHistory[], opts: Omit<AggregateOptions, 'from' | 'to'>): BurnMetrics {
  const { tz, now } = opts;
  const ds = deriveCards(histories, now);
  let approximated = 0;
  const spans = ds.map((x) => {
    const r = phaseSpans(x, phase.id, phase.created_at);
    if (r.approximated) approximated++;
    return r.spans;
  });
  const from = spans.flat().reduce((min, s) => Math.min(min, s.from), phase.created_at);
  // only a done that happened while the card was in the phase (one finished elsewhere doesn't stretch the range)
  const lastDone = ds.reduce((max, x, i) => {
    const t = x.m.doneAt;
    return t !== null && spans[i].some((s) => s.from <= t && (s.to === null || s.to > t)) ? Math.max(max, t) : max;
  }, 0);
  const to = Math.max(from, phase.status === 'done' ? Math.min(now, Math.max(phase.updated_at, lastDone)) : now);
  checkRange(from, to);
  const days = daysBetween(from, to, tz);

  const series = days.map((date) => {
    const t = Math.min(startOfDay(addDays(date, 1), tz) - 1, to);
    let scope = 0;
    let done = 0;
    ds.forEach((x, i) => {
      if (!spans[i].some((s) => s.from <= t && (s.to === null || s.to > t))) return;
      scope++;
      if (laneAt(x.d.intervals, t) === 'done') done++;
    });
    return { date, scope, done, remaining: scope - done };
  });
  const last = series[series.length - 1];
  return {
    phase: { id: phase.id, title: phase.title, status: phase.status },
    range: { from, to, tz, days: days.length },
    series,
    scope: last?.scope ?? 0,
    done: last?.done ?? 0,
    approximated,
    partial: ds.filter((x) => x.m.partial).length,
  };
}

export interface MetricsSummary {
  /** The window: the last 4 ISO weeks ending at `to` (the current one partial), or from `from` if later. */
  range: { from: number; to: number; tz: string };
  /** One bucket per ISO week in the window (at most 4); sums to cycleTime.count. */
  throughput: { week: string; start: string; count: number }[];
  cycleTime: { p50: number | null; p85: number | null; count: number };
  /** Lane counts at `to` for the not-done lanes. */
  wip: Record<Exclude<Lane, 'done'>, number>;
  /** As of now: the card longest in flight (queued / in_progress / in_review), by cycle start. */
  oldestInFlight: { id: string; title: string; lane: Lane; inFlightMs: number; ageInLaneMs: number | null } | null;
  cards: number;
  partial: number;
}

/** Start of the ISO week three weeks before `to`'s week: the last 4 ISO weeks begin here. */
export function lastFourWeeksStart(to: number, tz: string): number {
  return startOfDay(isoWeek(addDays(dayKey(to, tz), -21)).start, tz);
}

/** A compact summary (for the MCP tool) over the last 4 ISO weeks ending at `to`. */
export function summaryFromDerived(ds: DerivedCard[], opts: AggregateOptions): MetricsSummary {
  const to = opts.to ?? opts.now;
  const from = Math.max(opts.from ?? -Infinity, lastFourWeeksStart(to, opts.tz));
  const flow = flowFromDerived(ds, { ...opts, from, to });
  const end = flow.cfd[flow.cfd.length - 1];
  const inFlight = ds
    .map((x) => x.m)
    .filter((m) => !m.deleted && (m.lane === 'queued' || m.lane === 'in_progress' || m.lane === 'in_review'))
    .sort((a, b) => (a.cycleStartAt ?? a.createdAt) - (b.cycleStartAt ?? b.createdAt));
  const oldest = inFlight[0];
  return {
    range: { from, to, tz: opts.tz },
    throughput: flow.throughput.weekly,
    cycleTime: { p50: flow.cycleTime.p50, p85: flow.cycleTime.p85, count: flow.cycleTime.count },
    wip: { backlog: end.backlog, queued: end.queued, in_progress: end.in_progress, in_review: end.in_review },
    oldestInFlight: oldest
      ? {
          id: oldest.id,
          title: oldest.title,
          lane: oldest.lane,
          inFlightMs: Math.max(0, opts.now - (oldest.cycleStartAt ?? oldest.createdAt)),
          ageInLaneMs: oldest.ageInLaneMs,
        }
      : null,
    cards: flow.cards,
    partial: flow.partial,
  };
}

export const computeSummary = (histories: CardHistory[], opts: AggregateOptions): MetricsSummary =>
  summaryFromDerived(deriveCards(histories, opts.now), opts);

const ZONELESS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * Parse a from/to query value: epoch ms; a bare local day (YYYY-MM-DD in `tz`:
 * `from` = its start, `to` = its end); a datetime without a zone
 * (YYYY-MM-DDTHH:mm[:ss[.sss]]), read as wall-clock time in `tz`; or anything
 * with a zone that Date.parse accepts. Throws MetricsParamError on garbage.
 */
export function parseTime(raw: string, tz: string, edge: 'from' | 'to'): number {
  const bad = () => new MetricsParamError(`invalid ${edge}: ${raw}`);
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = edge === 'from' ? startOfDay(raw, tz) : startOfDay(addDays(raw, 1), tz) - 1;
    if (Number.isFinite(t) && dayKey(t, tz) === raw) return t;
    throw bad();
  }
  const z = ZONELESS.exec(raw);
  if (z) {
    const [y, mo, d, h, mi, s] = z.slice(1, 7).map((x) => Number(x ?? 0));
    const ms = z[7] ? Number(z[7].padEnd(3, '0')) : 0;
    const u = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    const valid =
      u.getUTCFullYear() === y && u.getUTCMonth() === mo - 1 && u.getUTCDate() === d && u.getUTCHours() === h && u.getUTCMinutes() === mi && u.getUTCSeconds() === s;
    if (!valid) throw bad();
    return zonedTime(y, mo, d, h, mi, s, ms, tz);
  }
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return t;
  throw bad();
}

// ---------- DB reader ----------

/** Internal load filter: also cards that have a phase_change event out of `leftPhaseId`. */
type LoadFilter = MetricsFilter & { leftPhaseId?: string };

/** SQL WHERE (over tasks aliased `t`) for the non-date parts of a filter. */
function filterWhere(filter: LoadFilter): { sql: string; params: (string | number)[] } {
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
  if (filter.leftPhaseId !== undefined) {
    // driven from the phase_change rows (evaluated once), then tasks looked up by id: no per-task scan
    where.push(
      `t.id IN (SELECT pe.task_id FROM task_events pe WHERE pe.type = 'phase_change'
        AND json_valid(pe.payload) AND json_extract(pe.payload, '$.from') = ?)`,
    );
    params.push(filter.leftPhaseId);
  }
  if (filter.tag !== undefined) {
    where.push('t.tag = ?');
    params.push(filter.tag);
  }
  if (filter.workType === 'none') where.push('t.work_type IS NULL');
  else if (filter.workType !== undefined) {
    where.push('t.work_type = ?');
    params.push(filter.workType);
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

/** The SQL part of the load: cards matching `filter` (coarse date prefilter only) + their events. */
function loadRaw(db: DB, filter: LoadFilter): CardHistory[] {
  const { sql, params } = filterWhere(filter);
  const cards = db
    .prepare(
      `SELECT t.id, t.project_id, t.phase_id, t.title, t.lane, t.tag, t.assigned_agent, t.blocked_at,
              t.blocked_reason, t.review_rounds, t.created_at, t.updated_at, t.work_type
       FROM tasks t ${sql} ORDER BY t.created_at, t.id`,
    )
    .all(...params) as MetricsCard[];
  const events = db
    .prepare(
      `SELECT e.id, e.task_id, e.type, e.payload, e.agent, e.created_at
       FROM task_events e JOIN tasks t ON t.id = e.task_id ${sql}
       ORDER BY e.id`,
    )
    .all(...params) as (MetricsEvent & { task_id: string })[];

  const byCard = new Map<string, MetricsEvent[]>(cards.map((c) => [c.id, []]));
  for (const { task_id, ...e } of events) byCard.get(task_id)?.push(e);
  return cards.map((card) => ({ card, events: byCard.get(card.id)! }));
}

/**
 * Load the cards matching `filter` with their full event histories, in two
 * queries (cards, then all their events). Deleted cards are not returned: their
 * rows and events are removed by deleteTask.
 */
export function loadCardHistories(db: DB, filter: MetricsFilter = {}): CardHistory[] {
  const histories = loadRaw(db, filter);
  if (filter.from === undefined && filter.to === undefined) return histories;
  return histories.filter((h) => {
    const d = deriveLaneHistory(h.card, h.events);
    const last = d.intervals[d.intervals.length - 1];
    return inDateRange({ createdAt: d.intervals[0].from, doneAt: last.lane === 'done' ? last.from : null }, filter);
  });
}

/**
 * Load + derive once for the flow / summary views. The range is validated
 * before anything is loaded. `from` is NOT applied to the load (cards done
 * before it are the CFD's done baseline); `to` still prefilters in SQL.
 */
function loadDerived(db: DB, filter: MetricsFilter, now: number): DerivedCard[] {
  if (filter.from !== undefined) checkRange(filter.from, filter.to ?? now);
  return deriveCards(loadRaw(db, { ...filter, from: undefined }), now);
}

/** /metrics/flow: the flow view plus its per-work-type throughput and the scope's first activity. */
export interface FlowView extends FlowMetrics {
  /** Cards done in the range per work type ('none' = unclassified); sums to throughput.total. */
  throughputByWorkType: Record<WorkType | 'none', number>;
  /** Earliest card create or done event in the filtered scope (from / to ignored); null with no cards. */
  firstActivityAt: number | null;
}

export function flowMetrics(db: DB, filter: MetricsFilter, opts: { tz: string; now: number }): FlowView {
  const ds = loadDerived(db, filter, opts.now);
  const flow = flowFromDerived(ds, { ...opts, from: filter.from, to: filter.to });
  const { from, to } = flow.range;
  const byType = Object.fromEntries([...WORK_TYPES, 'none'].map((t) => [t, 0])) as FlowView['throughputByWorkType'];
  for (const x of ds) if (x.m.doneAt !== null && x.m.doneAt >= from && x.m.doneAt <= to) byType[x.h.card.work_type ?? 'none']++;
  return { ...flow, throughputByWorkType: byType, firstActivityAt: firstActivityAt(db, filter) };
}

/**
 * Earliest activity of the cards matching `filter`'s non-date parts: their earliest created_at
 * (the create event is logged at the same instant, and a card's done move always comes later).
 */
function firstActivityAt(db: DB, filter: MetricsFilter): number | null {
  const { sql, params } = filterWhere({ ...filter, from: undefined, to: undefined });
  return (db.prepare(`SELECT MIN(t.created_at) AS at FROM tasks t ${sql}`).get(...params) as { at: number | null }).at;
}

export function summaryMetrics(db: DB, filter: MetricsFilter, opts: { tz: string; now: number }): MetricsSummary {
  const to = filter.to ?? opts.now;
  const from = Math.max(filter.from ?? -Infinity, lastFourWeeksStart(to, opts.tz));
  return summaryFromDerived(loadDerived(db, { ...filter, from }, opts.now), { ...opts, from, to: filter.to });
}

/** The phase's current cards (on the given boards) plus every card that left it (a phase_change from it, any board). */
export function burnMetrics(
  db: DB,
  phase: BurnPhase,
  projectIds: string[],
  opts: { tz: string; now: number; workType?: MetricsFilter['workType'] },
): BurnMetrics {
  const { workType, ...rest } = opts;
  const current = loadRaw(db, { projectIds, phaseId: phase.id, workType });
  const seen = new Set(current.map((h) => h.card.id));
  const left = loadRaw(db, { leftPhaseId: phase.id, workType }).filter((h) => !seen.has(h.card.id));
  return computeBurn(phase, [...current, ...left], rest);
}
