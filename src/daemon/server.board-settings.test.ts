import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

const send = (url: string, method: string, body: unknown) => fetch(url, { method, body: JSON.stringify(body) });

describe('/project/:id/settings + lane_since', () => {
  let daemon: TestDaemon | undefined;
  const projDir = mkdtempSync(join(tmpdir(), 'kankan-bs-proj-'));
  let project = '';

  before(async () => {
    daemon = await startDaemon();
    const res = await fetch(`${daemon.base}/project?root=${encodeURIComponent(projDir)}`);
    project = ((await res.json()) as { project_id: string }).project_id;
  });
  after(async () => {
    await daemon?.stop();
    rmSync(projDir, { recursive: true, force: true });
  });

  it('GET returns defaults', async () => {
    const res = await fetch(`${daemon!.base}/project/${project}/settings`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      stuck_hours: { queued: 72, in_progress: 24, in_review: 24 },
      wip: { in_progress: null, in_review: null },
    });
  });

  it('PUT merges, persists and broadcasts', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws?project=${project}`);
    const msgs: { type: string; settings?: unknown }[] = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once('open', r));
    try {
      const res = await send(`${daemon!.base}/project/${project}/settings`, 'PUT', { wip: { in_progress: 3 } });
      assert.equal(res.status, 200);
      const want = {
        stuck_hours: { queued: 72, in_progress: 24, in_review: 24 },
        wip: { in_progress: 3, in_review: null },
      };
      assert.deepEqual(await res.json(), want);
      assert.deepEqual(await (await fetch(`${daemon!.base}/project/${project}/settings`)).json(), want);
      const sum = (await (await fetch(`${daemon!.base}/workspace/summary?project=${project}`)).json()) as {
        boards: { settings: unknown }[];
      };
      assert.deepEqual(sum.boards[0].settings, want);
      const deadline = Date.now() + 2000;
      while (!msgs.some((m) => m.type === 'settings') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(msgs.find((m) => m.type === 'settings')?.settings, want);
    } finally {
      ws.close();
    }
  });

  it('PUT with invalid values → 400; unknown project → 404', async () => {
    const bad = await send(`${daemon!.base}/project/${project}/settings`, 'PUT', { stuck_hours: { in_review: -1 } });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${daemon!.base}/project/no-such/settings`);
    assert.equal(missing.status, 404);
  });

  it('cards carry lane_since on /board and on the card broadcast', async () => {
    const created = await send(`${daemon!.base}/task`, 'POST', { project_id: project, title: 'A' });
    const { task_id } = (await created.json()) as { task_id: string };
    const ws = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws?project=${project}`);
    const msgs: { type: string; card?: { id: string; lane: string; lane_since: number } }[] = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once('open', r));
    try {
      const t0 = Date.now();
      const moved = await send(`${daemon!.base}/task/${task_id}/move`, 'POST', { lane: 'in_progress' });
      assert.equal(moved.status, 200);
      const [card] = (await (await fetch(`${daemon!.base}/board?project=${project}`)).json()) as {
        lane_since: number;
      }[];
      assert.ok(card.lane_since >= t0 - 5 && card.lane_since <= Date.now());
      const deadline = Date.now() + 2000;
      const find = () => msgs.find((m) => m.type === 'card' && m.card?.lane === 'in_progress');
      while (!find() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(find()?.card?.lane_since, card.lane_since);
    } finally {
      ws.close();
    }
  });
});
