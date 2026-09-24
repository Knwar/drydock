import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resetsAtMs, shouldNudge, USAGE_PAUSE_PCT, type NudgeInput } from './autopilot.js';

const NOW = 1_700_000_000_000;
const base: NudgeInput = {
  autopilot: true,
  sessionState: 'idle',
  mainIdleSince: NOW - 1000,
  lastNudgedIdleAt: null,
  queued: 2,
  claudeForeground: true,
  fivePct: 10,
  fiveResetsAt: NOW + 3_600_000,
  now: NOW,
};
const run = (over: Partial<NudgeInput>) => shouldNudge({ ...base, ...over });

describe('shouldNudge', () => {
  it('nudges an idle session with queued cards and claude in the foreground', () => {
    assert.equal(run({}).nudge, true);
  });

  it('each "no" branch carries its reason', () => {
    assert.deepEqual(run({ autopilot: false }), { nudge: false, reason: 'autopilot off' });
    assert.deepEqual(run({ sessionState: 'working' }), { nudge: false, reason: 'session working' });
    assert.deepEqual(run({ sessionState: 'needs_you' }), { nudge: false, reason: 'session needs_you' });
    assert.deepEqual(run({ sessionState: 'offline' }), { nudge: false, reason: 'session offline' });
    assert.deepEqual(run({ queued: 0 }), { nudge: false, reason: 'no queued cards' });
    assert.deepEqual(run({ claudeForeground: false }), { nudge: false, reason: 'claude not in foreground' });
    assert.deepEqual(run({ fivePct: 83 }), { nudge: false, reason: `usage 83% ≥ ${USAGE_PAUSE_PCT}%` });
    assert.deepEqual(run({ lastNudgedIdleAt: base.mainIdleSince }), {
      nudge: false,
      reason: 'already nudged this idle period',
    });
  });

  it('usage: null → ok; 79 ok; 80 paused; rolled-over window → ok', () => {
    assert.equal(USAGE_PAUSE_PCT, 80);
    assert.equal(run({ fivePct: null, fiveResetsAt: null }).nudge, true);
    assert.equal(run({ fivePct: 79 }).nudge, true);
    assert.equal(run({ fivePct: 80 }).nudge, false);
    assert.equal(run({ fivePct: 95, fiveResetsAt: NOW - 1 }).nudge, true);
    assert.equal(run({ fivePct: 95, fiveResetsAt: null }).nudge, false);
  });

  it('once per idle period: same idle → no; a new idle period → yes', () => {
    const first = base.mainIdleSince!;
    assert.equal(run({ lastNudgedIdleAt: first }).nudge, false);
    assert.equal(run({ lastNudgedIdleAt: first, mainIdleSince: first + 5000 }).nudge, true);
  });
});

describe('resetsAtMs', () => {
  it('accepts epoch seconds, epoch ms, ISO strings; null when absent', () => {
    assert.equal(resetsAtMs(1_700_000_000), 1_700_000_000_000);
    assert.equal(resetsAtMs(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(resetsAtMs('1700000000'), 1_700_000_000_000);
    assert.equal(resetsAtMs('2023-11-14T22:13:20.000Z'), 1_700_000_000_000);
    assert.equal(resetsAtMs(undefined), null);
    assert.equal(resetsAtMs(null), null);
    assert.equal(resetsAtMs('garbage'), null);
  });
});
