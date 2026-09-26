import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createPhase, createTask, createVertical, getOrCreateProject, raiseBlocker, resolveBlocker } from './board.js';
import { openDb, type DB } from './db.js';
import { MetricsParamError } from './metrics.js';
import { SessionStates, OFFLINE_MS, type StatusEntry } from '../daemon/session-state.js';
import {
  closeOpenWaits,
  computeWait,
  loadBlockers,
  loadNeedsYou,
  recordSessionChange,
  waitMetrics,
  type BlockerInterval,
  type NeedsYouInterval,
  type WaitRow,
} from './wait-time.js';

const T = 1_700_000_000_000;
const MIN = 60_000;
const rows = (db: DB) => db.prepare('SELECT * FROM wait_intervals ORDER BY id').all() as WaitRow[];
const ping = (verb: string, at: number, task_id: string | null = null, detail = ''): StatusEntry => ({
  agent: 'orchestrator',
  agent_id: null,
  verb,
  detail,
  task_id,
  at,
});

/** A SessionStates wired to the db exactly as the daemon wires it. */
const wired = (db: DB) => new SessionStates((c) => recordSessionChange(db, c));

describe('needs_you intervals (persistence)', () => {
  it('opens on entering needs_you and closes on leaving it', () => {
    const db = openDb();
    const s = wired(db);
    s.record('p', ping('Edit', T));
    assert.equal(rows(db).length, 0);
    s.record('p', ping('needs you', T + MIN, 'card1', 'Claude needs your permission to use Bash'));
    let r = rows(db);
    assert.equal(r.length, 1);
    assert.deepEqual(
      { ...r[0], id: 0 },
      {
        id: 0,
        project_id: 'p',
        agent_id: 'orchestrator',
        task_id: 'card1',
        kind: 'needs_you',
        started_at: T + MIN,
        ended_at: null,
        reason: 'Claude needs your permission to use Bash',
        closed_by: null,
      },
    );
    // a repeated needs-you ping keeps the same interval
    s.record('p', ping('needs you', T + 2 * MIN));
    assert.equal(rows(db).length, 1);
    s.record('p', ping('Bash', T + 3 * MIN));
    r = rows(db);
    assert.equal(r.length, 1);
    assert.equal(r[0].ended_at, T + 3 * MIN);
    assert.equal(r[0].closed_by, 'working');
    // again, left for idle
    s.record('p', ping('needs you', T + 4 * MIN));
    s.record('p', ping('idle', T + 5 * MIN));
    r = rows(db);
    assert.equal(r.length, 2);
    assert.deepEqual([r[1].started_at, r[1].ended_at, r[1].closed_by], [T + 4 * MIN, T + 5 * MIN, 'idle']);
    db.close();
  });

  it('closes at the offline moment on a silent timeout (sweep or the next ping)', () => {
    const db = openDb();
    const s = wired(db);
    s.record('p', ping('needs you', T));
    s.sweep(T + OFFLINE_MS - 1);
    assert.equal(rows(db)[0].ended_at, null);
    s.sweep(T + OFFLINE_MS + 5 * MIN);
    assert.deepEqual([rows(db)[0].ended_at, rows(db)[0].closed_by], [T + OFFLINE_MS, 'offline']);

    // no sweep: the next ping notices it went offline first
    s.record('q', ping('needs you', T));
    s.record('q', ping('Edit', T + 3 * OFFLINE_MS));
    const q = rows(db).find((r) => r.project_id === 'q')!;
    assert.deepEqual([q.ended_at, q.closed_by], [T + OFFLINE_MS, 'offline']);
    db.close();
  });

  it('a live subagent keeps it open past the main session going stale', () => {
    const db = openDb();
    const s = wired(db);
    s.record('p', ping('needs you', T));
    s.record('p', { ...ping('Bash', T + OFFLINE_MS - MIN), agent: 'builder', agent_id: 'b1' });
    s.sweep(T + OFFLINE_MS + MIN);
    assert.equal(rows(db)[0].ended_at, null);
    s.sweep(T + 2 * OFFLINE_MS);
    assert.equal(rows(db)[0].ended_at, T + 2 * OFFLINE_MS - MIN);
    db.close();
  });

  it('forget closes an open interval', () => {
    const db = openDb();
    const s = wired(db);
    s.record('p', ping('needs you', T));
    s.forget('p', T + MIN);
    assert.deepEqual([rows(db)[0].ended_at, rows(db)[0].closed_by], [T + MIN, 'offline']);
    db.close();
  });

  it('closeOpenWaits closes leftovers at startup (capped), marked restart', () => {
    const db = openDb();
    const s = wired(db);
    s.record('a', ping('needs you', T));
    s.record('b', ping('needs you', T + 9 * MIN));
    s.record('c', ping('needs you', T));
    s.record('c', ping('Edit', T + MIN));
    assert.equal(closeOpenWaits(db, T + 10 * MIN, OFFLINE_MS), 2);
    const r = rows(db);
    assert.deepEqual(
      r.map((x) => [x.project_id, x.ended_at, x.closed_by]),
      [
        ['a', T + 10 * MIN, 'restart'],
        ['b', T + 10 * MIN, 'restart'],
        ['c', T + MIN, 'working'],
      ],
    );
    // a long downtime is capped at started_at + cap
    s.record('d', ping('needs you', T));
    closeOpenWaits(db, T + 1000 * MIN, OFFLINE_MS);
    assert.equal(rows(db).find((x) => x.project_id === 'd')!.ended_at, T + OFFLINE_MS);
    assert.equal(closeOpenWaits(db, T + 2000 * MIN, OFFLINE_MS), 0);
    db.close();
  });
});

const need = (over: Partial<NeedsYouInterval>): NeedsYouInterval => ({
  id: 1,
  project_id: 'p',
  agent_id: 'orchestrator',
  task_id: null,
  kind: 'needs_you',
  started_at: T,
  ended_at: null,
  reason: null,
  closed_by: null,
  phase_id: null,
  ...over,
});
const block = (over: Partial<BlockerInterval>): BlockerInterval => ({
  project_id: 'p',
  task_id: 't',
  title: 'T',
  phase_id: null,
  from: T,
  to: null,
  reason: null,
  ...over,
});

describe('computeWait', () => {
  it('totals, counts and nearest-rank p50/p85 durations', () => {
    const durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => m * MIN);
    const needs = durations.map((d, i) => need({ id: i, started_at: T + i * 20 * MIN, ended_at: T + i * 20 * MIN + d }));
    const w = computeWait(needs, [], { tz: 'UTC', now: T + 1000 * MIN });
    assert.equal(w.needsYou.count, 10);
    assert.equal(w.needsYou.totalMs, 55 * MIN);
    assert.deepEqual(w.needsYou.duration, { p50: 5 * MIN, p85: 9 * MIN, count: 10 });
    assert.deepEqual(w.range, { from: T, to: T + 1000 * MIN, tz: 'UTC' });
    assert.deepEqual(w.blocked, { count: 0, totalMs: 0, resolution: { p50: null, p85: null, count: 0 } });
    assert.deepEqual(w.waiting, { count: 0, longestMs: null, needsYou: [], blockers: [] });
  });

  it('clips totals to the window; percentiles use completed intervals ending in it', () => {
    const needs = [
      need({ started_at: T - 10 * MIN, ended_at: T + 10 * MIN }), // straddles from
      need({ started_at: T + 50 * MIN, ended_at: T + 70 * MIN }), // straddles to
      need({ started_at: T - 30 * MIN, ended_at: T - 20 * MIN }), // before
    ];
    const w = computeWait(needs, [], { tz: 'UTC', now: T + 100 * MIN, from: T, to: T + 60 * MIN });
    assert.equal(w.needsYou.count, 2);
    assert.equal(w.needsYou.totalMs, 20 * MIN);
    assert.deepEqual(w.needsYou.duration, { p50: 20 * MIN, p85: 20 * MIN, count: 1 });
  });

  it('open intervals run to now and are listed as currently waiting', () => {
    const now = T + 30 * MIN;
    const w = computeWait(
      [need({ started_at: T + 20 * MIN, task_id: 'x', reason: 'perm' })],
      [block({ from: T, reason: 'which db?' }), block({ task_id: 'u', from: T, to: T + 5 * MIN })],
      { tz: 'UTC', now },
    );
    assert.equal(w.needsYou.totalMs, 10 * MIN);
    assert.equal(w.needsYou.duration.count, 0);
    assert.equal(w.blocked.count, 2);
    assert.equal(w.blocked.totalMs, 35 * MIN);
    assert.deepEqual(w.blocked.resolution, { p50: 5 * MIN, p85: 5 * MIN, count: 1 });
    assert.equal(w.waiting.count, 2);
    assert.equal(w.waiting.longestMs, 30 * MIN);
    assert.deepEqual(w.waiting.needsYou, [
      { project_id: 'p', agent_id: 'orchestrator', task_id: 'x', reason: 'perm', since: T + 20 * MIN, waitingMs: 10 * MIN },
    ]);
    assert.deepEqual(w.waiting.blockers, [
      { project_id: 'p', task_id: 't', title: 'T', phase_id: null, reason: 'which db?', since: T, waitingMs: 30 * MIN },
    ]);
  });

  it('breaks down per phase and per board, with names, largest first', () => {
    const w = computeWait(
      [need({ project_id: 'a', phase_id: 'ph1', started_at: T, ended_at: T + MIN }), need({ project_id: 'b', started_at: T, ended_at: T + 3 * MIN })],
      [block({ project_id: 'a', phase_id: 'ph1', from: T, to: T + 5 * MIN })],
      { tz: 'UTC', now: T + 10 * MIN, phaseTitles: new Map([['ph1', 'Phase 1']]), boardNames: new Map([['a', 'A'], ['b', 'B']]) },
    );
    assert.deepEqual(w.byPhase, [
      { phase_id: 'ph1', title: 'Phase 1', needsYou: { count: 1, totalMs: MIN }, blocked: { count: 1, totalMs: 5 * MIN } },
      { phase_id: null, title: null, needsYou: { count: 1, totalMs: 3 * MIN }, blocked: { count: 0, totalMs: 0 } },
    ]);
    assert.deepEqual(w.byBoard, [
      { project_id: 'a', name: 'A', needsYou: { count: 1, totalMs: MIN }, blocked: { count: 1, totalMs: 5 * MIN } },
      { project_id: 'b', name: 'B', needsYou: { count: 1, totalMs: 3 * MIN }, blocked: { count: 0, totalMs: 0 } },
    ]);
  });

  it('rejects from > to', () => {
    assert.throws(() => computeWait([], [], { tz: 'UTC', now: T, from: T + 1, to: T }), MetricsParamError);
  });
});

describe('wait-time DB readers', () => {
  const setup = (t: TestContext) => {
    const db = openDb();
    const root = mkdtempSync(join(tmpdir(), 'wait-'));
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, 'ws', 'api'), { recursive: true });
    const ws = getOrCreateProject(db, join(root, 'ws'), 'ws');
    const v = createVertical(db, ws.id, 'api', join(root, 'ws', 'api'));
    const other = getOrCreateProject(db, join(root, 'other'), 'other');
    const phase = createPhase(db, ws.id, 'P1');
    const a = createTask(db, ws.id, 'A', { phase_id: phase.id });
    const b = createTask(db, v.id, 'B');
    const c = createTask(db, other.id, 'C');
    return { db, ws, v, other, phase, a, b, c };
  };

  it('scopes needs_you and blockers to a workspace + its verticals, and by phase', (t) => {
    const { db, ws, v, other, phase, a, b, c } = setup(t);
    const s = wired(db);
    const now = Date.now();
    s.record(ws.id, ping('needs you', now - 5 * MIN, a.id));
    s.record(v.id, ping('needs you', now - 3 * MIN));
    s.record(v.id, ping('Edit', now - 2 * MIN));
    s.record(other.id, ping('needs you', now - MIN));
    raiseBlocker(db, a.id, 'why');
    raiseBlocker(db, b.id, 'which');
    resolveBlocker(db, b.id);
    raiseBlocker(db, c.id, 'other');

    assert.deepEqual(loadNeedsYou(db, { projectIds: [ws.id] }).map((n) => n.project_id).sort(), [ws.id, v.id].sort());
    assert.deepEqual(loadNeedsYou(db, { projectIds: [ws.id], phaseId: phase.id }).map((n) => n.task_id), [a.id]);
    assert.deepEqual(loadNeedsYou(db, { projectIds: [ws.id], phaseId: phase.id })[0].phase_id, phase.id);
    assert.deepEqual(loadBlockers(db, { projectIds: [ws.id] }).map((x) => x.task_id).sort(), [a.id, b.id].sort());
    assert.deepEqual(loadBlockers(db, { projectIds: [ws.id], phaseId: phase.id }).map((x) => x.task_id), [a.id]);
    // window prefilter: intervals ended before `from` are not loaded
    assert.equal(loadNeedsYou(db, { projectIds: [ws.id], from: now - MIN }).length, 1);

    const w = waitMetrics(db, { projectIds: [ws.id] }, { tz: 'UTC', now });
    assert.equal(w.needsYou.count, 2);
    assert.equal(w.needsYou.duration.count, 1);
    assert.equal(w.blocked.count, 2);
    assert.equal(w.blocked.resolution.count, 1);
    assert.equal(w.waiting.count, 2); // ws needs_you + blocker on A
    assert.deepEqual(w.waiting.blockers.map((x) => x.task_id), [a.id]);
    assert.deepEqual(w.waiting.needsYou.map((x) => x.project_id), [ws.id]);
    assert.equal(w.byBoard.find((x) => x.project_id === v.id)?.name, 'api');
    assert.equal(w.byPhase.find((x) => x.phase_id === phase.id)?.title, 'P1');
    assert.throws(() => waitMetrics(db, { projectIds: [ws.id], from: now + 1, to: now }, { tz: 'UTC', now }), MetricsParamError);
  });
});
