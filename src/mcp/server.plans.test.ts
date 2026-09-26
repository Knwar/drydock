import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

// The plan-draft MCP tools, driven over stdio against the REAL daemon (temp DB, random port).

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

interface ToolOut {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP plan-draft tools', () => {
  let daemon: TestDaemon | undefined;
  let client: Client | undefined;
  let wsId: string;
  let webId: string;

  const call = async (name: string, args: Record<string, unknown>) =>
    (await client!.callTool({ name, arguments: args })) as ToolOut;
  const ok = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name} failed: ${r.content[0]?.text}`);
    return JSON.parse(r.content[0].text) as T;
  };
  const fail = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} should fail: ${r.content[0]?.text}`);
    return r.content[0].text;
  };

  before(async () => {
    daemon = await startDaemon();
    const root = join(daemon.dbDir, 'shop');
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    const res = await fetch(`${daemon.base}/project?root=${encodeURIComponent(root)}`);
    wsId = ((await res.json()) as { project_id: string }).project_id;
    const v = await fetch(`${daemon.base}/vertical`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: wsId, name: 'web', root: join(root, 'apps', 'web') }),
    });
    webId = ((await v.json()) as { project_id: string }).project_id;

    client = new Client({ name: 'plans-test', version: '0.0.0' });
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
    for (const n of ['list_plans', 'get_plan', 'create_plan', 'edit_plan', 'preview_plan_commit', 'commit_plan', 'run_plan'])
      assert.ok(names.includes(n), n);
  });

  it('create → edit → get → preview → commit → run queue', async () => {
    // a vertical id resolves to its workspace
    const created = await ok<{ id: string; workspace_id: string; version: number }>('create_plan', {
      project_id: webId,
      title: 'Launch',
    });
    assert.equal(created.workspace_id, wsId);
    assert.equal(created.version, 1);
    const id = created.id;

    const edited = await ok<{ draft: { version: number; data: { nodes: unknown[]; edges: unknown[] } } }>('edit_plan', {
      plan_id: id,
      version: 1,
      ops: [
        { op: 'add_node', node: { id: 'a', title: 'API contract', board_id: wsId, phase: 'Foundation', requirements: 'r', subtasks: ['s'] } },
        { op: 'add_node', node: { id: 'b', title: 'Web client', board_id: webId, phase: 'Foundation', requirements: 'r', subtasks: ['s'], tag: 'ui' } },
        { op: 'add_node', node: { id: 'c', title: 'Web page', board_id: webId, phase: 'Build' } },
        { op: 'add_edge', from: 'a', to: 'b' },
        { op: 'add_edge', from: 'b', to: 'c' },
        { op: 'update_node', id: 'b', patch: { tag: null } },
        { op: 'set_title', title: 'Launch v1' },
      ],
    });
    assert.equal(edited.draft.version, 2);

    const view = await ok<{
      draft: { title: string; version: number; data: { nodes: { id: string; tag?: string }[]; edges: unknown[] } };
      layout: { columns: string[][] } | null;
      validation: { errors: unknown[] };
      dirty: boolean;
    }>('get_plan', { plan_id: id });
    assert.equal(view.draft.title, 'Launch v1');
    assert.equal(view.draft.data.nodes.length, 3);
    assert.equal(view.draft.data.edges.length, 2);
    assert.equal(view.draft.data.nodes.find((n) => n.id === 'b')!.tag, undefined, 'null cleared the tag');
    assert.ok(view.layout, 'layout present');
    assert.deepEqual(view.validation.errors, []);
    assert.equal(view.dirty, true);

    const list = await ok<{ id: string; node_count: number }[]>('list_plans', { project_id: wsId });
    assert.deepEqual(list.map((d) => [d.id, d.node_count]), [[id, 3]]);

    const diff = await ok<{ errors: unknown[]; boards: { board_id: string; create: unknown[] }[] }>('preview_plan_commit', {
      plan_id: id,
    });
    assert.deepEqual(diff.errors, []);
    assert.deepEqual(diff.boards.map((b) => [b.board_id, b.create.length]), [
      [wsId, 1],
      [webId, 2],
    ]);

    // running before commit is a 409 surfaced as a tool error
    assert.match(await fail('run_plan', { plan_id: id, mode: 'queue' }), /not_committed/);

    const committed = await ok<{ draft: { dirty: boolean; draft: { data: { committed: Record<string, string> } } } }>(
      'commit_plan',
      { plan_id: id, version: 2 },
    );
    assert.equal(committed.draft.dirty, false);
    const m = committed.draft.draft.data.committed;
    assert.deepEqual(Object.keys(m).sort(), ['a', 'b', 'c']);

    const run = await ok<{ queued: string[]; skipped: { node_id: string }[] }>('run_plan', { plan_id: id, mode: 'queue' });
    assert.deepEqual(run.queued.sort(), [m.a, m.b].sort());
    assert.deepEqual(run.skipped.map((s) => s.node_id), ['c']);
  });

  it('surfaces a stale version (409), a bad op (400), a malformed op, and an unknown plan (404)', async () => {
    const { id } = await ok<{ id: string }>('create_plan', { project_id: wsId, title: 'Errors' });
    await ok('edit_plan', { plan_id: id, ops: [{ op: 'add_node', node: { id: 'x', title: 'X', board_id: wsId } }] });

    const stale = await fail('edit_plan', { plan_id: id, version: 1, ops: [{ op: 'set_title', title: 'Nope' }] });
    assert.match(stale, /version mismatch/);
    assert.match(await fail('commit_plan', { plan_id: id, version: 1 }), /version/);

    const bad = await fail('edit_plan', { plan_id: id, ops: [{ op: 'add_edge', from: 'x', to: 'missing' }] });
    assert.match(bad, /unknown_node/);

    const malformed = await fail('edit_plan', { plan_id: id, ops: [{ op: 'explode' }] });
    assert.match(malformed, /No matching discriminator/);

    assert.match(await fail('get_plan', { plan_id: 'nope' }), /unknown draft/);
    assert.match(await fail('preview_plan_commit', { plan_id: 'nope' }), /no such draft/);
  });
});
