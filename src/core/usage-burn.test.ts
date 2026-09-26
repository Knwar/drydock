import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayKey } from './metrics.js';
import {
  describeLimit,
  NO_USAGE_REASON,
  projectLimit,
  pruneSamples,
  SAMPLE_MAX_COUNT,
  usageBurn,
  type PhaseForecastDates,
  type UsageSample,
} from './usage-burn.js';

const H = 3_600_000;
const DAY = 24 * H;
const tz = 'UTC';
const now = Date.UTC(2026, 8, 26, 12); // Sat 26 Sep 2026 12:00 UTC

const week = (used: number, at: number, resetsAt = now + 4 * DAY): UsageSample => ({
  at,
  five_hour: null,
  seven_day: { used, resetsAt },
});
const five = (used: number, at: number, resetsAt = now + 2 * H): UsageSample => ({
  at,
  five_hour: { used, resetsAt },
  seven_day: null,
});
const forecastAt = (p50: string, p85: string): PhaseForecastDates => ({
  phase: { id: 'ph', title: 'P' },
  p50: { days: 0, date: p50 },
  p85: { days: 0, date: p85 },
});

describe('projectLimit', () => {
  it('recent rate: the slope of the current window over the lookback', () => {
    // weekly: 40% -> 50% over the last 10 hours = 1%/h; 50% left → hits in 50h (Mon 28 Sep 14:00)
    const samples = [week(10, now - 3 * DAY), week(40, now - 10 * H), week(50, now)];
    const p = projectLimit(samples, 'seven_day', now)!;
    assert.equal(p.rateSource, 'recent');
    assert.equal(p.ratePctPerHour, 1);
    assert.equal(p.hitsAt, now + 50 * H);
    assert.equal(p.beforeReset, true);
    assert.equal(p.stale, false);
  });

  it('samples from a previous window are ignored', () => {
    const samples = [week(90, now - 2 * H, now - H), week(20, now - H), week(21, now)];
    const p = projectLimit(samples, 'seven_day', now)!;
    assert.equal(p.rateSource, 'recent');
    assert.equal(p.ratePctPerHour, 1);
  });

  it('a single sample falls back to the window average since the window opened', () => {
    // 5-hour window resets in 2h, so it opened 3h ago: 60% / 3h = 20%/h; 40% left → 2h → exactly at reset
    const p = projectLimit([five(60, now)], 'five_hour', now)!;
    assert.equal(p.rateSource, 'window_average');
    assert.equal(p.ratePctPerHour, 20);
    assert.equal(p.hitsAt, now + 2 * H);
    assert.equal(p.beforeReset, false);
    // 90%: 30%/h → 10% left in 20 min, before the reset
    const q = projectLimit([five(90, now)], 'five_hour', now)!;
    assert.equal(q.hitsAt, now + 20 * 60_000);
    assert.equal(q.beforeReset, true);
  });

  it('no rate without resets_at and a short span; flat usage never hits; stale windows are not projected', () => {
    const noReset = projectLimit([{ at: now, five_hour: { used: 10, resetsAt: null }, seven_day: null }], 'five_hour', now)!;
    assert.deepEqual([noReset.state, noReset.rateSource, noReset.hitsAt, noReset.beforeReset], ['no_rate', null, null, null]);
    const flat = projectLimit([week(30, now - 5 * H), week(30, now)], 'seven_day', now)!;
    assert.deepEqual([flat.state, flat.ratePctPerHour, flat.hitsAt], ['not_burning', 0, null]);
    const reset = projectLimit([week(30, now - 2 * DAY, now - DAY)], 'seven_day', now)!;
    assert.deepEqual([reset.stale, reset.staleReason, reset.state, reset.hitsAt], [true, 'reset', 'stale', null]);
    // the last push is older than the lookback (5-hour: 1 hour)
    const old = projectLimit([five(50, now - 2 * H, now + H)], 'five_hour', now)!;
    assert.deepEqual([old.stale, old.staleReason, old.hitsAt], [true, 'old_sample', null]);
    const full = projectLimit([five(100, now - 10 * 60_000)], 'five_hour', now)!;
    assert.deepEqual([full.state, full.hitsAt], ['reached', null]);
    assert.equal(projectLimit([five(10, now)], 'seven_day', now), null);
  });

  it('never projects a hit in the past: at this rate it is being hit now (at_risk)', () => {
    // 50% -> 95% in 5 minutes, last push 45 minutes ago: the projection (~0.5 min later) is already past
    const p = projectLimit([five(50, now - 50 * 60_000), five(95, now - 45 * 60_000)], 'five_hour', now)!;
    assert.equal(p.state, 'at_risk');
    assert.equal(p.hitsAt, now);
    assert.equal(p.beforeReset, true);
    const r = describeLimit(p, null, tz);
    assert.equal(r.message, 'At this rate the 5-hour limit is being reached now (95% at the last update, Sat 26 Sep, 11:15).');
  });

  it('without resets_at, a drop in used% marks a reset: only the samples after it count', () => {
    const s = (used: number, minsAgo: number): UsageSample => ({ at: now - minsAgo * 60_000, five_hour: { used, resetsAt: null }, seven_day: null });
    const p = projectLimit([s(80, 50), s(90, 40), s(5, 30), s(10, 20)], 'five_hour', now)!;
    assert.equal(p.rateSource, 'recent');
    assert.equal(p.ratePctPerHour, 30); // 5% in 10 minutes, not the (10 - 80) slope across the reset
    assert.equal(p.hitsAt, now - 20 * 60_000 + 3 * H);
    assert.equal(p.state, 'projected');
  });

  it('pruneSamples drops old samples and caps the count', () => {
    const s = [week(1, now - 9 * DAY), week(2, now - DAY)];
    assert.deepEqual(pruneSamples(s, now).map((x) => x.seven_day!.used), [2]);
    const many = Array.from({ length: SAMPLE_MAX_COUNT + 5 }, (_, i) => week(i, now));
    assert.equal(pruneSamples(many, now).length, SAMPLE_MAX_COUNT);
    assert.equal(many[0].seven_day!.used, 5);
  });
});

describe('vs the phase forecast', () => {
  // 1%/h from 50% → hits Mon 28 Sep 14:00 UTC; the window resets Wed 30 Sep 12:00
  const p = projectLimit([week(40, now - 10 * H), week(50, now)], 'seven_day', now)!;

  it('before the 85% forecast', () => {
    const r = describeLimit(p, forecastAt('2026-09-27', '2026-10-03'), tz);
    assert.equal(r.vsForecast, 'before_p85');
    assert.equal(r.message, "At this rate the weekly limit is reached Mon 28 Sep, before the phase's 85% forecast (Sat 3 Oct).");
  });

  it('before the 50% forecast, and after the 85%', () => {
    assert.equal(describeLimit(p, forecastAt('2026-09-28', '2026-10-03'), tz).vsForecast, 'before_p50');
    const after = describeLimit(p, forecastAt('2026-09-26', '2026-09-27'), tz);
    assert.equal(after.vsForecast, 'after_p85');
    assert.match(after.message, /after the phase's 85% forecast \(Sun 27 Sep\)/);
  });

  it('a limit that resets first is not compared; no forecast → no comparison', () => {
    const slow = projectLimit([week(40, now - 10 * H), week(41, now)], 'seven_day', now)!;
    const r = describeLimit(slow, forecastAt('2026-09-27', '2026-10-03'), tz);
    assert.equal(r.vsForecast, null);
    assert.equal(r.message, 'At this rate the weekly limit resets (Wed 30 Sep) before it is reached (41% used).');
    const none = describeLimit(p, null, tz);
    assert.equal(none.message, 'At this rate the weekly limit is reached Mon 28 Sep.');
    assert.equal(dayKey(p.hitsAt!, tz), '2026-09-28');
  });

  it('the 5-hour limit is stated with its time', () => {
    const r = describeLimit(projectLimit([five(90, now)], 'five_hour', now)!, null, tz);
    assert.equal(r.message, 'At this rate the 5-hour limit is reached Sat 26 Sep, 12:20.');
  });
});

describe('usageBurn', () => {
  it('unavailable without any limit data', () => {
    assert.deepEqual(usageBurn([], null, { tz, now }), { status: 'unavailable', reason: NO_USAGE_REASON });
  });

  it('both windows with messages and the forecast attached', () => {
    const f = { status: 'ok' as const, ...forecastAt('2026-09-27', '2026-10-03') };
    const r = usageBurn([five(90, now), week(40, now - 10 * H), week(50, now)], f, { tz, now });
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.limits.five_hour!.vsForecast, 'before_p50');
    assert.equal(r.limits.seven_day!.vsForecast, 'before_p85');
    assert.equal(r.messages.length, 2);
    assert.equal(r.forecast, f);
    const insufficient = usageBurn([week(50, now)], { status: 'insufficient_history', phase: f.phase, reason: 'too_few_done' }, { tz, now });
    assert.equal(insufficient.status === 'ok' && insufficient.limits.seven_day!.vsForecast, null);
  });
});
