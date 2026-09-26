import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveCards, MetricsParamError, type MetricsCard, type MetricsEvent } from './metrics.js';
import { cardQuality, qualityFromDerived } from './quality.js';

const DAY = 86_400_000;
// 2026-06-01 is a Monday (ISO 2026-W23)
const MON = Date.UTC(2026, 5, 1);

let seq = 0;
const ev = (type: string, created_at: number, payload: Record<string, unknown> | null = null): MetricsEvent => ({
  id: ++seq,
  type,
  payload: payload === null ? null : JSON.stringify(payload),
  created_at,
});
const move = (from: string, to: string, at: number) => ev('move', at, { from, to });
const review = (verdict: string, at: number) => ev('review', at, { verdict });

/** A card created at `t0`, taken to in_review, then the given steps. */
function history(id: string, lane: MetricsCard['lane'], steps: MetricsEvent[], over: Partial<MetricsCard> = {}, t0 = MON) {
  return {
    card: {
      id,
      project_id: 'p',
      phase_id: null,
      title: id,
      lane,
      tag: null,
      assigned_agent: null,
      blocked_at: null,
      blocked_reason: null,
      review_rounds: 0,
      created_at: t0,
      updated_at: t0,
      ...over,
    },
    events: [ev('create', t0, { title: id }), move('backlog', 'in_progress', t0 + 1), move('in_progress', 'in_review', t0 + 2), ...steps],
  };
}

const passFirst = (id: string, t = MON + 10, over = {}) =>
  history(id, 'done', [review('pass', t), move('in_review', 'done', t + 1)], over);
const failThenPass = (id: string, t = MON + 10, over = {}) =>
  history(
    id,
    'done',
    [review('fail', t), move('in_review', 'in_progress', t + 1), move('in_progress', 'in_review', t + 2), review('pass', t + 3), move('in_review', 'done', t + 4)],
    over,
  );
const twoFails = (id: string, t = MON + 10, over = {}) =>
  history(
    id,
    'in_progress',
    [review('fail', t), move('in_review', 'in_progress', t + 1), move('in_progress', 'in_review', t + 2), review('fail', t + 3), move('in_review', 'in_progress', t + 4)],
    over,
  );
const unreviewed = (id: string, over = {}) => history(id, 'in_review', [], over);

const opts = { tz: 'UTC', now: MON + 6 * DAY };
const q = (hs: ReturnType<typeof history>[], extra: { from?: number; to?: number } = {}) =>
  qualityFromDerived(deriveCards(hs, opts.now), { ...opts, ...extra });

describe('cardQuality', () => {
  it('pass first time', () => {
    const c = cardQuality(deriveCards([passFirst('a')], opts.now)[0]);
    assert.deepEqual(
      { reviewed: c.reviewed, firstPass: c.firstPass, rounds: c.rounds, capped: c.capped, rework: c.rework, done: c.done },
      { reviewed: true, firstPass: true, rounds: 1, capped: false, rework: 0, done: true },
    );
    assert.equal(c.finalAt, MON + 10);
  });

  it('fail then pass: 2 rounds, one rework loop, not capped', () => {
    const c = cardQuality(deriveCards([failThenPass('a')], opts.now)[0]);
    assert.equal(c.firstPass, false);
    assert.equal(c.rounds, 2);
    assert.equal(c.rework, 1);
    assert.equal(c.capped, false);
    assert.equal(c.finalAt, MON + 13);
  });

  it('two fails: capped, two rework loops', () => {
    const c = cardQuality(deriveCards([twoFails('a')], opts.now)[0]);
    assert.equal(c.capped, true);
    assert.equal(c.rounds, 2);
    assert.equal(c.rework, 2);
    assert.equal(c.done, false);
  });

  it('a redirect resets rounds (a fresh start); rework before it still counts', () => {
    const h = history('a', 'done', [
      review('fail', MON + 10),
      move('in_review', 'in_progress', MON + 11),
      move('in_progress', 'in_review', MON + 12),
      review('fail', MON + 13),
      ev('redirect', MON + 14, { from: 'in_review' }),
      move('backlog', 'in_progress', MON + 15),
      move('in_progress', 'in_review', MON + 16),
      review('pass', MON + 17),
      move('in_review', 'done', MON + 18),
    ]);
    const c = cardQuality(deriveCards([h], opts.now)[0]);
    assert.equal(c.rounds, 1);
    assert.equal(c.firstPass, true);
    assert.equal(c.capped, false);
    assert.equal(c.rework, 1); // the fail right before the redirect is not a loop
  });

  it('a fail followed only by a redirect is not rework', () => {
    const h = history('a', 'in_progress', [
      review('fail', MON + 10),
      ev('redirect', MON + 11, { from: 'in_review' }),
      move('backlog', 'in_progress', MON + 12),
    ]);
    const c = cardQuality(deriveCards([h], opts.now)[0]);
    assert.equal(c.rework, 0);
    assert.equal(c.reviewed, false); // no review since the redirect
  });
});

describe('qualityFromDerived', () => {
  it('totals across the synthetic mix; unreviewed excluded from rates', () => {
    const r = q([passFirst('a'), failThenPass('b'), twoFails('c'), unreviewed('d')]);
    assert.deepEqual(r.totals, {
      reviewed: 3,
      unreviewed: 1,
      firstPassRate: 1 / 3,
      avgRounds: 1.5, // done + reviewed: a (1), b (2)
      capped: 1,
      rework: 3,
    });
  });

  it('empty data: null rates, not NaN, one zero-filled week', () => {
    const r = q([]);
    assert.deepEqual(r.totals, { reviewed: 0, unreviewed: 0, firstPassRate: null, avgRounds: null, capped: 0, rework: 0 });
    assert.deepEqual(r.byPhase, []);
    assert.equal(r.weekly.length, 1);
    assert.deepEqual(r.weekly[0], { week: '2026-W23', start: '2026-06-01', reviewed: 0, firstPassRate: null, done: 0, avgRounds: null });
    const onlyUnreviewed = q([unreviewed('d')]);
    assert.equal(onlyUnreviewed.totals.unreviewed, 1);
    assert.equal(onlyUnreviewed.totals.firstPassRate, null);
    assert.equal(JSON.stringify(onlyUnreviewed).includes('NaN'), false);
  });

  it('breakdowns per phase / agent / tag', () => {
    const r = qualityFromDerived(
      deriveCards(
        [
          passFirst('a', MON + 10, { phase_id: 'P1', assigned_agent: 'alice', tag: 'ui' }),
          failThenPass('b', MON + 10, { phase_id: 'P1', assigned_agent: 'bob', tag: 'api' }),
          twoFails('c', MON + 10, { phase_id: 'P2', assigned_agent: 'alice', tag: 'ui' }),
          unreviewed('d'),
        ],
        opts.now,
      ),
      { ...opts, phaseTitles: new Map([['P1', 'Phase one']]) },
    );
    const phase = (id: string | null) => r.byPhase.find((p) => p.phase_id === id)!;
    assert.equal(phase('P1').title, 'Phase one');
    assert.equal(phase('P1').reviewed, 2);
    assert.equal(phase('P1').firstPassRate, 0.5);
    assert.equal(phase('P1').avgRounds, 1.5);
    assert.equal(phase('P2').title, null);
    assert.equal(phase('P2').capped, 1);
    assert.equal(phase('P2').avgRounds, null); // not done
    assert.equal(phase(null).unreviewed, 1);
    const alice = r.byAgent.find((x) => x.agent === 'alice')!;
    assert.deepEqual([alice.reviewed, alice.firstPassRate, alice.capped, alice.rework], [2, 0.5, 1, 2]);
    assert.equal(r.byAgent.find((x) => x.agent === 'bob')!.firstPassRate, 0);
    assert.equal(r.byTag.find((x) => x.tag === 'ui')!.reviewed, 2);
    assert.equal(r.byTag.find((x) => x.tag === null)!.unreviewed, 1);
  });

  it('weekly: bucketed by the final review week in tz, zero-filled', () => {
    // a: week 23; b: first review Sunday of week 23, final review Monday of week 25
    const b = failThenPass('b', MON + 7 * DAY - 10);
    b.events = b.events.map((e) => (e.created_at >= MON + 7 * DAY - 7 ? { ...e, created_at: e.created_at + 8 * DAY } : e));
    const r = q([passFirst('a'), b], { to: MON + 15 * DAY });
    assert.deepEqual(
      r.weekly.map((w) => [w.week, w.reviewed, w.firstPassRate, w.done, w.avgRounds]),
      [
        ['2026-W23', 1, 1, 1, 1],
        ['2026-W24', 0, null, 0, null],
        ['2026-W25', 1, 0, 1, 2],
      ],
    );
    assert.equal(r.range.from, MON + 10); // default from: the earliest final review
    // Sunday 23:00 UTC is already Monday in Asia/Kolkata: a moves to week 24
    const late = passFirst('a', MON + 6 * DAY + 23 * 3_600_000);
    const kol = qualityFromDerived(deriveCards([late], opts.now + DAY), { tz: 'Asia/Kolkata', now: opts.now + DAY });
    assert.deepEqual(kol.weekly.map((w) => [w.week, w.reviewed]), [['2026-W24', 1]]);
  });

  it('from/to window applies to the final review; unreviewed by life overlap', () => {
    const early = passFirst('a', MON + 10);
    const later = passFirst('b', MON + 3 * DAY);
    const r = q([early, later, unreviewed('d')], { from: MON + 2 * DAY, to: MON + 4 * DAY });
    assert.equal(r.totals.reviewed, 1);
    assert.equal(r.totals.unreviewed, 1); // still open, so its life overlaps
    assert.throws(() => q([], { from: 2, to: 1 }), MetricsParamError);
  });
});
