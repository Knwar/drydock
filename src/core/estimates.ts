/**
 * Card estimates vs what the work actually took (/metrics/estimates). A card's estimate_hours is
 * "how long a human engineer would take"; the measured side is the card's cycle time (metrics.ts)
 * and its AI spend (all of the card's build runs, priced by cost.ts).
 *
 * Over the cards done in [from, to] (the usual metrics filters):
 *  - coverage: the share of done cards that carry an estimate.
 *  - hourlyRate: over done cards with an estimate AND recorded spend (cards without spend
 *    would count hours for free, so they are left out and counted in `noSpend`):
 *    hoursPerDollar = Σ estimate_hours / Σ spend, dollarsPerHour = Σ spend / Σ estimate_hours
 *    ("$ per human-equivalent hour"). byAgent: the same split by the card's assigned agent (null =
 *    unassigned); a card's spend is all of its runs, so it counts toward its assignee alone.
 *  - perception: each estimated done card's estimate vs its measured cycle time (hours) and
 *    spend; ratio = cycle hours / estimate (null for a zero cycle time). medianRatio is over the
 *    cards with a ratio; the top 5 misses are the largest |ln ratio| (2x over and 2x under are
 *    equal misses).
 */
import { getPrices, loadCostRows, priceRows } from './cost.js';
import type { DB } from './db.js';
import { checkRange, deriveCards, loadCardHistories, type DerivedCard, type MetricsFilter } from './metrics.js';

const HOUR = 3_600_000;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface EstimatePoint {
  id: string;
  title: string;
  doneAt: number;
  estimateHours: number;
  cycleHours: number;
  cost: number;
  /** cycleHours / estimateHours; null when the cycle time is 0. */
  ratio: number | null;
}

export interface AgentRate {
  agent: string | null;
  cards: number;
  estimateHours: number;
  cost: number;
  hoursPerDollar: number | null;
}

export interface EstimateMetrics {
  range: { from: number | null; to: number; tz: string };
  done: number;
  coverage: { estimated: number; pct: number | null };
  hourlyRate: {
    /** Estimated done cards with recorded spend (the basis of the rates). */
    cards: number;
    /** Estimated done cards without recorded spend (left out of the rates). */
    noSpend: number;
    estimateHours: number;
    cost: number;
    hoursPerDollar: number | null;
    dollarsPerHour: number | null;
    /** The rate per assigned agent (null = unassigned), most hours first. */
    byAgent: AgentRate[];
  };
  perception: {
    cards: EstimatePoint[];
    medianRatio: number | null;
    topMisses: EstimatePoint[];
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure: the figures from derived cards, their estimates and their spend. */
export function estimatesFrom(
  ds: DerivedCard[],
  estimates: Map<string, number>,
  costs: Map<string, number>,
  opts: { tz: string; now: number; from?: number; to?: number },
): EstimateMetrics {
  const to = opts.to ?? opts.now;
  if (opts.from !== undefined) checkRange(opts.from, to);
  const done = ds.filter((x) => x.m.doneAt !== null && x.m.doneAt <= to && (opts.from === undefined || x.m.doneAt >= opts.from));
  const points: EstimatePoint[] = done
    .filter((x) => estimates.has(x.m.id))
    .map((x) => {
      const estimateHours = estimates.get(x.m.id)!;
      const cycleHours = (x.m.cycleTimeMs ?? 0) / HOUR;
      return {
        id: x.m.id,
        title: x.m.title,
        doneAt: x.m.doneAt!,
        estimateHours,
        cycleHours,
        cost: round6(costs.get(x.m.id) ?? 0),
        ratio: cycleHours > 0 ? cycleHours / estimateHours : null,
      };
    })
    .sort((a, b) => a.doneAt - b.doneAt || a.id.localeCompare(b.id));
  const spent = points.filter((p) => p.cost > 0);
  const hours = spent.reduce((s, p) => s + p.estimateHours, 0);
  const cost = spent.reduce((s, p) => s + p.cost, 0);
  const agentOf = new Map(done.map((x) => [x.m.id, x.m.agent]));
  const agents = new Map<string | null, AgentRate>();
  for (const p of spent) {
    const agent = agentOf.get(p.id) ?? null;
    let a = agents.get(agent);
    if (!a) agents.set(agent, (a = { agent, cards: 0, estimateHours: 0, cost: 0, hoursPerDollar: null }));
    a.cards++;
    a.estimateHours += p.estimateHours;
    a.cost += p.cost;
  }
  const byAgent = [...agents.values()]
    .map((a) => ({ ...a, cost: round6(a.cost), hoursPerDollar: a.cost > 0 ? round6(a.estimateHours / a.cost) : null }))
    .sort((a, b) => b.estimateHours - a.estimateHours || (a.agent ?? '\uffff').localeCompare(b.agent ?? '\uffff'));
  const miss = (p: EstimatePoint) => Math.abs(Math.log(p.ratio!));
  return {
    range: { from: opts.from ?? null, to, tz: opts.tz },
    done: done.length,
    coverage: { estimated: points.length, pct: done.length ? points.length / done.length : null },
    hourlyRate: {
      cards: spent.length,
      noSpend: points.length - spent.length,
      estimateHours: hours,
      cost: round6(cost),
      hoursPerDollar: cost > 0 ? round6(hours / cost) : null,
      dollarsPerHour: hours > 0 ? round6(cost / hours) : null,
      byAgent,
    },
    perception: {
      cards: points,
      medianRatio: median(points.flatMap((p) => (p.ratio === null ? [] : [p.ratio]))),
      topMisses: points
        .filter((p) => p.ratio !== null)
        .sort((a, b) => miss(b) - miss(a) || a.id.localeCompare(b.id))
        .slice(0, 5),
    },
  };
}

/** Load + compute. `filter.projectIds` is required for the spend (a workspace includes its verticals). */
export function estimateMetrics(db: DB, filter: MetricsFilter & { projectIds: string[] }, opts: { tz: string; now: number }): EstimateMetrics {
  if (filter.from !== undefined) checkRange(filter.from, filter.to ?? opts.now);
  const ds = deriveCards(loadCardHistories(db, filter), opts.now);
  const ids = JSON.stringify(ds.map((x) => x.m.id));
  const estimates = new Map(
    (
      db
        .prepare('SELECT id, estimate_hours FROM tasks WHERE estimate_hours IS NOT NULL AND id IN (SELECT value FROM json_each(?))')
        .all(ids) as { id: string; estimate_hours: number }[]
    ).map((r) => [r.id, r.estimate_hours]),
  );
  // every run of the estimated cards (any agent, all time): what the card cost
  const costs = new Map<string, number>();
  if (estimates.size) {
    for (const r of priceRows(loadCostRows(db, filter.projectIds), getPrices(db)).rows)
      if (estimates.has(r.task_id)) costs.set(r.task_id, (costs.get(r.task_id) ?? 0) + r.cost);
  }
  return estimatesFrom(ds, estimates, costs, { ...opts, from: filter.from, to: filter.to });
}
