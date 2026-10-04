/**
 * Monte Carlo finish-date forecast ("when will the remaining work be done?"),
 * without estimates: resample the scope's historical daily throughput until the
 * remaining card count is exhausted, many times, and read percentiles off the
 * distribution of days needed.
 *
 * Conventions:
 *  - Calendar days, not working days: agents work every day, so weekends are
 *    ordinary samples (and ordinary simulated days).
 *  - History = the `weeks` x 7 local days (in `tz`) ending YESTERDAY. Today is
 *    partial, so it is neither a sample nor a simulated day. Days before the
 *    scope's first card existed are not samples either (the board wasn't there).
 *  - Simulated day 1 is tomorrow: finishing in `d` days means done by the end
 *    of local day today + d. Zero remaining = 0 days = today.
 *  - Speed: a day's draw is either zero or one of the non-zero samples, so each
 *    run of zero days is skipped in one geometric draw (same distribution as
 *    drawing day by day). Each loop iteration then removes >= 1 card, so a run
 *    costs <= min(remaining, maxDays) iterations; `runs` is lowered (never below
 *    MIN_RUNS) to keep runs x that under WORK_BUDGET.
 */
import type { DB } from './db.js';
import type { ForecastInfo } from './usage-burn.js';
import { addDays, dayKey, deriveCards, loadCardHistories, MetricsParamError, startOfDay, type MetricsFilter } from './metrics.js';

export const DEFAULT_WEEKS = 6;
export const DEFAULT_RUNS = 10_000;
export const MAX_DAYS = 3650;
export const MIN_DONE = 5;
export const MIN_DAYS = 10;
const MIN_RUNS = 1_000;
const WORK_BUDGET = 5_000_000;

/** mulberry32: a tiny seedable PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimOptions {
  runs: number;
  seed: number;
  maxDays?: number;
}

export interface SimResult {
  /** hist[d] = runs that needed d days (d <= maxDays; a capped run counts as maxDays). */
  hist: Uint32Array;
  runs: number;
  capped: number;
}

/** Runs actually simulated for `requested` runs over `remaining` cards (the CPU bound). */
export function boundedRuns(requested: number, remaining: number, maxDays = MAX_DAYS): number {
  const perRun = Math.max(1, Math.min(remaining, maxDays));
  return Math.min(requested, Math.max(MIN_RUNS, Math.floor(WORK_BUDGET / perRun)));
}

/**
 * Simulate `runs` futures. `samples` are daily done counts; at least one must be
 * non-zero when remaining > 0 (the caller checks history first).
 */
export function simulate(samples: number[], remaining: number, opts: SimOptions): SimResult {
  const maxDays = opts.maxDays ?? MAX_DAYS;
  const hist = new Uint32Array(maxDays + 1);
  if (remaining <= 0) {
    hist[0] = opts.runs;
    return { hist, runs: opts.runs, capped: 0 };
  }
  const nonZero = samples.filter((s) => s > 0);
  if (!nonZero.length) throw new Error('simulate: no throughput in the samples');
  const pNonZero = nonZero.length / samples.length;
  const logZero = Math.log(1 - pNonZero); // -Infinity when every sample is non-zero
  const rand = mulberry32(opts.seed);
  const k = nonZero.length;
  let capped = 0;
  for (let r = 0; r < opts.runs; r++) {
    let left = remaining;
    let days = 0;
    while (left > 0) {
      // zero days before the next non-zero one: Geometric(pNonZero) on {0, 1, ...}
      if (pNonZero < 1) days += Math.floor(Math.log(1 - rand()) / logZero);
      days += 1;
      if (days > maxDays) break;
      left -= nonZero[Math.floor(rand() * k)];
    }
    if (days > maxDays) {
      capped++;
      days = maxDays;
    }
    hist[days]++;
  }
  return { hist, runs: opts.runs, capped };
}

/** Nearest-rank percentile read off a histogram. */
function histPercentile(hist: Uint32Array, total: number, p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * total));
  let seen = 0;
  for (let d = 0; d < hist.length; d++) {
    seen += hist[d];
    if (seen >= rank) return d;
  }
  return hist.length - 1;
}

export interface ForecastPoint {
  days: number;
  date: string; // YYYY-MM-DD in tz
}

export interface ForecastHistory {
  days: number; // sample days
  done: number; // cards done over them
  from: string | null; // first sample day, null when none
  to: string; // last sample day (yesterday)
}

export type Forecast =
  | {
      status: 'ok';
      remaining: number;
      samples: ForecastHistory;
      p50: ForecastPoint;
      p85: ForecastPoint;
      p95: ForecastPoint;
      histogram: { days: number; count: number }[];
      method: 'monte-carlo';
      runs: number;
      capped: number; // runs that hit maxDays (counted as maxDays)
      seed: number;
      tz: string;
    }
  | {
      status: 'insufficient_history';
      reason: 'too_few_days' | 'too_few_done' | 'no_throughput';
      remaining: number;
      have: { days: number; done: number };
      need: { days: number; done: number };
      samples: ForecastHistory;
      tz: string;
    };

export interface ForecastOptions {
  tz: string;
  now: number;
  weeks?: number;
  runs?: number;
  seed?: number;
  maxDays?: number;
}

/**
 * Daily done counts over the history window. `firstAt` is when the scope's
 * first card was created (days before it are not samples); `doneAts` are the
 * done times of the scope's done cards.
 */
export function throughputSamples(
  doneAts: number[],
  firstAt: number | null,
  opts: Pick<ForecastOptions, 'tz' | 'now' | 'weeks'>,
): { samples: number[]; history: ForecastHistory } {
  const today = dayKey(opts.now, opts.tz);
  const to = addDays(today, -1);
  let from = addDays(today, -7 * (opts.weeks ?? DEFAULT_WEEKS));
  if (firstAt === null) return { samples: [], history: { days: 0, done: 0, from: null, to } };
  const first = dayKey(firstAt, opts.tz);
  if (first > from) from = first;
  if (from > to) return { samples: [], history: { days: 0, done: 0, from: null, to } };
  const index = new Map<string, number>();
  for (let d = from; d <= to; d = addDays(d, 1)) index.set(d, index.size);
  const samples = new Array<number>(index.size).fill(0);
  const start = startOfDay(from, opts.tz);
  const end = startOfDay(today, opts.tz);
  let done = 0;
  for (const t of doneAts) {
    if (t < start || t >= end) continue;
    samples[index.get(dayKey(t, opts.tz))!]++;
    done++;
  }
  return { samples, history: { days: samples.length, done, from, to } };
}

/** The forecast for `remaining` cards given the scope's history (pure). */
export function computeForecast(doneAts: number[], firstAt: number | null, remaining: number, opts: ForecastOptions): Forecast {
  const { samples, history } = throughputSamples(doneAts, firstAt, opts);
  const today = dayKey(opts.now, opts.tz);
  const maxDays = opts.maxDays ?? MAX_DAYS;
  if (remaining > 0) {
    const reason =
      history.done === 0 ? 'no_throughput' : history.days < MIN_DAYS ? 'too_few_days' : history.done < MIN_DONE ? 'too_few_done' : null;
    if (reason) {
      return {
        status: 'insufficient_history',
        reason,
        remaining,
        have: { days: history.days, done: history.done },
        need: { days: MIN_DAYS, done: MIN_DONE },
        samples: history,
        tz: opts.tz,
      };
    }
  }
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  const runs = boundedRuns(opts.runs ?? DEFAULT_RUNS, remaining, maxDays);
  const sim = simulate(samples, remaining, { runs, seed, maxDays });
  const point = (p: number): ForecastPoint => {
    const days = histPercentile(sim.hist, sim.runs, p);
    return { days, date: addDays(today, days) };
  };
  const histogram: { days: number; count: number }[] = [];
  sim.hist.forEach((count, days) => {
    if (count) histogram.push({ days, count });
  });
  return {
    status: 'ok',
    remaining,
    samples: history,
    p50: point(50),
    p85: point(85),
    p95: point(95),
    histogram,
    method: 'monte-carlo',
    runs: sim.runs,
    capped: sim.capped,
    seed,
    tz: opts.tz,
  };
}

/** What to forecast. History always comes from the whole scope (project incl. verticals, + tag). */
export type ForecastTarget =
  | { kind: 'board' }
  | { kind: 'phase'; phaseId: string }
  | { kind: 'plan'; cardIds: string[] };

/** Load the scope, count the target's not-done cards, and forecast them. */
export function forecast(
  db: DB,
  scope: { projectId: string; tag?: string; workType?: MetricsFilter['workType'] },
  target: ForecastTarget,
  opts: ForecastOptions,
): Forecast {
  const filter: MetricsFilter = {
    projectIds: [scope.projectId],
    ...(scope.tag ? { tag: scope.tag } : {}),
    ...(scope.workType ? { workType: scope.workType } : {}),
  };
  const cards = deriveCards(loadCardHistories(db, filter), opts.now).map((d) => d.m);
  const inPlan = target.kind === 'plan' ? new Set(target.cardIds) : null;
  const inTarget = (c: (typeof cards)[number]) =>
    target.kind === 'board' || (target.kind === 'phase' ? c.phase_id === target.phaseId : inPlan!.has(c.id));
  const remaining = cards.filter((c) => c.lane !== 'done' && inTarget(c)).length;
  const doneAts = cards.flatMap((c) => (c.doneAt === null ? [] : [c.doneAt]));
  const firstAt = cards.reduce<number | null>((m, c) => (m === null || c.createdAt < m ? c.createdAt : m), null);
  return computeForecast(doneAts, firstAt, remaining, opts);
}

/** A phase's forecast in the shape usage-burn compares limits against (no phase → 'no_phase'). */
export function phaseForecastInfo(
  db: DB,
  projectId: string,
  phase: { id: string; title: string } | null,
  opts: { tz: string; now: number; seed?: number },
): ForecastInfo {
  if (!phase) return { status: 'no_phase', phase: null, reason: 'the project has no active phase' };
  const f = forecast(db, { projectId }, { kind: 'phase', phaseId: phase.id }, opts);
  const p = { id: phase.id, title: phase.title };
  return f.status === 'ok' ? { status: 'ok', phase: p, p50: f.p50, p85: f.p85 } : { status: 'insufficient_history', phase: p, reason: f.reason };
}

/** An optional integer query param in [min, max]; bad → MetricsParamError (400). */
export function intParam(raw: string | null, name: string, min: number, max: number): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new MetricsParamError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return n;
}
