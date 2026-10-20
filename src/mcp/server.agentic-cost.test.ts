import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

// get_agentic_cost, driven over stdio against the REAL daemon (temp DB, random port).

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

interface ToolOut {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP get_agentic_cost', () => {
  let daemon: TestDaemon | undefined;
  let client: Client | undefined;
  let projectId: string;

  const call = async (args: Record<string, unknown>) =>
    (await client!.callTool({ name: 'get_agentic_cost', arguments: args })) as ToolOut;
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${daemon!.base}${path}`, { method, body: JSON.stringify(body) });

  before(async () => {
    daemon = await startDaemon();
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    projectId = ((await (await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const id = ((await (await send('POST', '/task', { project_id: projectId, title: 'A', tag: 'api' })).json()) as { task_id: string }).task_id;
    await send('POST', `/task/${id}/move`, { lane: 'in_progress' });
    await send('POST', `/task/${id}/block`, { reason: 'q' });
    client = new Client({ name: 'agentic-cost-test', version: '0.0.0' });
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
    assert.ok((await client!.listTools()).tools.some((t) => t.name === 'get_agentic_cost'));
  });

  it('returns the metrics, with filters and compare passed through', async () => {
    const r = await call({ project_id: projectId });
    assert.ok(!r.isError, r.content[0]?.text);
    const m = JSON.parse(r.content[0].text);
    assert.equal(m.decisionLatencyCost.queue.length, 1);
    assert.equal(m.reworkCost.cost, 0);

    const ui = JSON.parse((await call({ project_id: projectId, tag: 'ui', tz: 'UTC' })).content[0].text);
    assert.equal(ui.decisionLatencyCost.queue.length, 0);

    const today = new Date().toISOString().slice(0, 10);
    const cmp = JSON.parse((await call({ project_id: projectId, from: today, tz: 'UTC', compare: 'previous' })).content[0].text);
    assert.deepEqual(cmp.previous.reworkCost, { cost: 0, tokens: 0, pct: null });
    assert.ok(cmp.previousWindow);
  });

  it('surfaces daemon errors', async () => {
    assert.equal((await call({ project_id: 'nope' })).isError, true);
  });
});
