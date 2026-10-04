import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { delta, parseCompare, previousWindow, withPrevious } from './compare.js';
import type { CardFilter } from './types.js';

const DAY = 86_400_000;

describe('previousWindow', () => {
  it('returns the equal-length window immediately before', () => {
    const w = previousWindow(1000, 1999);
    assert.deepEqual(w, { from: 0, to: 999 });
    assert.equal(w!.to - w!.from, 1999 - 1000);
  });

  it('is plain ms arithmetic across a DST change', () => {
    // 2026-03-08 is the US spring-forward day; a 7-day range ending after it.
    const from = Date.UTC(2026, 2, 5, 8);
    const to = from + 7 * DAY - 1;
    const w = previousWindow(from, to)!;
    assert.equal(w.to, from - 1);
    assert.equal(w.to - w.from, to - from);
    assert.equal(w.from, from - 7 * DAY);
  });

  it('is null for all time (no from)', () => {
    assert.equal(previousWindow(undefined, 5000), null);
    assert.equal(previousWindow(null, null), null);
  });

  it('treats a missing to as now', () => {
    assert.deepEqual(previousWindow(1000, undefined, 2000), { from: -1, to: 999 });
  });
});

describe('withPrevious', () => {
  type Result = { count: number; items: number[] };
  const compute = (f: CardFilter): Result => {
    const items = [f.from ?? -1, f.to ?? -1];
    return { count: (f.to ?? 0) - (f.from ?? 0), items };
  };
  const pick = (r: Result) => ({ count: r.count });

  it('runs compute over the shifted window and keeps only picked fields', () => {
    const calls: CardFilter[] = [];
    const filter: CardFilter = { tag: 'x', from: 1000, to: 1999 };
    const out = withPrevious(
      filter,
      (f) => {
        calls.push(f);
        return compute(f);
      },
      pick,
    );
    assert.equal(out.count, 999);
    assert.deepEqual(out.items, [1000, 1999]);
    assert.deepEqual(out.previous, { count: 999 });
    assert.equal('items' in out.previous!, false);
    assert.deepEqual(out.window, { from: 1000, to: 1999 });
    assert.deepEqual(out.previousWindow, { from: 0, to: 999 });
    assert.deepEqual(calls[1], { tag: 'x', from: 0, to: 999 });
  });

  it('uses now for a missing to', () => {
    const out = withPrevious({ from: 1000 }, compute, pick, { now: 3000 });
    assert.deepEqual(out.window, { from: 1000, to: 3000 });
    assert.deepEqual(out.previousWindow, { from: -1001, to: 999 });
  });

  it('gives null previous and windows for all time', () => {
    let n = 0;
    const out = withPrevious(
      { to: 5000 } as CardFilter,
      (f) => {
        n++;
        return compute(f);
      },
      pick,
    );
    assert.equal(out.previous, null);
    assert.equal(out.previousWindow, null);
    assert.equal(out.window, null);
    assert.equal(n, 1);
  });

  it('accepts a custom compare window', () => {
    const out = withPrevious({ from: 1000, to: 1999 }, compute, pick, { compare: { from: 10, to: 20 } });
    assert.deepEqual(out.previousWindow, { from: 10, to: 20 });
    assert.deepEqual(out.previous, { count: 10 });
  });
});

describe('parseCompare', () => {
  const current = { from: 1000, to: 1999 };

  it("'previous' gives the preceding window", () => {
    assert.deepEqual(parseCompare('previous', current), { from: 0, to: 999 });
    assert.equal(parseCompare('previous', {}), null);
  });

  it('parses epoch-ms from,to', () => {
    assert.deepEqual(parseCompare('10,20', current), { from: 10, to: 20 });
  });

  it('parses YYYY-MM-DD days in tz (inclusive)', () => {
    const w = parseCompare('2026-01-01,2026-01-02', current, { tz: 'UTC' });
    assert.deepEqual(w, { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 3) - 1 });
  });

  it('is null when absent or invalid', () => {
    assert.equal(parseCompare(null, current), null);
    assert.equal(parseCompare(undefined, current), null);
    assert.equal(parseCompare('', current), null);
    assert.equal(parseCompare('nope', current), null);
    assert.equal(parseCompare('10', current), null);
    assert.equal(parseCompare('10,20,30', current), null);
    assert.equal(parseCompare('10,', current), null);
    assert.equal(parseCompare('2026-13-40,2026-01-02', current, { tz: 'UTC' }), null);
    assert.equal(parseCompare('20,10', current), null);
  });
});

describe('delta', () => {
  it('computes abs and pct', () => {
    assert.deepEqual(delta(15, 10), { abs: 5, pct: 50 });
    assert.deepEqual(delta(5, 10), { abs: -5, pct: -50 });
  });

  it('pct is null when previous is 0 or missing', () => {
    assert.deepEqual(delta(5, 0), { abs: 5, pct: null });
    assert.deepEqual(delta(5, null), { abs: 5, pct: null });
    assert.deepEqual(delta(5, undefined), { abs: 5, pct: null });
    assert.deepEqual(delta(0, 0), { abs: 0, pct: null });
  });
});
