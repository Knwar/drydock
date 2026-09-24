import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// End-to-end coverage for GET /workspace/summary: the DB summary per board,
// merged with the in-memory session view.

describe('daemon GET /workspace/summary', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  let workspaceId: string;
  let verticalId: string;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
    const wsRoot = join(daemon.dbDir, 'workspace');
    const vRoot = join(wsRoot, 'api');
    mkdirSync(vRoot, { recursive: true });
    const res = await fetch(`${base}/project?root=${encodeURIComponent(wsRoot)}`);
    workspaceId = ((await res.json()) as { project_id: string }).project_id;
    const v = await post('/vertical', { workspace_id: workspaceId, name: 'api', root: vRoot });
    assert.equal(v.status, 200);
    verticalId = ((await v.json()) as { project_id: string }).project_id;
  });

  after(async () => {
    await daemon?.stop();
  });

  it('returns the workspace first, then the vertical, each with its live session', async () => {
    assert.equal((await post('/status', { project_id: verticalId, agent: 'orchestrator', verb: 'Edit', detail: 'x.ts' })).status, 200);
    for (const id of [workspaceId, verticalId]) {
      const res = await fetch(`${base}/workspace/summary?project=${id}`);
      assert.equal(res.status, 200);
      const sum = (await res.json()) as any;
      assert.equal(sum.workspace.id, workspaceId);
      assert.deepEqual(
        sum.boards.map((b: any) => b.project.id),
        [workspaceId, verticalId],
      );
      assert.equal(sum.boards[0].session.state, 'offline');
      assert.equal(sum.boards[1].session.state, 'working');
      assert.equal(sum.boards[1].session.main.verb, 'Edit');
      assert.deepEqual(sum.boards[1].lanes, { backlog: 0, queued: 0, in_progress: 0, in_review: 0, done: 0 });
      assert.deepEqual(sum.attention, []);
    }
  });

  it('unknown id → 404, missing param → 400', async () => {
    const res = await fetch(`${base}/workspace/summary?project=does-not-exist`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'unknown project' });
    assert.equal((await fetch(`${base}/workspace/summary`)).status, 400);
  });
});
