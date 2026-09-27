import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createPhase, createTask, createVertical, getOrCreateProject, getPhases, isIsoDate, moveTask, setPhaseTarget, updatePhase } from './board.js';
import { openDb } from './db.js';
import { createMilestone } from './milestones.js';
import { MAX_FORECAST_PHASES, schedule, scheduleStatus, type ScheduleInput } from './schedule.js';

const today = '2026-10-01';
const base: ScheduleInput = {
  target_date: '2026-10-10',
  phase_status: 'active',
  total: 5,
  remaining: 3,
  forecast: { p50: '2026-10-05', p85: '2026-10-08' },
  today,
};
const status = (patch: Partial<ScheduleInput>) => scheduleStatus({ ...base, ...patch }).status;

describe('scheduleStatus', () => {
  it('on_track when p85 <= target (boundary: p85 == target)', () => {
    assert.equal(status({}), 'on_track');
    assert.equal(status({ target_date: '2026-10-08' }), 'on_track');
  });

  it('at_risk when p50 <= target < p85 (boundary: p50 == target)', () => {
    assert.equal(status({ target_date: '2026-10-07' }), 'at_risk');
    assert.equal(status({ target_date: '2026-10-05' }), 'at_risk');
  });

  it('late when p50 > target', () => {
    assert.equal(status({ target_date: '2026-10-04' }), 'late');
  });

  it('target == today is not past: the forecast decides', () => {
    assert.equal(status({ target_date: today, forecast: { p50: '2026-10-02', p85: '2026-10-03' } }), 'late');
    assert.equal(status({ target_date: today, forecast: { p50: today, p85: today } }), 'on_track');
    assert.equal(status({ target_date: today, forecast: null }), 'unknown');
  });

  it('late when the target has passed with work remaining, even without a forecast', () => {
    const r = scheduleStatus({ ...base, target_date: '2026-09-30', forecast: null });
    assert.equal(r.status, 'late');
    assert.match(r.reason, /has passed with 3 cards left/);
  });

  it('done wins over everything', () => {
    assert.equal(status({ phase_status: 'done' }), 'done');
    assert.equal(status({ phase_status: 'done', target_date: '2026-01-01', forecast: null }), 'done');
    assert.equal(status({ phase_status: 'done', target_date: null }), 'done');
  });

  it('complete when every card is done but the phase is open; unknown when it has no cards', () => {
    const c = scheduleStatus({ ...base, remaining: 0, forecast: { p50: today, p85: today }, target_date: '2026-09-01' });
    assert.deepEqual([c.status, c.reason], ['complete', 'All cards done: advance the phase to close it']);
    assert.equal(status({ remaining: 0, target_date: null }), 'complete');
    const e = scheduleStatus({ ...base, total: 0, remaining: 0, target_date: '2026-09-01' });
    assert.deepEqual([e.status, e.reason], ['unknown', 'No cards yet']);
    assert.equal(status({ total: 0, remaining: 0, phase_status: 'done' }), 'done');
  });

  it('the reason names a workspace-history fallback and a no-forecast cause', () => {
    const r = scheduleStatus({ ...base, forecast: { ...base.forecast!, note: 'forecast uses workspace history; mobile has too little' } });
    assert.equal(r.reason, '85% likely by 2026-10-08, target 2026-10-10; forecast uses workspace history; mobile has too little');
    assert.equal(scheduleStatus({ ...base, forecast: null, no_forecast_reason: 'too many phases' }).reason, 'too many phases');
  });

  it('unknown without a target or without a forecast', () => {
    assert.equal(status({ target_date: null }), 'unknown');
    assert.equal(status({ target_date: null, remaining: 5 }), 'unknown');
    assert.equal(status({ forecast: null }), 'unknown');
  });

  it('carries the reason and the dates', () => {
    assert.deepEqual(scheduleStatus({ ...base, target_date: '2026-10-07' }), {
      status: 'at_risk',
      reason: '50% likely by 2026-10-05 but 85% only by 2026-10-08, target 2026-10-07',
      target_date: '2026-10-07',
      p50: '2026-10-05',
      p85: '2026-10-08',
    });
    assert.deepEqual(scheduleStatus({ ...base, forecast: null, target_date: null }), {
      status: 'unknown',
      reason: 'no target date',
      target_date: null,
      p50: null,
      p85: null,
    });
  });
});

describe('phase target_date', () => {
  it('isIsoDate accepts real days only', () => {
    for (const ok of ['2026-10-05', '2024-02-29']) assert.ok(isIsoDate(ok), ok);
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-1-5', '20261005', '', null, 5, '2026-10-05T00:00'])
      assert.ok(!isIsoDate(bad), String(bad));
  });

  it('set, read via getPhases, clear; bad values throw', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const p = getOrCreateProject(db, '/tmp/sched-target', 'S');
    const ph = createPhase(db, p.id, 'P1');
    assert.equal(ph.target_date, null);
    assert.equal(setPhaseTarget(db, ph.id, '2026-10-05').target_date, '2026-10-05');
    assert.equal(getPhases(db, p.id)[0].target_date, '2026-10-05');
    assert.equal(setPhaseTarget(db, ph.id, null).target_date, null);
    assert.throws(() => setPhaseTarget(db, ph.id, '2026-02-30'), /YYYY-MM-DD/);
    assert.throws(() => setPhaseTarget(db, 'nope', null), /no such phase/);
  });

  it('migrates a legacy phases table without target_date', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-sched-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'b.db');
    const a = openDb(path);
    a.exec('ALTER TABLE phases DROP COLUMN target_date');
    a.close();
    const b = openDb(path);
    t.after(() => b.close());
    assert.ok((b.pragma('table_info(phases)') as { name: string }[]).some((c) => c.name === 'target_date'));
  });
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1, 12);

/** `n` cards done on `board`, one a day over the last n days. */
function history(db: ReturnType<typeof openDb>, board: string, n: number) {
  for (let i = 0; i < n; i++) {
    const c = createTask(db, board, `d${i}`);
    moveTask(db, c.id, 'done');
    const at = NOW - (i + 1) * DAY;
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(at - 1000, at, c.id);
    db.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(at, c.id);
  }
}
const open = (db: ReturnType<typeof openDb>, board: string, phaseId: string, n: number) => {
  for (let i = 0; i < n; i++) createTask(db, board, 'x', { phase_id: phaseId });
};

describe('schedule()', () => {
  it('forecasts only targeted open phases; complete / empty / done; attaches milestones', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const p = getOrCreateProject(db, '/tmp/sched-view', 'S');
    history(db, p.id, 14);
    const early = createPhase(db, p.id, 'early');
    const far = createPhase(db, p.id, 'far');
    const none = createPhase(db, p.id, 'none');
    const closed = createPhase(db, p.id, 'closed');
    const finished = createPhase(db, p.id, 'finished');
    const empty = createPhase(db, p.id, 'empty');
    for (const ph of [early, far, none]) open(db, p.id, ph.id, 3);
    const f = createTask(db, p.id, 'f', { phase_id: finished.id });
    moveTask(db, f.id, 'done');
    setPhaseTarget(db, early.id, '2026-09-20'); // past, work left
    setPhaseTarget(db, far.id, '2027-01-01');
    setPhaseTarget(db, closed.id, '2026-09-01');
    setPhaseTarget(db, finished.id, '2026-09-01');
    setPhaseTarget(db, empty.id, '2027-01-01');
    updatePhase(db, closed.id, { status: 'done' });
    const m = createMilestone(db, { project_id: p.id, title: 'Beta', date: '2026-11-01', phase_id: far.id });
    createMilestone(db, { project_id: p.id, title: 'Loose', date: '2026-12-01' });

    const v = schedule(db, p.id, { tz: 'UTC', now: NOW, seed: 3 });
    assert.equal(v.today, '2026-10-01');
    const by = Object.fromEntries(v.phases.map((x) => [x.title, x]));
    assert.equal(by.early.status, 'late');
    assert.ok(by.early.p50, 'a targeted open phase is forecast');
    assert.equal(by.far.status, 'on_track');
    assert.deepEqual(by.far.milestones.map((x) => x.id), [m.id]);
    assert.deepEqual([by.none.status, by.none.p50, by.none.remaining], ['unknown', null, 3]);
    assert.deepEqual([by.closed.status, by.closed.p50], ['done', null]);
    assert.deepEqual([by.finished.status, by.finished.p50], ['complete', null]);
    assert.deepEqual([by.empty.status, by.empty.reason, by.empty.p50], ['unknown', 'No cards yet', null]);
    assert.deepEqual(v.milestones.map((x) => x.title), ['Beta', 'Loose']);
    assert.deepEqual(schedule(db, p.id, { tz: 'UTC', now: NOW }), schedule(db, p.id, { tz: 'UTC', now: NOW }), 'stable default seed');
  });

  it('sequential phases: a later phase queues behind the earlier unfinished ones on its board', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const p = getOrCreateProject(db, '/tmp/sched-seq', 'S');
    history(db, p.id, 14);
    const first = createPhase(db, p.id, 'first');
    const second = createPhase(db, p.id, 'second');
    const alone = getOrCreateProject(db, '/tmp/sched-seq-alone', 'A');
    history(db, alone.id, 14);
    const only = createPhase(db, alone.id, 'only');
    open(db, p.id, first.id, 6);
    open(db, p.id, second.id, 2);
    open(db, alone.id, only.id, 2);
    for (const ph of [first, second, only]) setPhaseTarget(db, ph.id, '2027-01-01');
    const by = Object.fromEntries(schedule(db, p.id, { tz: 'UTC', now: NOW, seed: 9 }).phases.map((x) => [x.title, x]));
    assert.deepEqual([by.first.queued, by.second.queued], [6, 8]);
    assert.equal(by.second.remaining, 2);
    const solo = schedule(db, alone.id, { tz: 'UTC', now: NOW, seed: 9 }).phases[0];
    assert.equal(solo.queued, 2);
    assert.ok(by.second.p85! > solo.p85!, 'the same 2 cards finish later behind 6 others');
    assert.ok(by.second.p50! >= by.first.p50!);
    // a done earlier phase no longer queues
    updatePhase(db, first.id, { status: 'done' });
    assert.equal(schedule(db, p.id, { tz: 'UTC', now: NOW, seed: 9 }).phases.find((x) => x.id === second.id)!.queued, 2);
  });

  it('forecasts from the phase’s own board; falls back to the workspace; same answer for every viewer', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-sched-ws-'));
    for (const sub of ['web', 'mobile']) mkdirSync(join(dir, sub));
    const db = openDb();
    t.after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const ws = getOrCreateProject(db, dir, 'Shop');
    const web = createVertical(db, ws.id, 'web', join(dir, 'web'));
    const mobile = createVertical(db, ws.id, 'mobile', join(dir, 'mobile'));
    history(db, web.id, 3); // too little on its own (< 5 done)
    history(db, ws.id, 20);
    const wsPhase = createPhase(db, ws.id, 'Platform');
    const webPhase = createPhase(db, web.id, 'Web v1');
    const mobPhase = createPhase(db, mobile.id, 'Mobile v1');
    open(db, ws.id, wsPhase.id, 4);
    open(db, web.id, webPhase.id, 4);
    open(db, mobile.id, mobPhase.id, 4);
    for (const ph of [wsPhase, webPhase, mobPhase]) setPhaseTarget(db, ph.id, '2027-01-01');
    history(db, mobile.id, 14);

    const fromWs = Object.fromEntries(schedule(db, ws.id, { tz: 'UTC', now: NOW }).phases.map((x) => [x.title, x]));
    assert.equal(fromWs.Platform.history, 'board');
    assert.equal(fromWs['Mobile v1'].history, 'board');
    assert.equal(fromWs['Web v1'].history, 'workspace');
    assert.match(fromWs['Web v1'].reason, /; forecast uses workspace history; web has too little$/);
    assert.doesNotMatch(fromWs['Mobile v1'].reason, /workspace history/);
    for (const v of [web, mobile]) {
      const own = schedule(db, v.id, { tz: 'UTC', now: NOW }).phases;
      assert.equal(own.length, 1, 'a vertical lists only its own phases');
      assert.deepEqual(own[0], fromWs[own[0].title], 'same phase, same answer from either board');
    }
  });

  it('caps the forecast phases: the rest are unknown ("too many phases")', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const p = getOrCreateProject(db, '/tmp/sched-cap', 'S');
    history(db, p.id, 14);
    const ids: string[] = [];
    for (let i = 0; i < MAX_FORECAST_PHASES + 2; i++) {
      const ph = createPhase(db, p.id, `p${i}`);
      open(db, p.id, ph.id, 1);
      setPhaseTarget(db, ph.id, '2030-01-01');
      ids.push(ph.id);
    }
    const v = schedule(db, p.id, { tz: 'UTC', now: NOW });
    const unknown = v.phases.filter((x) => x.status === 'unknown');
    assert.deepEqual(unknown.map((x) => [x.id, x.reason]), ids.slice(MAX_FORECAST_PHASES).map((id) => [id, 'too many phases']));
    assert.ok(v.phases.slice(0, MAX_FORECAST_PHASES).every((x) => x.p50 !== null));
  });
});
