/**
 * Quality metrics from reviews: first-time pass rate, average review rounds,
 * capped cards (a second fail, which the protocol escalates to the user) and
 * rework loops, with per-phase / per-agent / per-tag breakdowns and a weekly
 * trend. Built on metrics.ts's derived histories (review events, a redirect
 * is a fresh start); the aggregation is pure, `qualityMetrics` loads.
 *
 * Everything counts from the last redirect (a fresh start): reviews are the
 * review events after it, rework the loops after it. Per card:
 *  - reviewed:   at least one review.
 *  - firstPass:  the first review passed.
 *  - rounds:     the number of reviews.
 *  - capped:     two or more failed reviews.
 *  - rework:     fail reviews followed by a move back into in_progress (before
 *                the next review or redirect).
 *  - finalAt:    the last review's time; it picks the trend week and, for
 *                reviewed cards, is what the from/to window applies to.
 *                Unreviewed cards are windowed by life overlap (inDateRange).
 *
 * Aggregate bases (QualityStats):
 *  - firstPassRate, avgRounds and capped are all over the REVIEWED cards (any
 *    lane); `done` is how many of those reached done.
 *  - unreviewedDone (reached done without a review) and notYetReviewed (no
 *    review, not done) are counted but excluded from every rate.
 *  - rework sums the loops of every card in the set.
 *
 * Default window: with no `from`, the window starts at the earliest final
 * review in the loaded set (else `to`). Unreviewed cards are then only kept if
 * their life overlaps that window, so unreviewedDone can miss cards done before
 * the first review. Pass an explicit `from` for a complete count (the overlay's
 * Metrics view always does).
 */
import type { DB } from './db.js';
import {
  addDays,
  checkRange,
  dayKey,
  MAX_RANGE_DAYS,
  deriveCards,
  inDateRange,
  isoWeek,
  loadCardHistories,
  sortEvents,
  type DerivedCard,
  type MetricsFilter,
} from './metrics.js';

export interface CardQuality {
  id: string;
  phase_id: string | null;
  agent: string | null;
  tag: string | null;
  done: boolean;
  reviewed: boolean;
  firstPass: boolean;
  rounds: number;
  capped: boolean;
  rework: number;
  finalAt: number | null;
}

export interface QualityStats {
  reviewed: number;
  /** Reviewed cards that reached done. */
  done: number;
  /** Reached done without a review (excluded from the rates). */
  unreviewedDone: number;
  /** No review yet and not done (excluded from the rates). */
  notYetReviewed: number;
  /** Share (0..1) of reviewed cards whose first review passed; null with none reviewed. */
  firstPassRate: number | null;
  /** Mean review rounds over reviewed cards; null with none. */
  avgRounds: number | null;
  capped: number;
  rework: number;
}

/** Cards bucketed by the ISO week of their final review (so reviewed cards only). */
export interface QualityWeek {
  week: string;
  start: string;
  reviewed: number;
  done: number;
  firstPassRate: number | null;
  avgRounds: number | null;
}

export interface QualityMetrics {
  range: { from: number; to: number; tz: string };
  totals: QualityStats;
  byPhase: ({ phase_id: string | null; title: string | null } & QualityStats)[];
  byAgent: ({ agent: string | null } & QualityStats)[];
  byTag: ({ tag: string | null } & QualityStats)[];
  weekly: QualityWeek[];
}

function field(payload: unknown, key: string): unknown {
  let p = payload;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      return null;
    }
  }
  return p && typeof p === 'object' ? (p as Record<string, unknown>)[key] : null;
}

/** fail → back to in_progress loops since the last redirect. */
function countRework(x: DerivedCard): number {
  let pending = false;
  let n = 0;
  for (const e of sortEvents(x.h.events)) {
    if (e.type === 'review') pending = field(e.payload, 'verdict') === 'fail';
    else if (e.type === 'redirect') {
      pending = false;
      n = 0; // a fresh start
    }
    else if (e.type === 'move') {
      // only the move right after a fail review is rework; any other lane change clears the fail
      if (pending && field(e.payload, 'to') === 'in_progress') n++;
      pending = false;
    }
  }
  return n;
}

export function cardQuality(x: DerivedCard): CardQuality {
  const reviews = x.d.reviews.slice(x.d.lastRedirect?.review ?? 0);
  return {
    id: x.m.id,
    phase_id: x.m.phase_id,
    agent: x.m.agent,
    tag: x.m.tag,
    done: x.m.doneAt !== null,
    reviewed: reviews.length > 0,
    firstPass: reviews[0]?.verdict === 'pass',
    rounds: reviews.length,
    capped: reviews.filter((r) => r.verdict === 'fail').length >= 2,
    rework: countRework(x),
    finalAt: reviews.length ? reviews[reviews.length - 1].at : null,
  };
}

const ratio = (n: number, d: number) => (d ? n / d : null);

export function qualityStats(cs: CardQuality[]): QualityStats {
  const reviewed = cs.filter((c) => c.reviewed);
  const unreviewed = cs.filter((c) => !c.reviewed);
  return {
    reviewed: reviewed.length,
    done: reviewed.filter((c) => c.done).length,
    unreviewedDone: unreviewed.filter((c) => c.done).length,
    notYetReviewed: unreviewed.filter((c) => !c.done).length,
    firstPassRate: ratio(reviewed.filter((c) => c.firstPass).length, reviewed.length),
    avgRounds: ratio(reviewed.reduce((s, c) => s + c.rounds, 0), reviewed.length),
    capped: reviewed.filter((c) => c.capped).length,
    rework: cs.reduce((s, c) => s + c.rework, 0),
  };
}

function groupBy<K extends string | null>(cs: CardQuality[], key: (c: CardQuality) => K): [K, CardQuality[]][] {
  const m = new Map<K, CardQuality[]>();
  for (const c of cs) {
    const k = key(c);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(c);
  }
  return [...m.entries()];
}

/**
 * Aggregate derived cards. The window [from, to] (default: the earliest final
 * review, else `to`, clamped to the range cap; `to` defaults to now) keeps reviewed cards whose final review falls in
 * it and unreviewed cards whose life overlaps it; the weekly trend covers the
 * window's ISO weeks, zero-filled.
 */
export function qualityFromDerived(
  ds: DerivedCard[],
  opts: { tz: string; now: number; from?: number; to?: number; phaseTitles?: Map<string, string> },
): QualityMetrics {
  const { tz, now } = opts;
  const to = opts.to ?? now;
  const all = ds.map((x) => ({ x, q: cardQuality(x) }));
  const from =
    opts.from ??
    Math.max(
      all.reduce((min, { q }) => (q.finalAt === null ? min : Math.min(min, q.finalAt)), to),
      to - (MAX_RANGE_DAYS - 1) * 86_400_000,
    );
  checkRange(from, to);

  const cs = all
    .filter(({ x, q }) =>
      q.finalAt !== null ? q.finalAt >= from && q.finalAt <= to : inDateRange({ ...x.m, deletedAt: x.d.deletedAt }, { from, to }),
    )
    .map(({ q }) => q);

  const weeks: { week: string; start: string }[] = [];
  const last = isoWeek(dayKey(to, tz));
  for (let w = isoWeek(dayKey(from, tz)); w.start <= last.start; w = isoWeek(addDays(w.start, 7))) weeks.push(w);
  const byWeek = new Map<string, CardQuality[]>(weeks.map((w) => [w.week, []]));
  for (const c of cs) if (c.finalAt !== null) byWeek.get(isoWeek(dayKey(c.finalAt, tz)).week)?.push(c);

  const titles = opts.phaseTitles ?? new Map<string, string>();
  return {
    range: { from, to, tz },
    totals: qualityStats(cs),
    byPhase: groupBy(cs, (c) => c.phase_id).map(([phase_id, g]) => ({
      phase_id,
      title: phase_id === null ? null : (titles.get(phase_id) ?? null),
      ...qualityStats(g),
    })),
    byAgent: groupBy(cs, (c) => c.agent).map(([agent, g]) => ({ agent, ...qualityStats(g) })),
    byTag: groupBy(cs, (c) => c.tag).map(([tag, g]) => ({ tag, ...qualityStats(g) })),
    weekly: weeks.map((w) => {
      const s = qualityStats(byWeek.get(w.week)!);
      return { ...w, reviewed: s.reviewed, done: s.done, firstPassRate: s.firstPassRate, avgRounds: s.avgRounds };
    }),
  };
}

/** Load + aggregate. The range is validated before anything is loaded. */
export function qualityMetrics(db: DB, filter: MetricsFilter, opts: { tz: string; now: number }): QualityMetrics {
  if (filter.from !== undefined) checkRange(filter.from, filter.to ?? opts.now);
  // the loader keeps cards whose life overlaps the window: a superset of both rules above
  const ds = deriveCards(loadCardHistories(db, filter), opts.now);
  // titles only for the phases the loaded (already project-scoped) cards are in
  const phaseIds = [...new Set(ds.flatMap((x) => (x.m.phase_id === null ? [] : [x.m.phase_id])))];
  const phaseTitles = new Map(
    phaseIds.length
      ? (
          db.prepare(`SELECT id, title FROM phases WHERE id IN (${phaseIds.map(() => '?').join(', ')})`).all(...phaseIds) as {
            id: string;
            title: string;
          }[]
        ).map((p) => [p.id, p.title])
      : [],
  );
  return qualityFromDerived(ds, { ...opts, from: filter.from, to: filter.to, phaseTitles });
}
