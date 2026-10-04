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
/** An empty scope (boards p and q, phase ph1, members Ada a1 and Bob b1, $2/M input) plus row writers. */
function base() {
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
  /** A card created at t0 (backlog), with its create event. */
  const card = (id: string, lane: string, assigned: string | null, t0: number, rounds = 0) => {
    task.run(id, 'p', null, `Card ${id}`, lane, assigned, rounds, t0, t0);
    e(id, 'create', t0, { title: `Card ${id}` });
  };
  return { db, task, e, move, run, card };
}

function seed(): DB {
  const { db, task, e, move, run } = base();

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
    assert.equal(b.rounds, 0); // B's only review came under Bob
    assert.equal(b.first_pass, null); // Bob held it at its final review
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

  it('reassign events hand the card to payload.to, whoever the actor was', () => {
    const { db, e, move, run, card } = base();
    card('R', 'in_progress', 'Bob', MON);
    e('R', 'assign', MON + H, null, 'Ada');
    move('R', 'backlog', 'in_progress', MON + H);
    run('R', 'builder', 'builder', MON + 2 * H, M);
    e('R', 'reassign', MON + 3 * H, { from: 'Ada', to: 'Bob' }, null); // no actor
    run('R', 'builder', 'builder', MON + 4 * H, M);
    card('S', 'in_progress', 'Bob', MON);
    e('S', 'assign', MON + H, null, 'Ada');
    e('S', 'reassign', MON + 3 * H, { from: 'a1', to: 'b1' }, 'Ada'); // actor Ada, new holder Bob (by id)
    run('S', 'builder', 'builder', MON + 3 * H, M); // same ms as the reassign: the new holder
    card('T', 'in_progress', 'Bob', MON);
    e('T', 'assign', MON + H, null, 'Ada');
    e('T', 'reassign', MON + 2 * H, { from: 'Ada' }, 'Bob'); // no `to`: falls back to the event's agent
    run('T', 'builder', 'builder', MON + 3 * H, M);

    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    const bob = agentHistory(db, { projectIds: ['p'], agent: 'Bob', tz, now: NOW });
    assert.deepEqual(
      ada.runs.map((r) => [r.task_id, r.at]),
      [['R', MON + 2 * H]],
    );
    assert.deepEqual(
      bob.runs.map((r) => [r.task_id, r.at]).sort(),
      [
        ['R', MON + 4 * H],
        ['S', MON + 3 * H],
        ['T', MON + 3 * H],
      ],
    );
    for (const id of ['R', 'S', 'T']) assert.equal(ada.cards.find((c) => c.id === id)?.outcome, 'reassigned', id);
    assert.equal(ada.cards.find((c) => c.id === 'R')!.last_worked_at, MON + 3 * H);
    assert.equal(bob.cards.find((c) => c.id === 'S')!.first_worked_at, MON + 3 * H);
  });

  it('rounds and first pass are the agent\'s part of the card', () => {
    const { db, e, move, card } = base();
    card('F', 'done', 'Bob', MON, 2);
    e('F', 'assign', MON + H, null, 'Ada');
    move('F', 'backlog', 'in_progress', MON + H);
    move('F', 'in_progress', 'in_review', MON + 2 * H);
    e('F', 'review', MON + 3 * H, { verdict: 'fail', round: 1 });
    move('F', 'in_review', 'in_progress', MON + 3 * H);
    e('F', 'assign', MON + 4 * H, null, 'Bob');
    move('F', 'in_progress', 'in_review', MON + 5 * H);
    e('F', 'review', MON + 6 * H, { verdict: 'pass', round: 2 });
    move('F', 'in_review', 'done', MON + 7 * H);

    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    const f = ada.cards[0];
    assert.equal(f.rounds, 1);
    assert.equal(f.first_pass, null); // Bob held it at the final review
    assert.equal(f.outcome, 'reassigned');
    assert.equal(ada.totals.firstPassRate, null);
    const bob = agentHistory(db, { projectIds: ['p'], agent: 'Bob', tz, now: NOW });
    assert.equal(bob.cards[0].rounds, 1);
    assert.equal(bob.cards[0].first_pass, false); // the card's first review failed
    assert.equal(bob.totals.firstPassRate, 0);
    assert.equal(bob.totals.cardsDone, 1);
  });

  it('redirect ends the tenure; an unlabelled assign holds nobody', () => {
    const { db, e, move, run, card } = base();
    card('D', 'backlog', null, MON);
    e('D', 'assign', MON + H, null, 'Ada');
    move('D', 'backlog', 'in_progress', MON + H);
    run('D', 'builder', 'builder', MON + 2 * H, M);
    e('D', 'redirect', MON + 3 * H, { from: 'in_progress', note: null });
    run('D', 'builder', 'builder', MON + 4 * H, M); // nobody holds it: stays 'builder'
    card('N', 'in_progress', null, MON);
    e('N', 'assign', MON + H, null, null);
    run('N', 'builder', 'builder', MON + 2 * H, M);

    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    assert.deepEqual(
      ada.cards.map((c) => [c.id, c.outcome, c.last_worked_at]),
      [['D', 'redirected', MON + 3 * H]],
    );
    assert.deepEqual(
      ada.runs.map((r) => r.at),
      [MON + 2 * H],
    );
    // the unattributed runs stay with the raw label
    const builder = agentHistory(db, { projectIds: ['p'], agent: 'builder', tz, now: NOW });
    assert.deepEqual(
      builder.runs.map((r) => [r.task_id, r.at]),
      [
        ['D', MON + 4 * H],
        ['N', MON + 2 * H],
      ],
    );
  });

  it('runs on a deleted card count by label only', () => {
    const { db, run } = base();
    run('gone', 'Ada', 'builder', MON + H, M);
    run('gone', 'builder', 'builder', MON + 2 * H, M);
    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    assert.deepEqual(ada.cards, []);
    assert.deepEqual(
      ada.runs.map((r) => [r.task_id, r.at]),
      [['gone', MON + H]],
    );
    near(ada.totals.cost, 2);
  });

  it('buckets weeks in the given time zone across a DST change', () => {
    const { db, e, run, card } = base();
    const ny = 'America/New_York';
    // US DST starts Sun 2026-03-08; 2026-03-09T03:30Z is Sun 23:30 EDT, still the week of Mon 2026-03-02
    const t = Date.UTC(2026, 2, 9, 3, 30);
    card('Z', 'in_progress', 'Ada', Date.UTC(2026, 2, 2, 12));
    e('Z', 'assign', Date.UTC(2026, 2, 2, 12), null, 'Ada');
    run('Z', 'Ada', 'builder', t, M);
    const now = Date.UTC(2026, 2, 12);
    const from = Date.UTC(2026, 2, 2, 5); // 00:00 EST
    const local = agentHistory(db, { projectIds: ['p'], agent: 'Ada', from, tz: ny, now });
    assert.deepEqual(
      local.weekly.map((w) => [w.week, w.tokens]),
      [
        ['2026-03-02', M],
        ['2026-03-09', 0],
      ],
    );
    const utc = agentHistory(db, { projectIds: ['p'], agent: 'Ada', from, tz, now });
    assert.deepEqual(
      utc.weekly.map((w) => [w.week, w.tokens]),
      [
        ['2026-03-02', 0],
        ['2026-03-09', M],
      ],
    );
  });

  it('clamps worked times and blocked time to the window; counts blockers the agent raised', () => {
    const { db, e, move, card } = base();
    const W24 = MON + 7 * DAY;
    card('K', 'in_progress', 'Ada', MON);
    e('K', 'assign', MON + H, null, 'Ada');
    move('K', 'backlog', 'in_progress', MON + H);
    e('K', 'block', W24 - 2 * H, { reason: 'q' }, 'builder');
    e('K', 'unblock', W24 + 3 * H, { note: 'a' });
    e('K', 'note', W24 + 5 * H, null, 'Ada');
    // Ada raises a blocker on Bob's card, with no runs and no tenure of her own
    card('L', 'in_progress', 'Bob', MON);
    e('L', 'assign', MON + H, null, 'Bob');
    e('L', 'block', W24 + H, { reason: 'q' }, 'Ada');
    e('L', 'unblock', W24 + 2 * H, { note: 'a' });

    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', from: W24, to: W24 + DAY, tz, now: NOW });
    const k = ada.cards.find((c) => c.id === 'K')!;
    assert.equal(k.first_worked_at, W24); // clamped from MON+1h
    assert.equal(k.last_worked_at, W24 + DAY); // still held: the open tenure runs to min(now, to)
    assert.equal(k.blockers, 1);
    assert.equal(k.blocked_ms, 3 * H); // 5h blocked, 3h of it inside the window
    const l = ada.cards.find((c) => c.id === 'L')!;
    assert.equal(l.blockers, 1);
    assert.equal(l.blocked_ms, H);
    assert.equal(ada.totals.blockers, 2);
    const bob = agentHistory(db, { projectIds: ['p'], agent: 'Bob', from: W24, to: W24 + DAY, tz, now: NOW });
    assert.equal(bob.totals.blockers, 0);
  });

  it('assign and reassign at the same ms hand over once, in either order', () => {
    for (const order of ['assign first', 'reassign first'] as const) {
      const { db, e, run, card } = base();
      const T = MON + 3 * H;
      card('G', 'in_progress', 'Bob', MON);
      e('G', 'assign', MON + H, null, 'Ada');
      run('G', 'builder', 'builder', MON + 2 * H, M);
      const assign = () => e('G', 'assign', T, null, 'Bob');
      const reassign = () => e('G', 'reassign', T, { from: 'Ada', to: 'Bob' }, null);
      if (order === 'assign first') {
        assign();
        reassign();
      } else {
        reassign();
        assign();
      }
      run('G', 'builder', 'builder', T, M);

      const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
      const bob = agentHistory(db, { projectIds: ['p'], agent: 'Bob', tz, now: NOW });
      const a = ada.cards[0];
      assert.deepEqual([a.id, a.outcome, a.first_worked_at, a.last_worked_at], ['G', 'reassigned', MON + H, T], order);
      assert.deepEqual(
        ada.runs.map((r) => r.at),
        [MON + 2 * H],
        order,
      );
      const b = bob.cards[0];
      // Bob keeps it: one tenure from T, still open (runs to now)
      assert.deepEqual([b.id, b.outcome, b.first_worked_at, b.last_worked_at], ['G', 'in_progress', T, NOW], order);
      assert.deepEqual(
        bob.runs.map((r) => r.at),
        [T],
        order,
      );
    }
  });

  it('a reassign to an old (renamed) name falls back to the event agent', () => {
    const { db, e, run, card } = base();
    card('O', 'in_progress', 'Bob', MON);
    e('O', 'assign', MON + H, null, 'Ada');
    e('O', 'reassign', MON + 2 * H, { from: 'Ada', to: 'Robert' }, 'Bob'); // Bob was 'Robert' before a rename
    run('O', 'builder', 'builder', MON + 3 * H, M);
    const bob = agentHistory(db, { projectIds: ['p'], agent: 'Bob', tz, now: NOW });
    assert.deepEqual(
      bob.cards.map((c) => [c.id, c.first_worked_at]),
      [['O', MON + 2 * H]],
    );
    assert.equal(bob.runs.length, 1);
    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    assert.equal(ada.cards[0].outcome, 'reassigned');
    assert.deepEqual(ada.runs, []);
  });

  it('a card held through the window gets first/last worked from the window', () => {
    const { db, e, card } = base();
    card('H', 'in_progress', 'Ada', MON);
    e('H', 'assign', MON + H, null, 'Ada');
    const from = MON + 7 * DAY;
    const to = MON + 8 * DAY;
    const ada = agentHistory(db, { projectIds: ['p'], agent: 'Ada', from, to, tz, now: NOW });
    assert.deepEqual(
      ada.cards.map((c) => [c.id, c.first_worked_at, c.last_worked_at]),
      [['H', from, to]],
    );
    const open = agentHistory(db, { projectIds: ['p'], agent: 'Ada', tz, now: NOW });
    assert.deepEqual([open.cards[0].first_worked_at, open.cards[0].last_worked_at], [MON + H, NOW]);
  });
});
