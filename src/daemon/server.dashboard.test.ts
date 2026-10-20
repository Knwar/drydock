import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { builtinTemplates } from '../core/dashboard.js';
import type { DashboardLayout } from '../core/types.js';
import { startDaemon, type TestDaemon, wsAuth } from './test-daemon.js';

const send = (url: string, method: string, body?: unknown) =>
  fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const mine: DashboardLayout = {
  version: 1,
  sections: [
    {
      id: 's',
      title: 'Mine',
      rows: [{ id: 'r', height: 3, slots: [{ id: 'sl', span: 12, widgets: [{ id: 'w', type: 'up-next', size: 'M', params: {} }] }] }],
    },
  ],
};

describe('/project/:id/layout + /dashboard/templates', () => {
  let daemon: TestDaemon | undefined;
  let solo = '';
  let workspace = '';
  let vertical = '';
  const base = () => daemon!.base;

  before(async () => {
    daemon = await startDaemon({ env: { HOST: '127.0.0.1', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    const soloRoot = join(daemon.dbDir, 'solo');
    const wsRoot = join(daemon.dbDir, 'ws');
    mkdirSync(soloRoot, { recursive: true });
    mkdirSync(join(wsRoot, 'web'), { recursive: true });
    const id = async (root: string) =>
      ((await (await fetch(`${base()}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string }).project_id;
    solo = await id(soloRoot);
    workspace = await id(wsRoot);
    const v = await send(`${base()}/vertical`, 'POST', { workspace_id: workspace, name: 'web', root: join(wsRoot, 'web') });
    assert.equal(v.status, 200);
    vertical = ((await v.json()) as { project_id: string }).project_id;
  });
  after(async () => {
    await daemon?.stop();
  });

  it('GET returns the default layout per board type', async () => {
    const soloRes = await fetch(`${base()}/project/${solo}/layout`);
    assert.equal(soloRes.status, 200);
    assert.deepEqual(await soloRes.json(), { layout: builtinTemplates(false)[0].layout, source: 'default', template: 'Delivery lead' });
    for (const pid of [workspace, vertical]) {
      const body = (await (await fetch(`${base()}/project/${pid}/layout`)).json()) as { layout: DashboardLayout };
      assert.deepEqual(body.layout, builtinTemplates(true)[0].layout, pid);
    }
  });

  it('PUT saves, broadcasts {type:layout} and GET then returns it', async () => {
    const ws = new WebSocket(...wsAuth(`ws://127.0.0.1:${daemon!.port}/ws?project=${solo}`));
    const msgs: { type: string; project_id?: string }[] = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once('open', r));
    try {
      const res = await send(`${base()}/project/${solo}/layout`, 'PUT', { layout: mine });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { layout: mine, source: 'saved' });
      const got = (await (await fetch(`${base()}/project/${solo}/layout`)).json()) as { layout: unknown; source: string };
      assert.deepEqual([got.layout, got.source], [mine, 'saved']);
      const deadline = Date.now() + 2000;
      while (!msgs.some((m) => m.type === 'layout') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(msgs.find((m) => m.type === 'layout'), { type: 'layout', project_id: solo });
    } finally {
      ws.close();
    }
  });

  it('PUT with an invalid layout → 400 with the error list, nothing saved', async () => {
    const bad = structuredClone(mine);
    bad.sections[0].rows[0].slots[0].span = 13;
    bad.sections[0].rows[0].slots[0].widgets[0].type = 'bogus';
    const res = await send(`${base()}/project/${vertical}/layout`, 'PUT', { layout: bad });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { errors: { path: string; message: string }[] };
    assert.deepEqual(
      body.errors.map((e) => e.path),
      ['sections[0].rows[0].slots[0].span', 'sections[0].rows[0].slots[0].widgets[0].type'],
    );
    assert.equal((await send(`${base()}/project/${vertical}/layout`, 'PUT', {})).status, 400);
    const after = (await (await fetch(`${base()}/project/${vertical}/layout`)).json()) as { source: string };
    assert.equal(after.source, 'default');
  });

  it('DELETE resets to the default', async () => {
    await send(`${base()}/project/${solo}/layout`, 'PUT', { layout: mine });
    const res = await send(`${base()}/project/${solo}/layout`, 'DELETE');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { layout: builtinTemplates(false)[0].layout, source: 'default', template: 'Delivery lead' });
    const got = (await (await fetch(`${base()}/project/${solo}/layout`)).json()) as { source: string };
    assert.equal(got.source, 'default');
  });

  it('unknown project → 404 on every layout route', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await send(`${base()}/project/no-such/layout`, method, method === 'PUT' ? { layout: mine } : undefined);
      assert.equal(res.status, 404, method);
    }
  });

  it('GET /dashboard/templates lists builtins first; POST saves a validated user template', async () => {
    const before = (await (await fetch(`${base()}/dashboard/templates`)).json()) as { name: string; builtin: boolean }[];
    assert.deepEqual(
      before.map((t) => [t.name, t.builtin]),
      [
        ['Delivery lead', true],
        ['Exec roll-up', true],
        ['Agent ops', true],
      ],
    );
    const res = await send(`${base()}/dashboard/templates`, 'POST', { name: ' Mine ', layout: mine });
    assert.equal(res.status, 200);
    const saved = (await res.json()) as { id: string; name: string; builtin: boolean; layout: unknown };
    assert.deepEqual([saved.name, saved.builtin, saved.layout], ['Mine', false, mine]);
    const list = (await (await fetch(`${base()}/dashboard/templates`)).json()) as { id: string }[];
    assert.deepEqual(list.at(-1), saved);

    // ?project= picks the builtin variant for that board type
    const wsList = (await (await fetch(`${base()}/dashboard/templates?project=${workspace}`)).json()) as { layout: unknown }[];
    assert.deepEqual(wsList[0].layout, builtinTemplates(true)[0].layout);
  });

  it('POST /dashboard/templates rejects a missing name or invalid layout', async () => {
    assert.equal((await send(`${base()}/dashboard/templates`, 'POST', { layout: mine })).status, 400);
    const bad = await send(`${base()}/dashboard/templates`, 'POST', { name: 'x', layout: { version: 1, sections: 'no' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(((await bad.json()) as { errors: { path: string }[] }).errors.map((e) => e.path), ['sections']);
  });
});
