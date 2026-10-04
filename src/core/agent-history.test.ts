import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentHistory } from './agent-history.js';
import { setPrices } from './cost.js';
import { openDb, type DB } from './db.js';

const H = 3_600_000;
const DAY = 24 * H;
// 2026-06-01 is a Monday (ISO 2026-W23)
const MON = Date.UTC(2026, 5, 1);
const NOW = MON + 20 * DAY; // Sunday of W25
const tz = 'UTC';
const M = 1_000_000;

/**
 * Seeded board (project p, phase ph1) with two members, Ada (a1) and Bob (b1):
 *  A: Ada; fail then pass review; one run credited by name, one by the 'builder' label; done W23.
 *  B: assigned by member id a1 (Ada), a 'builder' run + blocker (2h), reassigned to Bob in W24, Bob's run, pass, done.
 *  C: assigned_agent Bob, no assign events (legacy); a run with no agent label; in progress in W25.
 *  X: on another board (out of scope), Ada's run.
 */
function seed(): DB {
  const db = openDb();
  setPrices(
    db,
    { models: { m: { input: 2, output: 0, cache_read: 0, cache_creation: 0 } }, default: { input: 0, output: 0, cache_read: 0, cache_creation: 0 } },
    1,
  );
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at) VALUES ('p', 'Web', '/w', 0), ('q', 'Other', '/o', 0)`).run();
  db.prepare(`INSERT INTO phases (id, project_id, title, created_at, updated_at) VALUES ('ph1', 'p', 'Phase 1', 0, 0)`).run();
  db.prepare(`INSERT INTO team_members (id, name, created_at) VALUES ('a1', 'Ada', 0), ('b1', 'Bob', 0)`).run();
  const task = db.prepare(
    `INSERT INTO tasks (id, project_id, phase_id, title, lane, assigned_agent, review_rounds, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ev = db.prepare(`INSERT INTO task_events (project_id, task_id, type, payload, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const e = (task: string, type: string, at: number, payload: object | null = null, agent: string | null = null, project = 'p') =>
    ev.run(project, task, type, payload ? JSON.stringify(payload) : null, agent, at);
  const move = (t: string, from: string, to: string, at: number) => e(t, 'move', at, { from, to });
  const run = (
    t: string,
    agent: string | null,
    role: string | null,
    at: number,
    input: number,
    lines: [number, number] = [0, 0],
    project = 'p',
  ) =>
    db
      .prepare(
        `INSERT INTO card_activity (project_id, task_id, agent, role, tokens, lines_added, lines_removed, ms, usage, cost_estimated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(project, t, agent, role, input, lines[0], lines[1], H, JSON.stringify({ m: { input, output: 0, cache_read: 0, cache_creation: 0 } }), at);

  // A
  task.run('A', 'p', 'ph1', 'Card A', 'done', 'Ada', 2, MON, MON + 7 * H);
  e('A', 'create', MON, { title: 'Card A' });
  e('A', 'assign', MON + H, { worktree: '.trees/A' }, 'Ada');
  move('A', 'backlog', 'in_progress', MON + H);
  run('A', 'Ada', 'builder', MON + 2 * H, M);
  move('A', 'in_progress', 'in_review', MON + 3 * H);
  e('A', 'review', MON + 4 * H, { verdict: 'fail', round: 1 });
  move('A', 'in_review', 'in_progress', MON + 4 * H);
  run('A', 'builder', 'builder', MON + 5 * H, 2 * M, [10, 2]);
  move('A', 'in_progress', 'in_review', MON + 5 * H);
  e('A', 'review', MON + 6 * H, { verdict: 'pass', round: 2 });
  move('A', 'in_review', 'done', MON + 7 * H);

  // B
  const W24 = MON + 7 * DAY;
  task.run('B', 'p', null, 'Card B', 'done', 'Bob', 1, MON, W24 + DAY + 3 * H);
  e('B', 'create', MON, { title: 'Card B' });
  e('B', 'assign', MON + H, { worktree: '.trees/B' }, 'a1');
  move('B', 'backlog', 'in_progress', MON + H);
  run('B', 'builder', 'builder', MON + 2 * H, M);
  e('B', 'block', MON + 3 * H, { reason: 'which db?' }, 'builder');
  e('B', 'unblock', MON + 5 * H, { note: 'sqlite' });
  e('B', 'assign', W24 + DAY, { worktree: '.trees/B' }, 'Bob');
  run('B', 'Bob', 'builder', W24 + DAY + H, 3 * M, [5, 1]);
  move('B', 'in_progress', 'in_review', W24 + DAY + H);
  e('B', 'review', W24 + DAY + 2 * H, { verdict: 'pass', round: 1 });
  move('B', 'in_review', 'done', W24 + DAY + 3 * H);

  // C (legacy: no assign events)
  const W25 = MON + 14 * DAY;
  task.run('C', 'p', null, 'Card C', 'in_progress', 'Bob', 0, W25, W25 + H);
  e('C', 'create', W25, { title: 'Card C' });
  move('C', 'backlog', 'in_progress', W25 + H);
  run('C', null, 'builder', W25 + 2 * H, M);

  // X: another board
  task.run('X', 'q', null, 'Card X', 'in_progress', 'Ada', 0, MON, MON);
  e('X', 'assign', MON, null, 'Ada', 'q');
  run('X', 'Ada', 'builder', MON + H, 5 * M, [0, 0], 'q');
  return db;
}

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe('agentHistory', () => {
  it('attributes cards and runs through reassignment and subagent labels', () => {
    const db = seed();
    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    assert.equal(ada.agent, 'Ada');
    assert.deepEqual(
      ada.cards.map((c) => c.id),
      ['B', 'A'], // newest first: B's tenure ends at the W24 reassign
    );
    // A's 'builder' run maps to Ada (the holder); B's 'builder' run before the reassign too; Bob's and X's don't
    assert.deepEqual(
      ada.runs.map((r) => [r.task_id, r.at]),
      [
        ['A', MON + 5 * H],
        ['A', MON + 2 * H],
        ['B', MON + 2 * H],
      ],
    );
    assert.equal(ada.runs[0].role, 'builder');
    assert.equal(ada.runs[0].ms, H);
    near(ada.runs[0].cost, 4); // 2M input at $2/M

    const bob = agentHistory(db, { projectIds: ['p'], agent: 'b1', tz, now: NOW }); // member id accepted
    assert.equal(bob.agent, 'Bob');
    assert.deepEqual(
      bob.cards.map((c) => c.id),
      ['C', 'B'],
    );
    assert.deepEqual(
      bob.runs.map((r) => r.task_id),
      ['C', 'B'],
    );
  });

  it('fills per-card fields', () => {
    const db = seed();
    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    const a = ada.cards.find((c) => c.id === 'A')!;
    assert.equal(a.title, 'Card A');
    assert.deepEqual(a.board, { id: 'p', name: 'Web' });
    assert.deepEqual(a.phase, { id: 'ph1', title: 'Phase 1' });
    assert.equal(a.lane, 'done');
    assert.equal(a.outcome, 'done');
    assert.equal(a.done_at, MON + 7 * H);
    assert.equal(a.first_worked_at, MON + H);
    assert.equal(a.started_at, MON + H);
    assert.equal(a.last_worked_at, MON + 7 * H);
    assert.equal(a.rounds, 2);
    assert.equal(a.first_pass, false);
    assert.equal(a.blockers, 0);
    near(a.cost, 6);
    assert.equal(a.tokens, 3 * M);
    assert.equal(a.lines_added, 10);
    assert.equal(a.lines_removed, 2);

    const b = ada.cards.find((c) => c.id === 'B')!;
    assert.equal(b.outcome, 'reassigned');
    assert.equal(b.lane, 'done');
    assert.equal(b.last_worked_at, MON + 8 * DAY);
    assert.equal(b.blockers, 1); // raised by the 'builder' label while Ada held it
    assert.equal(b.blocked_ms, 2 * H);
    near(b.cost, 2);
    assert.equal(b.lines_added, 0); // Bob's run carries B's lines

    const bob = agentHistory(db, { projectIds: ['p'], agent: 'Bob', tz, now: NOW });
    const bb = bob.cards.find((c) => c.id === 'B')!;
    assert.equal(bb.outcome, 'done');
    assert.equal(bb.first_pass, true);
    assert.equal(bb.rounds, 1);
    assert.equal(bb.blockers, 0);
    assert.equal(bb.first_worked_at, MON + 8 * DAY);
    assert.equal(bb.lines_added, 5);
    const c = bob.cards.find((x) => x.id === 'C')!;
    assert.equal(c.outcome, 'in_progress');
    assert.equal(c.done_at, null);
    assert.equal(c.first_pass, null);
    assert.equal(c.first_worked_at, MON + 14 * DAY);
  });

  it('computes totals and the weekly series', () => {
    const db = seed();
    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    assert.equal(ada.totals.cardsDone, 1); // B finished under Bob
    assert.equal(ada.totals.firstPassRate, 0); // A failed round 1; B's review was Bob's
    assert.equal(ada.totals.medianCycleMs, 6 * H); // A: in_progress MON+1h -> done MON+7h
    near(ada.totals.cost, 8);
    assert.equal(ada.totals.tokens, 4 * M);
    assert.equal(ada.totals.blockers, 1);
    assert.equal(ada.totals.hours, 3);
    assert.deepEqual(
      ada.weekly.map((w) => w.week),
      ['2026-06-01', '2026-06-08', '2026-06-15'],
    );
    assert.equal(ada.weekly[0].cardsDone, 1);
    assert.equal(ada.weekly[0].hours, 3);
    assert.equal(ada.weekly[0].blockers, 1);
    assert.equal(ada.weekly[1].cardsDone, 0);
    assert.equal(ada.weekly[1].cost, 0);
    assert.equal(ada.weekly[1].firstPassRate, null);

    const bob = agentHistory(db, { projectIds: ['p'], agent: 'Bob', tz, now: NOW });
    assert.equal(bob.totals.cardsDone, 1);
    assert.equal(bob.totals.firstPassRate, 1);
    near(bob.totals.cost, 8); // B 3M + C 1M
    assert.equal(bob.totals.hours, 2);
    assert.deepEqual(
      bob.weekly.map((w) => [w.week, w.cardsDone, w.tokens]),
      [
        ['2026-06-08', 1, 3 * M],
        ['2026-06-15', 0, M],
      ],
    );
  });

  it('filters by the window', () => {
    const db = seed();
    const from = MON + 7 * DAY;
    const to = MON + 14 * DAY - 1;
    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', from, to, tz, now: NOW });
    assert.deepEqual(
      ada.cards.map((c) => c.id),
      ['B'], // held until the W24 reassign; A was done in W23
    );
    assert.deepEqual(ada.runs, []);
    assert.equal(ada.cards[0].cost, 0);
    assert.equal(ada.cards[0].blockers, 0); // raised in W23
    assert.deepEqual(ada.totals, { cardsDone: 0, firstPassRate: null, medianCycleMs: null, cost: 0, tokens: 0, blockers: 0, hours: 0 });
    assert.deepEqual(
      ada.weekly.map((w) => w.week),
      ['2026-06-08'],
    );

    const bob = agentHistory(db, { projectIds: ['p'], agent: 'Bob', from, to, tz, now: NOW });
    assert.deepEqual(
      bob.cards.map((c) => c.id),
      ['B'], // C starts in W25
    );
    assert.equal(bob.totals.cardsDone, 1);
    assert.equal(bob.totals.firstPassRate, 1);
    assert.equal(bob.runs.length, 1);
  });

  it('scopes to the given boards', () => {
    const db = seed();
    const ada = agentHistory(db, { projectIds: ['q'], agent: 'Ada', tz, now: NOW });
    assert.deepEqual(
      ada.cards.map((c) => c.id),
      ['X'],
    );
    near(ada.totals.cost, 10);
  });
});
