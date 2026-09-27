import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon } from '../daemon/test-daemon.js';

// update_phase's target_date, driven over stdio against the REAL daemon (temp DB, random port).

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

interface ToolOut {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP update_phase target_date', () => {
  it('sets, reads back via get_phases, combines with status, clears, rejects bad dates', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    const pid = ((await (await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    const phaseId = (
      (await (await fetch(`${daemon.base}/phase`, { method: 'POST', body: JSON.stringify({ project_id: pid, title: 'P1' }) })).json()) as {
        phase_id: string;
      }
    ).phase_id;

    const client = new Client({ name: 'schedule-test', version: '0.0.0' });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', SERVER],
        env: { ...(process.env as Record<string, string>), DAEMON_URL: daemon.base },
        stderr: 'ignore',
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolOut;
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await call(name, args);
      assert.ok(!r.isError, `${name} failed: ${r.content[0]?.text}`);
      return JSON.parse(r.content[0].text);
    };
    const target = async () =>
      ((await ok('get_phases', { project_id: pid })) as { id: string; target_date: string | null }[]).find((p) => p.id === phaseId)!
        .target_date;

    assert.equal((await ok('update_phase', { phase_id: phaseId, target_date: '2026-10-05' })).target_date, '2026-10-05');
    assert.equal(await target(), '2026-10-05');
    const both = await ok('update_phase', { phase_id: phaseId, target_date: '2026-11-01', status: 'active' });
    assert.deepEqual([both.status, both.target_date], ['active', '2026-11-01']);
    assert.equal((await ok('update_phase', { phase_id: phaseId, target_date: null })).target_date, null);
    assert.equal(await target(), null);
    const bad = await call('update_phase', { phase_id: phaseId, target_date: '2026-02-30', status: 'done' });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /YYYY-MM-DD/);
    assert.equal((await ok('get_phases', { project_id: pid }))[0].status, 'active', 'a rejected target skips the status change');
  });
});
