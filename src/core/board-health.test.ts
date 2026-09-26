import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTask,
  DEFAULT_BOARD_SETTINGS,
  getBoard,
  getBoardSettings,
  getOrCreateProject,
  getWorkspaceSummary,
  laneSince,
  moveTask,
  setBoardSettings,
} from './board.js';
import { openDb } from './db.js';

function setup() {
  const db = openDb();
  const project = getOrCreateProject(db, '/tmp/health-app', 'Health App');
  return { db, project };
}

/** Backdate every event of a task's move into `lane` to `at`. */
function backdateMove(db: ReturnType<typeof openDb>, taskId: string, lane: string, at: number) {
  db.prepare(
    `UPDATE task_events SET created_at = ? WHERE task_id = ? AND type = 'move' AND json_extract(payload, '$.to') = ?`,
  ).run(at, taskId, lane);
}

describe('lane_since', () => {
  it('is the last move into the current lane, not updated_at', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'A');
    moveTask(db, t.id, 'queued');
    moveTask(db, t.id, 'in_progress');
    const past = Date.now() - 3 * 86_400_000;
    backdateMove(db, t.id, 'in_progress', past);
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now(), t.id);
    assert.equal(laneSince(db, t.id), past);
    assert.equal(getBoard(db, project.id)[0].lane_since, past);
  });

  it('uses the latest entry when a card re-enters a lane', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'A');
    moveTask(db, t.id, 'in_progress');
    backdateMove(db, t.id, 'in_progress', 1000);
    moveTask(db, t.id, 'in_review');
    moveTask(db, t.id, 'in_progress'); // failed review → back
    assert.ok(laneSince(db, t.id)! > 1000);
  });

  it('falls back to created_at with no move into an in-flight lane', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'A');
    db.prepare(`UPDATE tasks SET lane = 'queued' WHERE id = ?`).run(t.id);
    assert.equal(laneSince(db, t.id), t.created_at);
  });

  it('is null outside the in-flight lanes', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'A');
    assert.equal(laneSince(db, t.id), null);
    moveTask(db, t.id, 'in_progress');
    moveTask(db, t.id, 'done');
    assert.equal(laneSince(db, t.id), null);
    assert.equal(getBoard(db, project.id)[0].lane_since, null);
  });

  it('uses the task/type index for the move lookup', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'A');
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT MAX(created_at) FROM task_events WHERE task_id = ? AND type = 'move'`)
      .all(t.id) as { detail: string }[];
    assert.ok(plan.some((r) => r.detail.includes('idx_events_task_type')), JSON.stringify(plan));
  });

  it('is on the workspace summary active list, with the board settings', () => {
    const { db, project } = setup();
    const t = createTask(db, project.id, 'A');
    moveTask(db, t.id, 'in_review');
    backdateMove(db, t.id, 'in_review', 5000);
    const b = getWorkspaceSummary(db, project.id).boards[0];
    assert.equal(b.active[0].lane_since, 5000);
    assert.deepEqual(b.settings, DEFAULT_BOARD_SETTINGS);
  });
});

describe('board settings', () => {
  it('defaults, partial merge, persistence', () => {
    const { db, project } = setup();
    assert.deepEqual(getBoardSettings(db, project.id), DEFAULT_BOARD_SETTINGS);
    setBoardSettings(db, project.id, { stuck_hours: { in_review: 2 }, wip: { in_progress: 3 } });
    const s = getBoardSettings(db, project.id);
    assert.deepEqual(s, {
      stuck_hours: { queued: 72, in_progress: 24, in_review: 2 },
      wip: { in_progress: 3, in_review: null },
    });
    setBoardSettings(db, project.id, { wip: { in_progress: null } });
    assert.equal(getBoardSettings(db, project.id).wip.in_progress, null);
    assert.equal(getBoardSettings(db, project.id).stuck_hours.in_review, 2);
  });

  it('rejects bad values and lanes without writing', () => {
    const { db, project } = setup();
    for (const patch of [
      null,
      [],
      'x',
      { stuck_hours: { in_review: 2 }, extra: 1 },
      { stuck_hours: [] },
      { wip: 'x' },
      { stuck_hours: { toString: 5 } },
      { wip: { constructor: 3 } },
      { stuck_hours: { in_review: 8761 } },
      { wip: { in_progress: 1001 } },
      { stuck_hours: { in_review: Infinity } },
      { stuck_hours: { in_review: 0 } },
      { stuck_hours: { in_review: '5' } },
      { stuck_hours: { done: 5 } },
      { wip: { in_progress: 1.5 } },
      { wip: { in_progress: -1 } },
      { wip: { queued: 3 } },
    ])
      assert.throws(() => setBoardSettings(db, project.id, patch), JSON.stringify(patch));
    assert.deepEqual(getBoardSettings(db, project.id), DEFAULT_BOARD_SETTINGS);
  });

  it('accepts the caps exactly', () => {
    const { db, project } = setup();
    const s = setBoardSettings(db, project.id, { stuck_hours: { queued: 8760 }, wip: { in_review: 1000 } });
    assert.equal(s.stuck_hours.queued, 8760);
    assert.equal(s.wip.in_review, 1000);
  });
});
