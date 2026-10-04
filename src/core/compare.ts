// Period-over-period comparison helpers: the window before a [from, to] range, a wrapper that
// runs a compute over both windows, the `compare` query param, and headline deltas.
import { localTimeZone, MetricsParamError, parseTime } from './metrics.js';
import type { Compare, TimeWindow } from './types.js';

/** Any filter carrying an inclusive epoch-ms [from, to] range (e.g. CardFilter). */
export interface WindowedFilter {
  from?: number | null;
  to?: number | null;
}

/**
 * A result plus its comparison block. Like Compare<P>, but the windows are null for all time
 * (no `from`), where there is nothing to compare against.
 */
export type WithPrevious<T, P> = T &
  Omit<Compare<P>, 'window' | 'previousWindow'> & {
    window: TimeWindow | null;
    previousWindow: TimeWindow | null;
  };

/**
 * The equal-length window immediately before the inclusive range [from, to] (epoch ms; plain ms
 * arithmetic, so DST shifts don't skew it). Null when `from` is missing (all time). A missing
 * `to` means now.
 */
export function previousWindow(from: number | null | undefined, to: number | null | undefined, now = Date.now()): TimeWindow | null {
  if (from == null) return null;
  const end = to ?? now;
  const prevTo = from - 1;
  return { from: prevTo - (end - from), to: prevTo };
}

/**
 * Run `compute` over `filter`, then again over the same filter shifted to the previous window
 * (or the given `compare` window). `pick` trims the previous result to its headline fields.
 */
export function withPrevious<F extends WindowedFilter, T, P>(
  filter: F,
  compute: (f: F) => T,
  pick: (prev: T) => P,
  opts: { now?: number; compare?: TimeWindow | null } = {},
): WithPrevious<T, P> {
  const now = opts.now ?? Date.now();
  const current = compute(filter);
  const window = filter.from == null ? null : { from: filter.from, to: filter.to ?? now };
  const prevWindow = opts.compare !== undefined ? opts.compare : previousWindow(filter.from, filter.to, now);
  const previous = prevWindow ? pick(compute({ ...filter, from: prevWindow.from, to: prevWindow.to })) : null;
  return { ...current, previous, window, previousWindow: prevWindow };
}

/**
 * Parse the `compare` query param: 'previous' → the window before `current`; '<from>,<to>'
 * (epoch ms or YYYY-MM-DD in `tz`, same rules as from / to) → that window. Null when the param
 * is absent or invalid, or (for 'previous') when `current` is all time.
 */
export function parseCompare(
  param: string | null | undefined,
  current: WindowedFilter,
  opts: { tz?: string; now?: number } = {},
): TimeWindow | null {
  if (!param) return null;
  if (param === 'previous') return previousWindow(current.from, current.to, opts.now);
  const parts = param.split(',');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const tz = opts.tz ?? localTimeZone();
  try {
    const from = parseTime(parts[0].trim(), tz, 'from');
    const to = parseTime(parts[1].trim(), tz, 'to');
    return from <= to ? { from, to } : null;
  } catch (err) {
    if (err instanceof MetricsParamError) return null;
    throw err;
  }
}

/** Absolute change and percent change (50 = +50%); pct is null when previous is 0 or missing. */
export function delta(current: number, previous: number | null | undefined): { abs: number; pct: number | null } {
  const prev = previous ?? 0;
  return { abs: current - prev, pct: previous ? ((current - previous) / Math.abs(previous)) * 100 : null };
}
