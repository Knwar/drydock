import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { openDb } from '../core/db.js';
import { startDaemon } from './test-daemon.js';

// Perf guard for GET /home: the Home view re-fetches it on every board change,
// so it must not scale with the (mostly done) card count of every board.

it('GET /home stays fast on a large workspace (4 boards x 300 cards, most done)', async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const post = (path: string, body: unknown) =>
    fetch(`${daemon.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const wsRoot = join(daemon.dbDir, 'big');
  mkdirSync(wsRoot, { recursive: true });
  const wsId = ((await (await fetch(`${daemon.base}/project?root=${encodeURIComponent(wsRoot)}`)).json()) as {
    project_id: string;
  }).project_id;
  const boards = [wsId];
  for (let v = 0; v < 3; v++) {
    mkdirSync(join(wsRoot, `v${v}`));
    const res = await post('/vertical', { workspace_id: wsId, name: `v${v}`, root: join(wsRoot, `v${v}`) });
    assert.equal(res.status, 200);
    boards.push(((await res.json()) as { project_id: string }).project_id);
  }
  assert.equal((await post('/team', { name: 'Ada' })).status, 200);

  // seed the cards straight into the daemon's DB (WAL: safe alongside the daemon)
  const db = openDb(join(daemon.dbDir, 'board.db'));
  try {
    const insert = db.prepare(
      `INSERT INTO tasks (id, project_id, title, lane, requirements, assigned_agent, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?)`,
    );
    const ts = Date.now();
    db.transaction(() => {
      boards.forEach((b, bi) => {
        for (let i = 0; i < 300; i++) {
          // ~90% done, the rest spread over the open lanes
          const lane = i % 10 ? 'done' : ['backlog', 'queued', 'in_progress', 'in_review'][(i / 10) % 4];
          insert.run(`b${bi}t${i}`, b, `Card ${i}`, lane, i % 2 ? 'Ada' : null, i, ts, ts);
        }
      });
    })();
  } finally {
    db.close();
  }
  // live session entries on every board, joined back to cards by task_id
  for (const [bi, b] of boards.entries()) {
    for (let i = 0; i < 5; i++) {
      const res = await post('/status', {
        project_id: b,
        agent: 'builder',
        agent_id: `a${bi}-${i}`,
        task_id: `b${bi}t${i * 10 + 20}`,
        verb: 'Edit',
        detail: `f${i}.ts`,
      });
      assert.equal(res.status, 200);
    }
  }

  const home = async () => {
    const res = await fetch(`${daemon.base}/home?project=${wsId}`);
    assert.equal(res.status, 200);
    return (await res.json()) as { verticals: unknown[]; now_building: unknown[] };
  };
  await home(); // warm up (statement compilation, JIT)
  const start = performance.now();
  const h = await home();
  const elapsed = performance.now() - start;
  assert.equal(h.verticals.length, 4);
  assert.ok(h.now_building.length > 0);
  // Pathological-regression guard only (loaded machines/parallel runs are noisy).
  const budget = Number(process.env.KANKAN_PERF_BUDGET_MS) || 500;
  assert.ok(elapsed < budget, `GET /home took ${elapsed.toFixed(1)}ms (budget ${budget}ms)`);
});
