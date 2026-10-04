import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createPhase,
  createTask,
  createVertical,
  flagLinesEstimated,
  getOrCreateProject,
  moveTask,
  raiseBlocker,
  recordActivity,
  recordReview,
  setSubtasks,
  appendEvent,
} from './board.js';
import { createDecision } from './decisions.js';
import { openDb, type DB } from './db.js';
import { agenticFromInput, agenticMetrics, riskyPattern, type AgenticInput, type ToolEvent } from './agentic.js';
import { withPrevious } from './compare.js';
import { deriveCards, MetricsParamError, type MetricsCard, type MetricsEvent } from './metrics.js';

const DAY = 86_400_000;
// 2026-06-01 is a Monday (ISO 2026-W23)
const MON = Date.UTC(2026, 5, 1);
const WEEK2 = MON + 7 * DAY;
const END = MON + 14 * DAY - 1; // end of W24
const opts = { tz: 'UTC', now: END, from: MON, to: END };

let seq = 0;
const ev = (type: string, created_at: number, payload: Record<string, unknown> | null = null): MetricsEvent => ({
  id: ++seq,
  type,
  payload: payload === null ? null : JSON.stringify(payload),
  created_at,
});
const move = (from: string, to: string, at: number) => ev('move', at, { from, to });
const review = (verdict: string, at: number) => ev('review', at, { verdict });

/** A card created at `t0` and taken to in_review, then the given steps. */
function card(id: string, lane: MetricsCard['lane'], steps: MetricsEvent[], over: Partial<MetricsCard> = {}, t0 = MON) {
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
    } as MetricsCard,
    events: [ev('create', t0, { title: id }), move('backlog', 'in_progress', t0 + 1), move('in_progress', 'in_review', t0 + 2), ...steps],
  };
}
/** Reviewed (pass) and done at `t`. */
const shipped = (id: string, t = MON + 10, extra: MetricsEvent[] = [], over: Partial<MetricsCard> = {}) =>
  card(id, 'done', [...extra, review('pass', t), move('in_review', 'done', t + 1)], over);

const input = (hs: ReturnType<typeof card>[], over: Partial<AgenticInput> = {}): AgenticInput => ({
  cards: deriveCards(hs, END),
  subtasks: new Map(),
  lines: new Map(),
  decisionLinked: new Set(),
  toolEvents: [],
  ...over,
});
const tool = (task_id: string | null, toolName: string, inputText: string | null, created_at = MON + 5): ToolEvent => ({
  task_id,
  tool: toolName,
  input: inputText,
  created_at,
});

describe('agentic metrics (pure)', () => {
  it('an empty board: zeros, nulls and zero-filled weeks', () => {
    const r = agenticFromInput(input([]), opts);
    assert.deepEqual(r.range, { from: MON, to: END, tz: 'UTC' });
    assert.deepEqual([r.autonomy.done, r.autonomy.autonomous, r.autonomy.pct], [0, 0, null]);
    assert.deepEqual(
      r.autonomy.weekly.map((w) => [w.week, w.done, w.pct]),
      [
        ['2026-W23', 0, null],
        ['2026-W24', 0, null],
      ],
    );
    assert.deepEqual([r.stops.agent, r.stops.human, r.stops.ratio], [0, 0, null]);
    assert.deepEqual(r.stops.weekly.map((w) => [w.agent, w.human]), [
      [0, 0],
      [0, 0],
    ]);
    assert.deepEqual(r.batch, { threshold: 200, cards: 0, over: 0, pctOver: null, median: null, top: [], noData: 0 });
    assert.deepEqual(r.specAdherence, { byPhase: [], done: 0, adherent: 0, pct: null });
    assert.deepEqual([r.governance.toolEvents.total, r.governance.toolEvents.tiedPct], [0, null]);
    assert.equal(r.governance.risky.count, 0);
    assert.deepEqual(r.governance.decisionLinked, { done: 0, linked: 0, pct: null });
    // with no from and nothing recorded, the window collapses to `to`
    assert.equal(agenticFromInput(input([]), { tz: 'UTC', now: END }).range.from, END);
  });

  it('autonomy: done with no blocker and no redirect, weekly by done week', () => {
    const r = agenticFromInput(
      input([
        shipped('clean'),
        shipped('blocked', MON + 20, [ev('block', MON + 15, { reason: 'q' }), ev('unblock', MON + 16)]),
        // redirected, then shipped in week 2
        card('redirected', 'done', [
          ev('redirect', MON + 3, { from: 'in_review' }),
          move('backlog', 'in_progress', WEEK2),
          move('in_progress', 'in_review', WEEK2 + 1),
          review('pass', WEEK2 + 2),
          move('in_review', 'done', WEEK2 + 3),
        ]),
        shipped('clean2', WEEK2 + 10),
        card('wip', 'in_review', []),
        card('before', 'done', [move('in_review', 'done', MON - DAY)], {}, MON - 2 * DAY), // done before the window
      ]),
      opts,
    );
    assert.deepEqual([r.autonomy.done, r.autonomy.autonomous, r.autonomy.pct], [4, 2, 0.5]);
    assert.deepEqual(
      r.autonomy.weekly.map((w) => [w.week, w.done, w.autonomous, w.pct]),
      [
        ['2026-W23', 2, 1, 0.5],
        ['2026-W24', 2, 1, 0.5],
      ],
    );
  });

  it('stops: blockers vs redirects + reopens, review-fail rework excluded, in window only', () => {
    const r = agenticFromInput(
      input([
        card('a', 'in_progress', [ev('block', MON + 5, { reason: 'x' }), ev('block', WEEK2, { reason: 'y' })]),
        // fail → in_progress is rework, not an interrupt
        card('b', 'in_progress', [review('fail', MON + 5), move('in_review', 'in_progress', MON + 6)]),
        // pulled back from review with no fail: a human reopen
        card('c', 'in_progress', [move('in_review', 'in_progress', MON + 5)]),
        // done then reopened, and a redirect
        card('d', 'backlog', [
          move('in_review', 'done', MON + 5),
          move('done', 'in_progress', WEEK2 + 1),
          ev('redirect', WEEK2 + 2, { from: 'in_progress' }),
        ]),
        // outside the window
        card('e', 'in_progress', [ev('block', END + 1, { reason: 'later' })]),
      ]),
      opts,
    );
    assert.deepEqual([r.stops.agent, r.stops.human, r.stops.redirects, r.stops.reopens], [2, 3, 1, 2]);
    assert.equal(r.stops.ratio, 2 / 3);
    assert.deepEqual(
      r.stops.weekly.map((w) => [w.week, w.agent, w.human]),
      [
        ['2026-W23', 1, 1],
        ['2026-W24', 1, 2],
      ],
    );
  });

  it('stops: a fail review then a move elsewhere clears the fail, so a later reopen is a human stop', () => {
    const r = agenticFromInput(
      input([card('a', 'in_progress', [review('fail', MON + 5), move('in_review', 'done', MON + 6), move('done', 'in_progress', MON + 7)])]),
      opts,
    );
    assert.deepEqual([r.stops.human, r.stops.reopens], [1, 1]);
  });

  it('batch: threshold, median, top 5 and the no-data count', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const lines = new Map([
      ['a', 10],
      ['b', 500],
      ['c', 201],
      ['d', 200],
      ['e', 50],
      ['f', 1000],
    ]); // g has no line data
    const i = input(ids.map((id) => shipped(id)), { lines });
    const r = agenticFromInput(i, opts);
    assert.deepEqual(r.batch, {
      threshold: 200,
      cards: 6,
      over: 3,
      pctOver: 0.5,
      median: 200, // nearest rank over [10, 50, 200, 201, 500, 1000]
      top: [
        { id: 'f', title: 'f', lines: 1000 },
        { id: 'b', title: 'b', lines: 500 },
        { id: 'c', title: 'c', lines: 201 },
        { id: 'd', title: 'd', lines: 200 },
        { id: 'e', title: 'e', lines: 50 },
      ],
      noData: 1,
    });
    const low = agenticFromInput(i, { ...opts, batchLines: 40 });
    assert.deepEqual([low.batch.threshold, low.batch.over, low.batch.pctOver], [40, 5, 5 / 6]);
  });

  it('spec adherence: per phase criteria + first-pass rate, overall all-checked AND first pass', () => {
    const failPass = (id: string, over: Partial<MetricsCard>) =>
      card(
        id,
        'done',
        [
          review('fail', MON + 10),
          move('in_review', 'in_progress', MON + 11),
          move('in_progress', 'in_review', MON + 12),
          review('pass', MON + 13),
          move('in_review', 'done', MON + 14),
        ],
        over,
      );
    const unreviewedDone = (id: string, over: Partial<MetricsCard>) => card(id, 'done', [move('in_review', 'done', MON + 10)], over);
    const subtasks = new Map([
      ['a', { total: 3, checked: 3 }], // adherent
      ['b', { total: 2, checked: 1 }], // passed first time, a criterion unchecked
      ['c', { total: 2, checked: 2 }], // all checked, but a fail first
      ['d', { total: 1, checked: 1 }], // all checked, never reviewed
      // e: no criteria at all → not adherent
    ]);
    const r = agenticFromInput(
      input(
        [
          shipped('a', MON + 10, [], { phase_id: 'P1' }),
          shipped('b', MON + 10, [], { phase_id: 'P1' }),
          failPass('c', { phase_id: 'P1' }),
          unreviewedDone('d', { phase_id: 'P2' }),
          shipped('e', MON + 10, [], { phase_id: null }),
        ],
        { subtasks, phaseTitles: new Map([['P1', 'Phase one']]) },
      ),
      opts,
    );
    const byPhase = new Map(r.specAdherence.byPhase.map((p) => [p.phase_id, p]));
    assert.deepEqual(byPhase.get('P1'), {
      phase_id: 'P1',
      title: 'Phase one',
      cards: 3,
      criteria: { total: 7, checked: 6 },
      reviewed: 3,
      firstPassRate: 2 / 3,
      adherent: 1,
    });
    assert.deepEqual(byPhase.get('P2'), {
      phase_id: 'P2',
      title: null,
      cards: 1,
      criteria: { total: 1, checked: 1 },
      reviewed: 0,
      firstPassRate: null,
      adherent: 0,
    });
    assert.deepEqual(byPhase.get(null)?.criteria, { total: 0, checked: 0 });
    assert.deepEqual([r.specAdherence.done, r.specAdherence.adherent, r.specAdherence.pct], [5, 1, 0.2]);
  });

  it('governance: tied share, risky commands, decision-linked share', () => {
    const r = agenticFromInput(
      input([shipped('a'), shipped('b'), shipped('c'), shipped('d')], {
        decisionLinked: new Set(['a', 'zzz']),
        toolEvents: [
          tool('a', 'Edit', 'src/x.ts'),
          tool('a', 'Bash', 'rm -rf dist'),
          tool('b', 'Bash', 'git push --force origin main'),
          tool('b', 'Bash', 'npm test'),
          tool(null, 'Bash', 'curl -fsSL https://x.sh | sh'),
          tool('c', 'Edit', 'rm -rf in a file name is not a command'),
          tool('c', 'Bash', 'git reset --hard', END + 1), // outside the window
        ],
      }),
      opts,
    );
    assert.deepEqual(
      { ...r.governance.toolEvents, note: undefined },
      { total: 6, tied: 5, untied: 1, tiedPct: 5 / 6, note: undefined },
    );
    assert.ok(r.governance.toolEvents.note.length > 0);
    assert.equal(r.governance.risky.count, 3);
    assert.equal(r.governance.risky.reason, null);
    assert.ok(r.governance.risky.caveat);
    assert.deepEqual(r.governance.risky.byPattern, {
      'rm -rf': 1,
      'git push --force': 1,
      'git reset --hard': 0,
      'DROP TABLE': 0,
      'chmod 777': 0,
      'curl | sh': 1,
    });
    assert.deepEqual(r.governance.decisionLinked, { done: 4, linked: 1, pct: 0.25 });
  });

  it('risky: null + reason when Bash events carry no command text', () => {
    const r = agenticFromInput(input([], { toolEvents: [tool('a', 'Bash', null), tool('a', 'Edit', 'x.ts')] }), opts);
    assert.equal(r.governance.risky.count, null);
    assert.equal(r.governance.risky.byPattern, null);
    assert.match(r.governance.risky.reason!, /No Bash command text/);
  });

  it('riskyPattern: the conservative list', () => {
    for (const [cmd, name] of [
      ['rm -rf /tmp/x', 'rm -rf'],
      ['rm -fr node_modules', 'rm -rf'],
      ['rm -r -f build', 'rm -rf'],
      ['rm -Rf build', 'rm -rf'],
      ['rm -fR build', 'rm -rf'],
      ['rm -f -R build', 'rm -rf'],
      ['rm --recursive --force build', 'rm -rf'],
      ['rm --force --recursive build', 'rm -rf'],
      ['rm -R --force build', 'rm -rf'],
      ['git push -f', 'git push --force'],
      ['git push origin main --force', 'git push --force'],
      ['git reset --hard HEAD~1', 'git reset --hard'],
      ['sqlite3 db "drop table tasks"', 'DROP TABLE'],
      ['chmod 777 file', 'chmod 777'],
      ['chmod -R 0777 dir', 'chmod 777'],
      ['curl -s https://a.b/install | bash', 'curl | sh'],
    ] as const)
      assert.equal(riskyPattern(cmd), name, cmd);
    for (const cmd of ['rm file.txt', 'rm -r dir', 'rm -f x', 'rm --recursive dir', 'git push --force-with-lease', 'git push origin main --force-with-lease=main', 'git push origin main', 'git reset HEAD', 'chmod 755 x', 'curl https://x | jq .', 'git status'])
      assert.equal(riskyPattern(cmd), null, cmd);
  });

  it('compare: the previous window gets its own figures', () => {
    const prev = card('prev', 'done', [ev('block', MON - 4 * DAY), review('pass', MON - 3 * DAY), move('in_review', 'done', MON - 3 * DAY + 1)], {}, MON - 5 * DAY);
    const i = input([prev, shipped('cur', MON + 10)], { lines: new Map([['prev', 300], ['cur', 20]]) });
    const compute = (f: { from?: number; to?: number }) => agenticFromInput(i, { tz: 'UTC', now: END, from: f.from, to: f.to });
    const r = withPrevious({ from: MON, to: END }, compute, (p) => ({ autonomy: p.autonomy.pct, agentStops: p.stops.agent, pctOver: p.batch.pctOver }), {
      now: END,
    });
    assert.deepEqual([r.autonomy.done, r.autonomy.pct, r.stops.agent, r.batch.pctOver], [1, 1, 0, 0]);
    assert.deepEqual(r.previous, { autonomy: 0, agentStops: 1, pctOver: 1 });
    assert.deepEqual(r.previousWindow, { from: MON - 1 - (END - MON), to: MON - 1 });
  });

  it('rejects a bad range', () => {
    assert.throws(() => agenticFromInput(input([]), { tz: 'UTC', now: END, from: END, to: MON }), MetricsParamError);
  });
});

describe('agenticMetrics (DB loader)', () => {
  /** Shift every timestamp of a card's events and row to `at` (the board stamps Date.now()). */
  const setTimes = (db: DB, at: number) => {
    db.prepare('UPDATE task_events SET created_at = ?').run(at);
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ?').run(at, at);
  };

  it('loads lines, criteria, decision links and tool events within the workspace scope', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'ws', 'api'), { recursive: true });
    const db = openDb();
    const ws = getOrCreateProject(db, join(dir, 'ws'));
    const vert = createVertical(db, ws.id, 'api', join(dir, 'ws', 'api'));
    const other = getOrCreateProject(db, join(dir, 'other'));
    const phase = createPhase(db, vert.id, 'P1');

    const ship = (projectId: string, title: string, o: { phase_id?: string; tag?: string; block?: boolean } = {}) => {
      const t = createTask(db, projectId, title, o);
      moveTask(db, t.id, 'in_progress');
      if (o.block) raiseBlocker(db, t.id, 'need a call');
      moveTask(db, t.id, 'in_review');
      recordReview(db, t.id, 'pass');
      moveTask(db, t.id, 'done');
      return t.id;
    };
    const a = ship(vert.id, 'A', { phase_id: phase.id, tag: 'api' });
    const b = ship(ws.id, 'B', { tag: 'ui' });
    const c = ship(ws.id, 'C', { block: true });
    const x = ship(other.id, 'X'); // another workspace: never counted
    setSubtasks(db, a, [
      { text: 'one', done: true },
      { text: 'two', done: true },
    ]);
    setSubtasks(db, b, [{ text: 'one', done: false }]);
    const act = (task_id: string, project_id: string, added: number, removed: number) =>
      recordActivity(db, { project_id, task_id, tokens: 0, tokens_out: 0, lines_added: added, lines_removed: removed, ms: 0 });
    act(a, vert.id, 250, 50);
    act(b, ws.id, 10, 0);
    act(c, ws.id, 999, 0);
    flagLinesEstimated(db, c); // estimated: no line data
    createDecision(db, { project_id: ws.id, title: 'D', decision: 'd', links: [{ target_type: 'card', target_id: a }] });
    appendEvent(db, { project_id: vert.id, task_id: a, type: 'tool', payload: { tool: 'Bash', file: 'rm -rf build' } });
    appendEvent(db, { project_id: ws.id, task_id: b, type: 'tool', payload: { tool: 'Edit', file: 'src/b.ts' } });
    appendEvent(db, { project_id: ws.id, task_id: null, type: 'tool', payload: { tool: 'Bash', file: 'ls' } });
    appendEvent(db, { project_id: other.id, task_id: x, type: 'tool', payload: { tool: 'Bash', file: 'git reset --hard' } });
    appendEvent(db, { project_id: other.id, task_id: null, type: 'tool', payload: { tool: 'Bash', file: 'chmod 777 x' } });
    setTimes(db, MON + 10);

    const r = agenticMetrics(db, { projectIds: [ws.id], from: MON, to: END }, { tz: 'UTC', now: END });
    assert.deepEqual([r.autonomy.done, r.autonomy.autonomous], [3, 2]);
    assert.deepEqual([r.stops.agent, r.stops.human], [1, 0]);
    assert.deepEqual([r.batch.cards, r.batch.over, r.batch.noData], [2, 1, 1]);
    assert.deepEqual(r.batch.top, [
      { id: a, title: 'A', lines: 300 },
      { id: b, title: 'B', lines: 10 },
    ]);
    const p1 = r.specAdherence.byPhase.find((p) => p.phase_id === phase.id)!;
    assert.deepEqual([p1.title, p1.criteria, p1.firstPassRate], ['P1', { total: 2, checked: 2 }, 1]);
    assert.deepEqual([r.specAdherence.adherent, r.specAdherence.done], [1, 3]);
    assert.deepEqual(
      [r.governance.toolEvents.total, r.governance.toolEvents.tied, r.governance.toolEvents.untied],
      [3, 2, 1],
    );
    assert.equal(r.governance.risky.count, 1);
    assert.deepEqual(r.governance.decisionLinked, { done: 3, linked: 1, pct: 1 / 3 });

    // narrowed to the vertical: its card only, and the workspace's untied event is not on it
    const v = agenticMetrics(db, { projectIds: [vert.id], from: MON, to: END }, { tz: 'UTC', now: END });
    assert.deepEqual([v.autonomy.done, v.governance.toolEvents.total, v.governance.toolEvents.untied], [1, 1, 0]);

    // a card filter drops untied events (no card to match)
    const ui = agenticMetrics(db, { projectIds: [ws.id], tag: 'ui', from: MON, to: END }, { tz: 'UTC', now: END });
    assert.deepEqual([ui.autonomy.done, ui.governance.toolEvents.total, ui.governance.toolEvents.tied], [1, 1, 1]);
    db.close();
  });

  it('an empty board', () => {
    const db = openDb();
    const p = getOrCreateProject(db, '/tmp/agentic-empty');
    const r = agenticMetrics(db, { projectIds: [p.id] }, { tz: 'UTC', now: END });
    assert.deepEqual([r.autonomy.done, r.stops.agent, r.batch.cards, r.specAdherence.done, r.governance.toolEvents.total], [0, 0, 0, 0, 0]);
    assert.equal(r.range.from, END);
    db.close();
  });
});
