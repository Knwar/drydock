import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// End-to-end coverage for the in-memory session-state cache: POST /status
// records + broadcasts (with project_id), GET /session reads it back, and
// DELETE /project/:id forgets it.

describe('daemon session state (/status, /session)', () => {
  let daemon: TestDaemon | undefined;
  const sockets: WebSocket[] = [];
  let base: string;
  let port: number;
  let projectId: string;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
    port = daemon.port;
    const root = join(daemon.dbDir, 'proj');
    mkdirSync(root, { recursive: true });
    const res = await fetch(`${base}/project?root=${encodeURIComponent(root)}`);
    projectId = ((await res.json()) as { project_id: string }).project_id;
  });

  after(async () => {
    for (const ws of sockets) ws.terminate();
    await daemon?.stop();
  });

  it('GET /session requires a project', async () => {
    assert.equal((await fetch(`${base}/session`)).status, 400);
  });

  it('GET /session is offline before any status', async () => {
    const res = await fetch(`${base}/session?project=${projectId}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: 'offline', main: null, agents: [] });
  });

  it('POST /status broadcasts project_id + session to an all-projects subscriber', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const got = new Promise<any>((resolve) =>
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'status') resolve(msg);
      }),
    );
    await new Promise((r) => ws.once('open', r));
    const res = await post('/status', { project_id: projectId, agent: 'orchestrator', verb: 'Edit', detail: 'x.ts' });
    assert.equal(res.status, 200);
    const msg = await got;
    ws.close();
    assert.equal(msg.project_id, projectId);
    assert.deepEqual(msg.status, { agent: 'orchestrator', verb: 'Edit', detail: 'x.ts', task_id: null });
    assert.equal(msg.session.state, 'working');
    assert.equal(msg.session.main.verb, 'Edit');
  });

  it('GET /session reflects recorded statuses', async () => {
    await post('/status', { project_id: projectId, agent: 'orchestrator', verb: 'needs you' });
    await post('/status', { project_id: projectId, agent: 'builder', agent_id: 'b1', verb: 'Bash', task_id: 't1' });
    await post('/status', { project_id: projectId, agent: 'builder', agent_id: 'b2', verb: 'Read' });
    await post('/status', { project_id: projectId, agent: 'builder', agent_id: 'b2', verb: 'finished' });
    const view = (await (await fetch(`${base}/session?project=${projectId}`)).json()) as any;
    assert.equal(view.state, 'needs_you');
    assert.equal(view.main.verb, 'needs you');
    assert.deepEqual(
      view.agents.map((a: any) => [a.agent, a.agent_id, a.verb, a.task_id]),
      [['builder', 'b1', 'Bash', 't1']],
    );
  });

  it('DELETE /project/:id forgets the session', async () => {
    const del = await fetch(`${base}/project/${projectId}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const view = (await (await fetch(`${base}/session?project=${projectId}`)).json()) as any;
    assert.deepEqual(view, { state: 'offline', main: null, agents: [] });
  });
});
