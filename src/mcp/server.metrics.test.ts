import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
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
        env: { ...(process.env as Record<string, string>), DAEMON_URL: daemon.base, DAEMON_TOKEN: daemon.token },
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
    assert.deepEqual(s.cost, { period: 0, estimatedShare: null });

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

  it('adds the cost of the window: USD spent + the estimated share', async () => {
    // placeholder rates: claude-opus-5-5 input 15/M; the tokens-only run (1.97M, deflated /1.97 to 1M) is estimated at its cache-read rate (1.5/M)
    await send('POST', `/task/${doneId}/activity`, { agent: 'builder', usage: { 'claude-opus-5-5': { input: 1_000_000 } } });
    assert.deepEqual(JSON.parse((await call({ project_id: projectId })).content[0].text).cost, { period: 15, estimatedShare: 0 });
    await send('POST', `/task/${doneId}/activity`, { agent: 'builder', tokens: 1_970_000, tokens_out: 0 });
    const s = JSON.parse((await call({ project_id: projectId })).content[0].text);
    assert.deepEqual(s.cost, { period: 16.5, estimatedShare: Math.round((1.5 / 16.5) * 1e6) / 1e6 });
    // filters pass through: nothing credited to this agent
    assert.deepEqual(JSON.parse((await call({ project_id: projectId, agent: 'nobody' })).content[0].text).cost, { period: 0, estimatedShare: null });
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

describe('MCP get_forecast seed', () => {
  it('passes seed through to /metrics/forecast', async (t) => {
    const urls: string[] = [];
    const stub = createServer((req, res) => {
      urls.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    t.after(() => stub.close());
    const client = new Client({ name: 'forecast-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', SERVER],
        env: { ...(process.env as Record<string, string>), DAEMON_URL: `http://127.0.0.1:${(stub.address() as { port: number }).port}` },
        stderr: 'ignore',
      }),
    );
    t.after(() => client.close());
    const tool = (await client.listTools()).tools.find((x) => x.name === 'get_forecast')!;
    assert.match(tool.description!, /must be the plan's workspace/);
    await client.callTool({ name: 'get_forecast', arguments: { project_id: 'p', seed: 7 } });
    assert.deepEqual(urls, ['/metrics/forecast?project=p&seed=7']);
    const bad = (await client.callTool({ name: 'get_forecast', arguments: { project_id: 'p', seed: -1 } })) as ToolOut;
    assert.equal(bad.isError, true);
  });
});

describe('MCP get_metrics when a side lookup fails', () => {
  // a stub daemon: the summary works; `failing` routes return 500
  const withStub = async (t: { after: (fn: () => unknown) => void }, failing: string[]) => {
    const stub = createServer((req, res) => {
      const path = req.url ?? '';
      const body = path.startsWith('/metrics/summary')
        ? { cards: 3, range: { from: 1, to: 2, tz: 'UTC' } }
        : path.startsWith('/metrics/wait')
          ? { waiting: { count: 1, longestMs: 5, items: [] } }
          : { totals: { cost: 7 }, estimated: { share: 0.5 } };
      const fail = failing.some((f) => path.startsWith(f));
      res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fail ? { error: 'boom' } : body));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    t.after(() => stub.close());
    const client = new Client({ name: 'metrics-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', SERVER],
        env: { ...(process.env as Record<string, string>), DAEMON_URL: `http://127.0.0.1:${(stub.address() as { port: number }).port}` },
        stderr: 'ignore',
      }),
    );
    t.after(() => client.close());
    const r = (await client.callTool({ name: 'get_metrics', arguments: { project_id: 'p' } })) as ToolOut;
    assert.ok(!r.isError);
    return { summary: JSON.parse(r.content[0].text), notes: r.content.slice(1).map((c) => c.text) };
  };
  const range = { from: 1, to: 2, tz: 'UTC' };

  it('a failed wait lookup drops `waiting` with a note, and cost is still looked up', async (t) => {
    const { summary, notes } = await withStub(t, ['/metrics/wait']);
    assert.deepEqual(summary, { cards: 3, range, cost: { period: 7, estimatedShare: 0.5 } });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /waiting unavailable: .*boom/);
  });

  it('a failed cost lookup drops `cost` with a note', async (t) => {
    const { summary, notes } = await withStub(t, ['/metrics/cost']);
    assert.deepEqual(summary, { cards: 3, range, waiting: { count: 1, longestMs: 5 } });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /cost unavailable: .*boom/);
  });

  it('both failing: two notes', async (t) => {
    const { summary, notes } = await withStub(t, ['/metrics/wait', '/metrics/cost']);
    assert.deepEqual(summary, { cards: 3, range });
    assert.equal(notes.length, 2);
  });
});
