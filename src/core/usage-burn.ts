/**
 * Usage-limit burn: at the recent burn rate, when will the 5-hour and weekly
 * subscription limits be hit, and is that before the active phase's forecast?
 *
 * Source: the statusline script POSTs /usage ({five_hour, seven_day}, each
 * {used_percentage, resets_at}); the daemon keeps those pushes in memory as
 * samples (the LIMITS pill shows the latest). Everything here is pure.
 *
 * Rate (percentage points per hour), per window:
 *  - recent: the samples of the CURRENT window within the lookback (5-hour:
 *    last hour, weekly: last 24 hours) of the latest one; the first-to-last
 *    slope when they span >= MIN_SPAN_MS. The current window = same resets_at,
 *    and after the last drop in used% (a drop is a reset, which is how a window
 *    without resets_at is told apart).
 *  - else window_average: used% / time since the window opened
 *    (resets_at - window length), which works from a single sample.
 * Stale (no projection): the window's resets_at has passed since the last
 * push, or the last push is older than the window's lookback.
 * hitsAt = latest sample time + (100 - used%) / rate, never in the past: a
 * projection at or before now is `at_risk` with hitsAt = now; used >= 100 is
 * `reached` (hitsAt null). It only matters when it falls before resets_at
 * (`beforeReset`).
 */
import { dayKey } from './metrics.js';

export type LimitKey = 'five_hour' | 'seven_day';

export const WINDOWS: Record<LimitKey, { label: string; ms: number; lookbackMs: number }> = {
  five_hour: { label: '5-hour', ms: 5 * 3_600_000, lookbackMs: 3_600_000 },
  seven_day: { label: 'weekly', ms: 7 * 86_400_000, lookbackMs: 86_400_000 },
};
export const MIN_SPAN_MS = 5 * 60_000;
/** Samples kept in memory: a bit over the weekly window, and at most this many. */
export const SAMPLE_MAX_AGE_MS = 8 * 86_400_000;
export const SAMPLE_MAX_COUNT = 10_000;
/** Two samples belong to the same window when their resets_at differ by less than this. */
const SAME_WINDOW_MS = 60_000;

export interface WindowSample {
  used: number; // percent 0..100
  resetsAt: number | null; // epoch ms
}

export interface UsageSample {
  at: number;
  five_hour: WindowSample | null;
  seven_day: WindowSample | null;
}

export interface LimitProjection {
  window: LimitKey;
  label: string;
  usedPct: number;
  resetsAt: number | null;
  sampledAt: number;
  /** The numbers are too old to project: the window has reset since the last push, or the push is older than the lookback. */
  stale: boolean;
  /** Why it is stale: the window reset since the push, or the push is older than the lookback. */
  staleReason: 'reset' | 'old_sample' | null;
  /**
   * projected: hitsAt is ahead; at_risk: at this rate it would already be hit (hitsAt = now);
   * reached: used >= 100%; resets_first: the window resets before hitsAt; not_burning: rate 0;
   * no_rate: no way to measure one; stale: see `stale`.
   */
  state: 'projected' | 'at_risk' | 'reached' | 'resets_first' | 'not_burning' | 'no_rate' | 'stale';
  ratePctPerHour: number | null;
  rateSource: 'recent' | 'window_average' | null;
  /** When usage reaches 100% at this rate; null = not burning / no rate. */
  hitsAt: number | null;
  /** hitsAt falls before the window resets (null when either is unknown). */
  beforeReset: boolean | null;
}

/** Keep the sample list bounded (mutates + returns it). */
export function pruneSamples(samples: UsageSample[], now: number): UsageSample[] {
  const cutoff = now - SAMPLE_MAX_AGE_MS;
  let drop = 0;
  while (drop < samples.length && samples[drop].at < cutoff) drop++;
  drop = Math.max(drop, samples.length - SAMPLE_MAX_COUNT);
  if (drop > 0) samples.splice(0, drop);
  return samples;
}

const sameWindow = (a: WindowSample, b: WindowSample) =>
  a.resetsAt === null || b.resetsAt === null ? a.resetsAt === b.resetsAt : Math.abs(a.resetsAt - b.resetsAt) < SAME_WINDOW_MS;

/** Project one limit window from the samples (oldest first); null when no sample has it. */
export function projectLimit(samples: UsageSample[], key: LimitKey, now: number): LimitProjection | null {
  const have = samples.filter((s) => s[key] !== null);
  const last = have[have.length - 1];
  if (!last) return null;
  const w = last[key]!;
  const cfg = WINDOWS[key];
  const staleReason = w.resetsAt !== null && now >= w.resetsAt ? 'reset' : now - last.at > cfg.lookbackMs ? 'old_sample' : null;
  const stale = staleReason !== null;
  const base: LimitProjection = {
    window: key,
    label: cfg.label,
    usedPct: w.used,
    resetsAt: w.resetsAt,
    sampledAt: last.at,
    stale,
    staleReason,
    state: stale ? 'stale' : 'no_rate',
    ratePctPerHour: null,
    rateSource: null,
    hitsAt: null,
    beforeReset: null,
  };
  if (stale) return base;
  if (w.used >= 100) {
    base.state = 'reached';
    return base;
  }

  // the current window: same resets_at, and after the last drop in used% (a reset)
  let current = have.filter((s) => sameWindow(s[key]!, w));
  for (let i = current.length - 1; i > 0; i--) {
    if (current[i][key]!.used < current[i - 1][key]!.used) {
      current = current.slice(i);
      break;
    }
  }
  let rate: number | null = null; // % per ms
  const recent = current.filter((s) => s.at >= last.at - cfg.lookbackMs);
  const first = recent[0];
  if (first && last.at - first.at >= MIN_SPAN_MS) {
    rate = Math.max(0, (w.used - first[key]!.used) / (last.at - first.at));
    base.rateSource = 'recent';
  } else if (w.resetsAt !== null) {
    const elapsed = last.at - (w.resetsAt - cfg.ms);
    if (elapsed > 0) {
      rate = Math.max(0, w.used / elapsed);
      base.rateSource = 'window_average';
    }
  }
  if (rate === null) return base;
  base.ratePctPerHour = Math.round(rate * 3_600_000 * 1000) / 1000;
  if (rate === 0) {
    base.state = 'not_burning';
    return base;
  }
  const hitsAt = Math.round(last.at + (100 - w.used) / rate);
  base.hitsAt = Math.max(hitsAt, now); // never in the past
  base.state = hitsAt <= now ? 'at_risk' : 'projected';
  if (w.resetsAt !== null) {
    base.beforeReset = base.hitsAt < w.resetsAt;
    if (!base.beforeReset) base.state = 'resets_first';
  }
  return base;
}

// ---------- vs the phase forecast ----------

export interface PhaseForecastDates {
  phase: { id: string; title: string };
  p50: { days: number; date: string };
  p85: { days: number; date: string };
}

export type ForecastRelation = 'before_p50' | 'before_p85' | 'after_p85';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtCache = new Map<string, Intl.DateTimeFormat>();
const zoneFmt = (tz: string) => {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
};

/** "Thu 1 Oct" (or "Thu 1 Oct, 14:30") for an instant in `tz`; built from parts so ICU's locale data ("Sept") can't vary it. */
export function formatAt(ts: number, tz: string, time = false): string {
  const p = Object.fromEntries(zoneFmt(tz).formatToParts(ts).map((x) => [x.type, x.value]));
  const day = `${p.weekday} ${Number(p.day)} ${MONTHS[Number(p.month) - 1]}`;
  return time ? `${day}, ${p.hour}:${p.minute}` : day;
}
/** "Thu 1 Oct" for a local day (YYYY-MM-DD). */
export const formatDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return formatAt(Date.UTC(y, m - 1, d, 12), 'UTC');
};

export interface LimitReport extends LimitProjection {
  /** hitsAt vs the phase's p50/p85 finish dates (only when the limit is hit before it resets). */
  vsForecast: ForecastRelation | null;
  message: string;
}

/** A projection's plain-language line, and where it lands against the forecast. */
export function describeLimit(p: LimitProjection, f: PhaseForecastDates | null, tz: string): LimitReport {
  const at = (t: number) => formatAt(t, tz, p.window === 'five_hour');
  const name = `the ${p.label} limit`;
  let vsForecast: ForecastRelation | null = null;
  let message: string;
  switch (p.state) {
    case 'stale':
      message =
        p.staleReason === 'reset'
          ? `The ${p.label} window has reset since the last usage update (${p.usedPct}% then): no projection.`
          : `The last ${p.label} usage update (${at(p.sampledAt)}, ${p.usedPct}%) is too old to project from.`;
      break;
    case 'reached':
      message = `The ${p.label} limit is reached (${p.usedPct}%)${p.resetsAt !== null ? `; it resets ${at(p.resetsAt)}` : ''}.`;
      break;
    case 'no_rate':
    case 'not_burning':
      message = `The ${p.label} limit is not being burned at a measurable rate (${p.usedPct}% used).`;
      break;
    case 'resets_first':
      message = `At this rate ${name} resets (${at(p.resetsAt!)}) before it is reached (${p.usedPct}% used).`;
      break;
    default: {
      message =
        p.state === 'at_risk'
          ? `At this rate ${name} is being reached now (${p.usedPct}% at the last update, ${at(p.sampledAt)})`
          : `At this rate ${name} is reached ${at(p.hitsAt!)}`;
      if (f) {
        const hitDay = dayKey(p.hitsAt!, tz);
        vsForecast = hitDay <= f.p50.date ? 'before_p50' : hitDay <= f.p85.date ? 'before_p85' : 'after_p85';
        message +=
          vsForecast === 'before_p50'
            ? `, before the phase's 50% forecast (${formatDay(f.p50.date)})`
            : vsForecast === 'before_p85'
              ? `, before the phase's 85% forecast (${formatDay(f.p85.date)})`
              : `, after the phase's 85% forecast (${formatDay(f.p85.date)})`;
      }
      message += '.';
    }
  }
  return { ...p, vsForecast, message };
}

export type ForecastInfo =
  | ({ status: 'ok' } & PhaseForecastDates)
  | { status: 'insufficient_history' | 'no_phase'; phase: { id: string; title: string } | null; reason: string };

export type UsageBurn =
  | {
      status: 'ok';
      tz: string;
      now: number;
      limits: { five_hour: LimitReport | null; seven_day: LimitReport | null };
      forecast: ForecastInfo | null;
      messages: string[];
    }
  | { status: 'unavailable'; reason: string };

export const NO_USAGE_REASON =
  'no usage-limit data: the statusline script has not pushed /usage since the daemon started';

/** The /metrics/usage-burn view. `forecast` null = no project given (no comparison). */
export function usageBurn(samples: UsageSample[], forecast: ForecastInfo | null, opts: { tz: string; now: number }): UsageBurn {
  const five = projectLimit(samples, 'five_hour', opts.now);
  const week = projectLimit(samples, 'seven_day', opts.now);
  if (!five && !week) return { status: 'unavailable', reason: NO_USAGE_REASON };
  const dates = forecast?.status === 'ok' ? forecast : null;
  const limits = {
    five_hour: five && describeLimit(five, dates, opts.tz),
    seven_day: week && describeLimit(week, dates, opts.tz),
  };
  return {
    status: 'ok',
    tz: opts.tz,
    now: opts.now,
    limits,
    forecast,
    messages: [limits.five_hour?.message, limits.seven_day?.message].filter((m): m is string => !!m),
  };
}
