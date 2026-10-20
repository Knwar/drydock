import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon } from '../daemon/test-daemon.js';

// get_report, driven over stdio against the REAL daemon (temp DB, random port).

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

interface ToolOut {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP get_report', () => {
  it('markdown by default, json on request, range params, errors', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    const post = async (path: string, body: unknown) =>
      (await (await fetch(`${daemon.base}${path}`, { method: 'POST', body: JSON.stringify(body) })).json()) as any;
    const pid = ((await (await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string }).project_id;
    const phaseId = (await post('/phase', { project_id: pid, title: 'P1' })).phase_id as string;
    const id = (await post('/task', { project_id: pid, title: 'Shipped thing', phase_id: phaseId })).task_id as string;
    await post(`/task/${id}/move`, { lane: 'done' });

    const client = new Client({ name: 'report-test', version: '0.0.0' });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', SERVER],
        env: { ...(process.env as Record<string, string>), DAEMON_URL: daemon.base, DAEMON_TOKEN: daemon.token },
        stderr: 'ignore',
      }),
    );
    const tools = await client.listTools();
    const tool = tools.tools.find((x) => x.name === 'get_report');
    assert.ok(tool, 'get_report is listed');
    assert.match(tool.description ?? '', /summarising project status to the user or publishing/);

    const call = async (args: Record<string, unknown>) => (await client.callTool({ name: 'get_report', arguments: args })) as ToolOut;

    const md = await call({ project_id: pid, tz: 'UTC' });
    assert.ok(!md.isError, md.content[0]?.text);
    assert.match(md.content[0].text, /^# Status report: /);
    assert.match(md.content[0].text, /## Shipped \(1\)/);
    assert.match(md.content[0].text, /- Shipped thing/);

    const json = await call({ project_id: pid, tz: 'UTC', format: 'json' });
    assert.ok(!json.isError, json.content[0]?.text);
    const r = JSON.parse(json.content[0].text);
    assert.equal(r.project.id, pid);
    assert.equal(r.shipped.total, 1);
    assert.equal(r.range.tz, 'UTC');

    const ranged = JSON.parse((await call({ project_id: pid, tz: 'UTC', format: 'json', from: '2020-01-01', to: '2020-01-31' })).content[0].text);
    assert.deepEqual([ranged.range.from_day, ranged.range.to_day, ranged.shipped.total], ['2020-01-01', '2020-01-31', 0]);

    const bad = await call({ project_id: 'nope' });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /unknown project/);
  });
});
