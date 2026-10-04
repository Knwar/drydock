/**
 * Card estimates vs what the work actually took (/metrics/estimates). A card's estimate_hours is
 * "how long a human engineer would take"; the measured side is the agent's build time on the card
 * (Σ card_activity.ms of its build runs) and its AI spend (all of its runs, priced by cost.ts).
 *
 * Over the cards done in [from, to] (the usual metrics filters):
 *  - coverage: the share of done cards that carry an estimate.
 *  - hourlyRate: over done cards with an estimate AND recorded spend (cards without spend
 *    would count hours for free, so they are left out and counted in `noSpend`):
 *    hoursPerDollar = Σ estimate_hours / Σ spend, dollarsPerHour = Σ spend / Σ estimate_hours
 *    ("$ per human-equivalent hour").
 *    byAgent (byAgentBasis): spend is credited per RUN to the agent that ran it (the run's
 *    credited agent, as cost.ts's byAgent counts it) and estimate hours to the card's ASSIGNEE
 *    (its team member's name, so it lines up with the run agents). The rows can therefore have
 *    hours without spend or spend without hours when a card changed hands.
 *  - perception (measure 'build_time'): each estimated done card's agent build time vs its
 *    estimate: ratio = agent build time ÷ human estimate (< 1: the agent was faster).
 *    Build time is Σ card_activity.ms; a card without recorded run time falls back to its time
 *    in the in_progress lane (`buildSource: 'in_progress'`, counted in `fallbacks`). cycleHours
 *    (wall-clock cycle time, queue / review / waiting included) rides along as context only.
 *    Times under a minute are too short to compare: no ratio, counted in `tooShort`.
 *    medianRatio is the true median over the cards with a ratio; the top 5 misses are the
 *    largest |ln ratio| (2x over and 2x under are equal misses).
 */
import { memberName } from './board.js';
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
  /** Agent build time (hours): Σ card_activity.ms, else the in_progress lane time (see buildSource). */
  buildHours: number;
  buildSource: 'runs' | 'in_progress';
  /** Wall-clock cycle time (hours): context only, not the ratio's basis. */
  cycleHours: number;
  cost: number;
  /** buildHours / estimateHours (agent build time ÷ human estimate); null under a minute of build time. */
  ratio: number | null;
}

/** Build times shorter than this have no ratio (counted in perception.tooShort). */
export const MIN_BUILD_MS = 60_000;

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
    /** The rate per agent (null = none), most hours first: hours by assignee, spend by run agent. */
    byAgent: AgentRate[];
    byAgentBasis: { hours: 'assignee'; cost: 'run_agent' };
  };
  perception: {
    /** What the ratio measures: agent build time ÷ human estimate. */
    measure: 'build_time';
    cards: EstimatePoint[];
    medianRatio: number | null;
    topMisses: EstimatePoint[];
    /** Cards whose build time is under a minute (no ratio; out of the median and misses). */
    tooShort: number;
    /** Cards measured on in_progress lane time (no run time recorded). */
    fallbacks: number;
  };
}

/** One priced run: who ran it and what it cost. */
export interface RunCost {
  task_id: string;
  agent: string | null;
  cost: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Pure: the figures from derived cards, their estimates, their spend and build time. `runs` (each
 * run's agent and cost) drives byAgent's spend; without it a card's spend counts to its assignee.
 * `agentName` maps an assignee label to the name runs are credited under (default: as is).
 */
export function estimatesFrom(
  ds: DerivedCard[],
  estimates: Map<string, number>,
  costs: Map<string, number>,
  opts: {
    tz: string;
    now: number;
    from?: number;
    to?: number;
    buildMs?: Map<string, number>;
    runs?: RunCost[];
    agentName?: (label: string) => string;
  },
): EstimateMetrics {
  const to = opts.to ?? opts.now;
  if (opts.from !== undefined) checkRange(opts.from, to);
  const done = ds.filter((x) => x.m.doneAt !== null && x.m.doneAt <= to && (opts.from === undefined || x.m.doneAt >= opts.from));
  const points: EstimatePoint[] = done
    .filter((x) => estimates.has(x.m.id))
    .map((x) => {
      const estimateHours = estimates.get(x.m.id)!;
      const runMs = opts.buildMs?.get(x.m.id) ?? 0;
      const buildSource = runMs > 0 ? ('runs' as const) : ('in_progress' as const);
      const ms = runMs > 0 ? runMs : x.m.timeInLaneMs.in_progress;
      return {
        id: x.m.id,
        title: x.m.title,
        doneAt: x.m.doneAt!,
        estimateHours,
        buildHours: ms / HOUR,
        buildSource,
        cycleHours: (x.m.cycleTimeMs ?? 0) / HOUR,
        cost: round6(costs.get(x.m.id) ?? 0),
        ratio: ms >= MIN_BUILD_MS ? ms / HOUR / estimateHours : null,
      };
    })
    .sort((a, b) => a.doneAt - b.doneAt || a.id.localeCompare(b.id));
  const spent = points.filter((p) => p.cost > 0);
  const hours = spent.reduce((s, p) => s + p.estimateHours, 0);
  const cost = spent.reduce((s, p) => s + p.cost, 0);

  // byAgent: hours to the assignee, spend per run to the agent that ran it
  const name = (label: string | null) => (label === null ? null : (opts.agentName?.(label) ?? label));
  const assignee = new Map(done.map((x) => [x.m.id, name(x.m.agent)]));
  const spentIds = new Set(spent.map((p) => p.id));
  const agents = new Map<string | null, AgentRate>();
  const row = (agent: string | null) => {
    let a = agents.get(agent);
    if (!a) agents.set(agent, (a = { agent, cards: 0, estimateHours: 0, cost: 0, hoursPerDollar: null }));
    return a;
  };
  for (const p of spent) {
    const a = row(assignee.get(p.id) ?? null);
    a.cards++;
    a.estimateHours += p.estimateHours;
  }
  const runs = opts.runs ?? spent.map((p) => ({ task_id: p.id, agent: assignee.get(p.id) ?? null, cost: p.cost }));
  for (const r of runs) if (spentIds.has(r.task_id)) row(r.agent).cost += r.cost;
  const byAgent = [...agents.values()]
    .map((a) => ({ ...a, cost: round6(a.cost), hoursPerDollar: a.cost > 0 ? round6(a.estimateHours / a.cost) : null }))
    .sort((a, b) => b.estimateHours - a.estimateHours || b.cost - a.cost || (a.agent ?? '\uffff').localeCompare(b.agent ?? '\uffff'));

  const rated = points.filter((p) => p.ratio !== null);
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
      byAgentBasis: { hours: 'assignee', cost: 'run_agent' },
    },
    perception: {
      measure: 'build_time',
      cards: points,
      medianRatio: median(rated.map((p) => p.ratio!)),
      topMisses: [...rated].sort((a, b) => miss(b) - miss(a) || a.id.localeCompare(b.id)).slice(0, 5),
      tooShort: points.length - rated.length,
      fallbacks: points.filter((p) => p.buildSource === 'in_progress').length,
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
  // every run of the estimated cards (any agent, all time): what the card cost, and who ran it
  const costs = new Map<string, number>();
  const runs: RunCost[] = [];
  const buildMs = new Map<string, number>();
  if (estimates.size) {
    for (const r of priceRows(loadCostRows(db, filter.projectIds), getPrices(db)).rows) {
      if (!estimates.has(r.task_id)) continue;
      costs.set(r.task_id, (costs.get(r.task_id) ?? 0) + r.cost);
      runs.push({ task_id: r.task_id, agent: r.agent, cost: r.cost });
    }
    for (const r of db
      .prepare('SELECT task_id, SUM(ms) AS ms FROM card_activity WHERE task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id')
      .all(JSON.stringify([...estimates.keys()])) as { task_id: string; ms: number }[])
      buildMs.set(r.task_id, r.ms);
  }
  return estimatesFrom(ds, estimates, costs, {
    ...opts,
    from: filter.from,
    to: filter.to,
    buildMs,
    runs,
    agentName: (label) => memberName(db, label),
  });
}
