import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon } from '../daemon/test-daemon.js';

// create_task/update_task work_type and get_report's per-phase p95, driven over stdio
// against the REAL daemon (temp DB, random port).

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

interface ToolOut {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP work_type + schedule p95', () => {
  it('work_type round-trips through create/update, invalid values error, get_report phases carry p95', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    const pid = ((await (await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const workType = async (id: string) =>
      ((await (await fetch(`${daemon.base}/task/${id}`)).json()) as { work_type: string | null }).work_type;

    const client = new Client({ name: 'worktype-test', version: '0.0.0' });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', SERVER],
        env: { ...(process.env as Record<string, string>), DAEMON_URL: daemon.base },
        stderr: 'ignore',
      }),
    );
    // an invalid argument is either an isError result or a thrown McpError, depending on the SDK
    const call = async (name: string, args: Record<string, unknown>): Promise<ToolOut> => {
      try {
        return (await client.callTool({ name, arguments: args })) as ToolOut;
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
      }
    };
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await call(name, args);
      assert.ok(!r.isError, `${name} failed: ${r.content[0]?.text}`);
      return JSON.parse(r.content[0].text);
    };

    const tools = (await client.listTools()).tools;
    for (const name of ['create_task', 'update_task']) {
      const desc = tools.find((x) => x.name === name)?.description ?? '';
      for (const re of [/feature = new user value/, /defect = fixing broken behaviour/, /debt = refactor, upgrade, tests or cleanup/, /risk = security, compliance or reliability/])
        assert.match(desc, re, `${name} description`);
    }

    const id = (await ok('create_task', { project_id: pid, title: 'Typed', work_type: 'defect' })).task_id as string;
    assert.equal(await workType(id), 'defect');
    const untyped = (await ok('create_task', { project_id: pid, title: 'Untyped' })).task_id as string;
    assert.equal(await workType(untyped), null);

    await ok('update_task', { task_id: id, work_type: 'risk' });
    assert.equal(await workType(id), 'risk');
    await ok('update_task', { task_id: id, requirements: 'unrelated edit' });
    assert.equal(await workType(id), 'risk', 'a patch without work_type leaves it alone');
    await ok('update_task', { task_id: id, work_type: null });
    assert.equal(await workType(id), null);

    const badCreate = await call('create_task', { project_id: pid, title: 'Bad', work_type: 'chore' });
    assert.ok(badCreate.isError);
    assert.match(badCreate.content[0].text, /work_type/);
    const badUpdate = await call('update_task', { task_id: id, work_type: 'bug' });
    assert.ok(badUpdate.isError);
    assert.match(badUpdate.content[0].text, /work_type/);
    assert.equal(await workType(id), null, 'a rejected update changes nothing');

    // get_report json: every phase carries p95 alongside p50/p85, matching the schedule's
    const phaseId = ((await (await fetch(`${daemon.base}/phase`, { method: 'POST', body: JSON.stringify({ project_id: pid, title: 'P1' }) })).json()) as {
      phase_id: string;
    }).phase_id;
    await ok('create_task', { project_id: pid, title: 'In phase', phase_id: phaseId, work_type: 'feature' });
    const report = await ok('get_report', { project_id: pid, tz: 'UTC', format: 'json' });
    const sched = (await (await fetch(`${daemon.base}/metrics/schedule?project=${pid}&tz=UTC`)).json()) as {
      phases: { id: string; p95?: string | null }[];
    };
    const phase = (report.phases as Record<string, unknown>[]).find((p) => p.id === phaseId)!;
    for (const k of ['p50', 'p85', 'p95']) assert.ok(k in phase, `report phase has ${k}`);
    assert.equal(phase.p95, sched.phases.find((p) => p.id === phaseId)!.p95 ?? null);

    const forecastDesc = tools.find((x) => x.name === 'get_forecast')?.description ?? '';
    assert.match(forecastDesc, /p50\/p85\/p95/);
  });
});
