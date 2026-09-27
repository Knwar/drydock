import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

// The decision-log + risk-register MCP tools, driven over stdio against the REAL daemon (temp DB, random port).

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

interface ToolOut {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP decision + risk tools', () => {
  let daemon: TestDaemon | undefined;
  let client: Client | undefined;
  let wsId: string;
  let webId: string;
  let cardId: string;

  const call = async (name: string, args: Record<string, unknown>) =>
    (await client!.callTool({ name, arguments: args })) as ToolOut;
  const ok = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name} failed: ${r.content[0]?.text}`);
    return JSON.parse(r.content[0].text) as T;
  };

  before(async () => {
    daemon = await startDaemon();
    const root = join(daemon.dbDir, 'shop');
    mkdirSync(join(root, 'web'), { recursive: true });
    const res = await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`);
    wsId = ((await res.json()) as { project_id: string }).project_id;
    const v = await fetch(`${daemon.base}/vertical`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: wsId, name: 'web', root: join(root, 'web') }),
    });
    webId = ((await v.json()) as { project_id: string }).project_id;
    const t = await fetch(`${daemon.base}/task`, {
      method: 'POST',
      body: JSON.stringify({ project_id: webId, title: 'Checkout' }),
    });
    cardId = ((await t.json()) as { task_id: string }).task_id;

    client = new Client({ name: 'governance-test', version: '0.0.0' });
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

  it('lists the new tools', async () => {
    const names = (await client!.listTools()).tools.map((t) => t.name);
    for (const n of ['record_decision', 'list_decisions', 'add_risk', 'update_risk', 'list_risks'])
      assert.ok(names.includes(n), n);
  });

  it('record → list → supersede a decision', async () => {
    const d = await ok<{ id: string; project_id: string; links: unknown[] }>('record_decision', {
      project_id: wsId,
      title: 'Drafts are workspace-wide',
      decision: 'one plan draft spans all verticals',
      rationale: 'cross-board dependencies',
      decided_by: 'user',
      links: [{ target_type: 'card', target_id: cardId }],
    });
    assert.equal(d.project_id, wsId);
    assert.deepEqual(d.links, [{ target_type: 'card', target_id: cardId }]);

    const listed = await ok<{ id: string }[]>('list_decisions', { project_id: wsId, card: cardId, q: 'VERTICALS' });
    assert.deepEqual(listed.map((x) => x.id), [d.id]);

    const sup = await ok<{ superseded: { status: string }; decision: { id: string; links: unknown[] } }>(
      'record_decision',
      { project_id: wsId, title: 'Drafts per board', decision: 'one draft per board', supersedes: d.id },
    );
    assert.equal(sup.superseded.status, 'superseded');
    assert.deepEqual(sup.decision.links, [{ target_type: 'card', target_id: cardId }]);
    const active = await ok<{ id: string }[]>('list_decisions', { project_id: wsId, status: 'active' });
    assert.deepEqual(active.map((x) => x.id), [sup.decision.id]);

    const err = await call('record_decision', { project_id: 'nope', title: 't', decision: 'd' });
    assert.equal(err.isError, true);
    const mismatch = await call('record_decision', {
      project_id: webId,
      title: 't',
      decision: 'd',
      supersedes: sup.decision.id,
    });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.content[0].text, /does not match/);
  });

  it('add → update → list risks', async () => {
    const r = await ok<{ id: string; score: number; status: string }>('add_risk', {
      project_id: webId,
      title: 'Payment provider sandbox flaky',
      likelihood: 3,
      impact: 4,
      links: [{ target_type: 'card', target_id: cardId }],
    });
    assert.equal(r.score, 12);
    assert.equal(r.status, 'open');
    const u = await ok<{ status: string; mitigation: string; closed_at: number | null }>('update_risk', {
      risk_id: r.id,
      status: 'closed',
      mitigation: 'mocked in tests',
    });
    assert.equal(u.status, 'closed');
    assert.equal(u.mitigation, 'mocked in tests');
    assert.ok(u.closed_at);
    assert.deepEqual(await ok('list_risks', { project_id: wsId, status: 'open' }), []);
    const closed = await ok<{ id: string }[]>('list_risks', { project_id: wsId, status: 'closed' });
    assert.deepEqual(closed.map((x) => x.id), [r.id]);
    const found = await ok<{ id: string; scope: string }[]>('list_risks', { project_id: webId, q: 'SANDBOX', card: cardId });
    assert.deepEqual(found.map((x) => [x.id, x.scope]), [[r.id, 'own']]);
    assert.deepEqual(await ok('list_risks', { project_id: webId, q: 'no-such-text' }), []);
    assert.equal((await call('update_risk', { risk_id: 'nope', title: 'x' })).isError, true);
  });
});
