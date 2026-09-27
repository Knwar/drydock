import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createPhase, createTask, getOrCreateProject, getPhases, isIsoDate, moveTask, setPhaseTarget, updatePhase } from './board.js';
import { openDb } from './db.js';
import { createMilestone } from './milestones.js';
import { schedule, scheduleStatus, type ScheduleInput } from './schedule.js';

const today = '2026-10-01';
const base: ScheduleInput = {
  target_date: '2026-10-10',
  phase_status: 'active',
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

describe('schedule()', () => {
  it('runs forecasts only for targeted, open phases; attaches milestones', (t) => {
    const db = openDb();
    t.after(() => db.close());
    const p = getOrCreateProject(db, '/tmp/sched-view', 'S');
    const DAY = 86_400_000;
    const now = Date.UTC(2026, 9, 1, 12);
    // 14 days of history, one card done per day
    for (let i = 0; i < 14; i++) {
      const c = createTask(db, p.id, `d${i}`);
      moveTask(db, c.id, 'done');
      const shift = now - (i + 1) * DAY;
      db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(shift - 1000, shift, c.id);
      db.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(shift, c.id);
    }
    const early = createPhase(db, p.id, 'early');
    const far = createPhase(db, p.id, 'far');
    const none = createPhase(db, p.id, 'none');
    const closed = createPhase(db, p.id, 'closed');
    for (const ph of [early, far, none]) for (let i = 0; i < 3; i++) createTask(db, p.id, 'x', { phase_id: ph.id });
    db.prepare('UPDATE tasks SET created_at = ? WHERE phase_id IS NOT NULL').run(now - DAY);
    setPhaseTarget(db, early.id, '2026-09-20'); // past, work left
    setPhaseTarget(db, far.id, '2027-01-01');
    setPhaseTarget(db, closed.id, '2026-09-01');
    updatePhase(db, closed.id, { status: 'done' });
    const m = createMilestone(db, { project_id: p.id, title: 'Beta', date: '2026-11-01', phase_id: far.id });
    createMilestone(db, { project_id: p.id, title: 'Loose', date: '2026-12-01' });

    const v = schedule(db, p.id, { tz: 'UTC', now, seed: 3 });
    assert.equal(v.today, '2026-10-01');
    const by = Object.fromEntries(v.phases.map((x) => [x.title, x]));
    assert.equal(by.early.status, 'late');
    assert.ok(by.early.p50, 'a targeted open phase is forecast');
    assert.equal(by.far.status, 'on_track');
    assert.deepEqual(by.far.milestones.map((x) => x.id), [m.id]);
    assert.equal(by.none.status, 'unknown');
    assert.equal(by.none.p50, null, 'no target → no forecast');
    assert.equal(by.none.remaining, 3);
    assert.equal(by.closed.status, 'done');
    assert.equal(by.closed.p50, null, 'done → no forecast');
    assert.deepEqual(v.milestones.map((x) => x.title), ['Beta', 'Loose']);
    assert.deepEqual(schedule(db, p.id, { tz: 'UTC', now }), schedule(db, p.id, { tz: 'UTC', now }), 'stable default seed');
  });
});
