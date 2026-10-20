import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { startDaemon, type TestDaemon, wsAuth } from './test-daemon.js';

// /decisions + /risks routes against the REAL daemon (temp DB, random port).

describe('/decisions + /risks routes', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  let wsId: string;
  let webId: string;
  let cardId: string;

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ok = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await send(method, path, body);
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as T;
  };

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
    const root = join(daemon.dbDir, 'shop');
    mkdirSync(join(root, 'web'), { recursive: true });
    wsId = ((await (await fetch(`${base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string })
      .project_id;
    webId = (await ok<{ project_id: string }>('POST', '/vertical', { workspace_id: wsId, name: 'web', root: join(root, 'web') }))
      .project_id;
    cardId = (await ok<{ task_id: string }>('POST', '/task', { project_id: webId, title: 'Checkout' })).task_id;
  });

  after(async () => {
    await daemon?.stop();
  });

  it('decisions: create → patch links → list with filters → supersede', async () => {
    const d = await ok<{ id: string; status: string; links: unknown[] }>('POST', '/decisions', {
      project_id: webId,
      title: 'Autopilot skips Main',
      decision: 'never prompt the workspace session',
      rationale: 'the human sits there',
      decided_by: 'user',
    });
    assert.equal(d.status, 'active');
    const patched = await ok<{ links: unknown[] }>('PATCH', `/decisions/${d.id}`, {
      link: [{ target_type: 'card', target_id: cardId }],
    });
    assert.deepEqual(patched.links, [{ target_type: 'card', target_id: cardId }]);

    const list = await ok<{ id: string }[]>('GET', `/decisions?project=${wsId}&card=${cardId}&q=HUMAN&status=active`);
    assert.deepEqual(list.map((x) => x.id), [d.id], 'workspace lists its verticals’ decisions');
    assert.deepEqual(await ok('GET', `/decisions?project=${wsId}&q=nothing-matches`), []);

    const sup = await ok<{ superseded: { status: string; superseded_by: string }; decision: { id: string; links: unknown[] } }>(
      'POST',
      `/decisions/${d.id}/supersede`,
      { title: 'Autopilot may prompt Main', decision: 'opt-in per workspace' },
    );
    assert.equal(sup.superseded.status, 'superseded');
    assert.equal(sup.superseded.superseded_by, sup.decision.id);
    assert.deepEqual(sup.decision.links, [{ target_type: 'card', target_id: cardId }]);
  });

  it('risks: create → patch → list sorted by score', async () => {
    const low = await ok<{ id: string; score: number }>('POST', '/risks', {
      project_id: wsId,
      title: 'Low',
      likelihood: 1,
      impact: 2,
    });
    const high = await ok<{ id: string; score: number }>('POST', '/risks', {
      project_id: webId,
      title: 'High',
      likelihood: 4,
      impact: 5,
    });
    assert.equal(high.score, 20);
    const closed = await ok<{ status: string; closed_at: number | null }>('PATCH', `/risks/${low.id}`, {
      status: 'closed',
      mitigation: 'done',
    });
    assert.equal(closed.status, 'closed');
    assert.ok(closed.closed_at);
    const all = await ok<{ id: string }[]>('GET', `/risks?project=${wsId}`);
    assert.deepEqual(
      all.filter((r) => [low.id, high.id].includes(r.id)).map((r) => r.id),
      [high.id, low.id],
    );
    const open = await ok<{ id: string }[]>('GET', `/risks?project=${wsId}&status=open`);
    assert.ok(!open.some((r) => r.id === low.id));
  });

  it('validation → 400, unknown → 404', async () => {
    assert.equal((await send('GET', '/decisions')).status, 400);
    assert.equal((await send('GET', `/decisions?project=${wsId}&status=bogus`)).status, 400);
    assert.equal((await send('GET', '/risks?project=nope')).status, 404);
    assert.equal((await send('POST', '/decisions', { project_id: wsId, title: 'no decision' })).status, 400);
    assert.equal((await send('POST', '/decisions', { project_id: 'nope', title: 't', decision: 'd' })).status, 404);
    assert.equal((await send('POST', '/risks', { project_id: wsId, title: 't', likelihood: 9, impact: 1 })).status, 400);
    assert.equal((await send('PATCH', '/decisions/nope', { title: 'x' })).status, 404);
    assert.equal((await send('PATCH', '/risks/nope', { title: 'x' })).status, 404);
    assert.equal((await send('POST', '/decisions/nope/supersede', { title: 't', decision: 'd' })).status, 404);
    const d = await ok<{ id: string }>('POST', '/decisions', { project_id: wsId, title: 't', decision: 'd' });
    const bad = await send('PATCH', `/decisions/${d.id}`, { link: [{ target_type: 'card', target_id: 'nope' }] });
    assert.equal(bad.status, 404);
    assert.equal((await send('PATCH', `/decisions/${d.id}`, { link: [{ target_type: 'bogus', target_id: 'x' }] })).status, 400);
    assert.equal((await send('POST', `/risks/${d.id}/supersede`, {})).status, 404);
  });

  it('a vertical lists its workspace’s items with scope markers', async () => {
    const w = await ok<{ id: string }>('POST', '/decisions', { project_id: wsId, title: 'ws-scope', decision: 'd' });
    const v = await ok<{ id: string }>('POST', '/decisions', { project_id: webId, title: 'web-scope', decision: 'd' });
    const fromWeb = await ok<{ id: string; scope: string }[]>('GET', `/decisions?project=${webId}&q=-scope`);
    assert.deepEqual(fromWeb.map((d) => [d.id, d.scope]).sort(), [[v.id, 'own'], [w.id, 'workspace']].sort());
    const fromWs = await ok<{ id: string; scope: string }[]>('GET', `/decisions?project=${wsId}&q=-scope`);
    assert.deepEqual(fromWs.map((d) => [d.id, d.scope]).sort(), [[v.id, 'vertical'], [w.id, 'own']].sort());
  });

  it('a WS client on a vertical receives governance for a workspace-level write', async () => {
    const sock = new WebSocket(...wsAuth(`ws://127.0.0.1:${daemon!.port}/ws?project=${webId}`));
    const seen: any[] = [];
    sock.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    await new Promise((r) => sock.once('open', r));
    try {
      const d = await ok<{ id: string }>('POST', '/decisions', { project_id: wsId, title: 'fan-out', decision: 'd' });
      const deadline = Date.now() + 5000;
      while (!seen.some((m) => m.type === 'governance' && m.id === d.id) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(
        seen.find((m) => m.type === 'governance' && m.id === d.id),
        { type: 'governance', kind: 'decision', id: d.id, project_id: wsId },
      );
    } finally {
      sock.terminate();
    }
  });

  it('a WS client on the workspace receives governance for a vertical’s write', async () => {
    const sock = new WebSocket(...wsAuth(`ws://127.0.0.1:${daemon!.port}/ws?project=${wsId}`));
    const seen: any[] = [];
    const waitFor = (pred: (m: any) => boolean) =>
      new Promise<any>((resolve) => {
        const check = () => {
          const m = seen.find(pred);
          if (m) resolve(m);
          else setTimeout(check, 10);
        };
        check();
      });
    sock.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    await new Promise((r) => sock.once('open', r));
    try {
      await waitFor((m) => m.type === 'init');
      const r = await ok<{ id: string }>('POST', '/risks', { project_id: webId, title: 'WS', likelihood: 2, impact: 2 });
      assert.deepEqual(await waitFor((m) => m.type === 'governance' && m.id === r.id), {
        type: 'governance',
        kind: 'risk',
        id: r.id,
        project_id: webId,
      });
      const d = await ok<{ id: string }>('POST', '/decisions', { project_id: wsId, title: 't', decision: 'd' });
      assert.deepEqual(await waitFor((m) => m.type === 'governance' && m.id === d.id), {
        type: 'governance',
        kind: 'decision',
        id: d.id,
        project_id: wsId,
      });
    } finally {
      sock.terminate();
    }
  });
});

function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

describe('/decisions + /risks writes are loopback-only', () => {
  let daemon: TestDaemon | undefined;

  before(async () => {
    daemon = await startDaemon({ env: { HOST: '0.0.0.0' } });
  });

  after(async () => {
    await daemon?.stop();
  });

  it('a device on the network without a token is refused (401), reads too', async (t) => {
    const ip = nonLoopbackIPv4();
    if (!ip) return t.skip('no non-loopback IPv4 interface on this host');
    const lan = `http://${ip}:${daemon!.port}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${lan}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call('POST', '/decisions', { project_id: 'a', title: 't', decision: 'd' })).status, 401);
    assert.equal((await call('PATCH', '/decisions/any', { title: 'x' })).status, 401);
    assert.equal((await call('POST', '/decisions/any/supersede', {})).status, 401);
    assert.equal((await call('POST', '/risks', { project_id: 'a' })).status, 401);
    assert.equal((await call('PATCH', '/risks/any', {})).status, 401);
    assert.equal((await call('GET', '/decisions?project=nope')).status, 401);
  });
});
