import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

// get_metrics, driven over stdio against the REAL daemon (temp DB, random port).

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

interface ToolOut {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP get_metrics', () => {
  let daemon: TestDaemon | undefined;
  let client: Client | undefined;
  let projectId: string;
  let doneId: string;
  let wipId: string;

  const call = async (args: Record<string, unknown>) =>
    (await client!.callTool({ name: 'get_metrics', arguments: args })) as ToolOut;
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${daemon!.base}${path}`, { method, body: JSON.stringify(body) });
  const task = async (title: string, tag: string) =>
    ((await (await send('POST', '/task', { project_id: projectId, title, tag })).json()) as { task_id: string }).task_id;

  before(async () => {
    daemon = await startDaemon();
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    projectId = ((await (await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    doneId = await task('Done', 'ui');
    await send('POST', `/task/${doneId}/move`, { lane: 'in_progress' });
    await send('POST', `/task/${doneId}/move`, { lane: 'done' });
    wipId = await task('Wip', 'api');
    await send('POST', `/task/${wipId}/move`, { lane: 'in_review' });

    client = new Client({ name: 'metrics-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', SERVER],
        env: { ...(process.env as Record<string, string>), DAEMON_URL: daemon.base },
        stderr: 'ignore',
      }),
    );
  });

  after(async () => {
    await client?.close();
    await daemon?.stop();
  });

  it('is listed', async () => {
    assert.ok((await client!.listTools()).tools.some((t) => t.name === 'get_metrics'));
  });

  it('returns the compact summary, with filters passed through', async () => {
    const r = await call({ project_id: projectId });
    assert.ok(!r.isError, r.content[0]?.text);
    const s = JSON.parse(r.content[0].text);
    assert.equal(s.throughput.reduce((n: number, w: { count: number }) => n + w.count, 0), 1);
    assert.equal(s.cycleTime.count, 1);
    assert.deepEqual(s.wip, { backlog: 0, queued: 0, in_progress: 0, in_review: 1 });
    assert.equal(s.oldestInFlight.id, wipId);
    assert.equal(s.points, undefined, 'no full series');
    assert.equal(s.cfd, undefined, 'no full series');
    assert.deepEqual(s.waiting, { count: 0, longestMs: null });

    const api = JSON.parse((await call({ project_id: projectId, tag: 'api' })).content[0].text);
    assert.equal(api.cycleTime.count, 0);
    assert.equal(api.wip.in_review, 1);
    const none = JSON.parse((await call({ project_id: projectId, agent: 'nobody' })).content[0].text);
    assert.equal(none.cards, 0);
    assert.equal(none.oldestInFlight, null);
    const today = new Date().toISOString().slice(0, 10);
    const ranged = await call({ project_id: projectId, from: '2026-01-01', to: today, tz: 'Asia/Kolkata' });
    assert.ok(!ranged.isError, ranged.content[0]?.text);
    assert.equal(JSON.parse(ranged.content[0].text).range.tz, 'Asia/Kolkata');
  });

  it('adds what is waiting on the human now (needs-you sessions + open blockers)', async () => {
    await send('POST', `/task/${wipId}/block`, { reason: 'which db?' });
    await send('POST', '/status', { project_id: projectId, agent: 'orchestrator', verb: 'needs you', detail: 'perm' });
    const s = JSON.parse((await call({ project_id: projectId })).content[0].text);
    assert.equal(s.waiting.count, 2);
    assert.ok(s.waiting.longestMs >= 0);
    await send('POST', `/task/${wipId}/unblock`, {});
    await send('POST', '/status', { project_id: projectId, agent: 'orchestrator', verb: 'Edit' });
    const after = JSON.parse((await call({ project_id: projectId })).content[0].text);
    assert.deepEqual(after.waiting, { count: 0, longestMs: null });
  });

  it('surfaces bad params and unknown projects as tool errors', async () => {
    const bad = await call({ project_id: projectId, from: 'whenever' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /invalid from/);
    const badTz = await call({ project_id: projectId, tz: 'Mars/Olympus' });
    assert.equal(badTz.isError, true);
    assert.match(badTz.content[0].text, /invalid tz/);
    // tag is the same enum as the other tools
    assert.equal((await call({ project_id: projectId, tag: 'frontend' })).isError, true);
    const unknown = await call({ project_id: 'nope' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown project/);
  });

  it('get_forecast passes its target through (1 done card: insufficient history)', async () => {
    const r = (await client!.callTool({ name: 'get_forecast', arguments: { project_id: projectId, tz: 'UTC' } })) as ToolOut;
    assert.ok(!r.isError, r.content[0]?.text);
    const f = JSON.parse(r.content[0].text);
    assert.equal(f.status, 'insufficient_history');
    assert.equal(f.remaining, 1);
    const unknown = (await client!.callTool({ name: 'get_forecast', arguments: { plan_id: 'nope' } })) as ToolOut;
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown plan/);
  });
});
