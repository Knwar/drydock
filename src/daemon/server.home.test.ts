import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// End-to-end coverage for GET /home: the Home view's single read (now building,
// up next, agents, verticals) merged with the in-memory session activity.

describe('daemon GET /home', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const post = (path: string, body: unknown) => send('POST', path, body);
  const project = async (root: string) => {
    mkdirSync(root, { recursive: true });
    const res = await fetch(`${base}/project?root=${encodeURIComponent(root)}`);
    return ((await res.json()) as { project_id: string }).project_id;
  };
  const task = async (project_id: string, title: string, extra: Record<string, unknown> = {}) => {
    const res = await post('/task', { project_id, title, ...extra });
    return ((await res.json()) as { task_id: string }).task_id;
  };
  const home = async (id: string) => {
    const res = await fetch(`${base}/home?project=${id}`);
    assert.equal(res.status, 200);
    return (await res.json()) as any;
  };

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
    assert.equal((await post('/team', { name: 'Ada', skill: 'frontend' })).status, 200);
    assert.equal((await post('/team', { name: 'Bob' })).status, 200);
  });

  after(async () => {
    await daemon?.stop();
  });

  it('standalone project: shape, main-session fallback activity, workspace null', async () => {
    const id = await project(join(daemon!.dbDir, 'solo'));
    const building = await task(id, 'Building');
    await send('PATCH', `/task/${building}`, { subtasks: ['first', 'second'] });
    await post(`/task/${building}/move`, { lane: 'in_progress' });
    const next = await task(id, 'Next up', { tag: 'api', depends_on: [building] });
    await post('/status', { project_id: id, agent: 'orchestrator', verb: 'Edit', detail: 'a.ts' });

    const h = await home(id);
    assert.deepEqual(h.project, { id, name: 'solo', parent_id: null });
    assert.equal(h.workspace, null);
    assert.deepEqual(h.verticals, []);
    assert.equal(h.now_building.length, 1);
    const nb = h.now_building[0];
    assert.equal(nb.id, building);
    assert.deepEqual(nb.board, { id, name: 'solo' });
    assert.deepEqual(nb.subtasks, { done: 0, total: 2 });
    assert.equal(nb.next_criterion, 'first');
    assert.equal(typeof nb.since, 'number');
    assert.equal(nb.blocked, false);
    // unassigned card, the board's only in_progress card → the main session's activity
    assert.equal(nb.activity, 'Edit a.ts');
    assert.deepEqual(h.up_next, {
      items: [
        {
          id: next,
          title: 'Next up',
          lane: 'backlog',
          tag: 'api',
          board: { id, name: 'solo' },
          ready: false,
          waiting_on: [{ id: building, title: 'Building', board_name: 'solo' }],
        },
      ],
      total_pending: 1,
    });
    assert.deepEqual(
      h.agents.map((a: any) => [a.name, a.skill, a.lines_added, a.hours, a.cards, a.now]),
      [
        ['Ada', 'frontend', 0, 0, 0, null],
        ['Bob', null, 0, 0, 0, null],
      ],
    );
  });

  it('workspace with 2 verticals: cross-board reads + agent activity from /status', async () => {
    const wsRoot = join(daemon!.dbDir, 'shop');
    const wsId = await project(wsRoot);
    const verticalIds: string[] = [];
    for (const name of ['mobile', 'web']) {
      mkdirSync(join(wsRoot, name), { recursive: true });
      const v = await post('/vertical', { workspace_id: wsId, name, root: join(wsRoot, name) });
      assert.equal(v.status, 200);
      verticalIds.push(((await v.json()) as { project_id: string }).project_id);
    }
    const [mobileId, webId] = verticalIds;
    const a = await task(mobileId, 'Mobile build');
    await send('PATCH', `/task/${a}`, { assigned_agent: 'Ada', worktree_path: '.trees/a', branch: 'card/a' });
    const q = await task(webId, 'Web queued');
    await post(`/task/${q}/move`, { lane: 'queued' });
    await task(wsId, 'Workspace backlog');
    // the real hook sends the agent TYPE plus the task_id it derived from the worktree cwd
    await post('/status', { project_id: mobileId, agent: 'builder', agent_id: 'x1', task_id: a, verb: 'Write', detail: 'app.tsx' });

    for (const id of [wsId, mobileId]) {
      const h = await home(id);
      assert.equal(h.workspace.workspace.id, wsId);
      assert.deepEqual(h.workspace.verticals.map((v: any) => v.id), verticalIds);
      assert.deepEqual(
        h.verticals.map((v: any) => v.project),
        [
          { id: wsId, name: 'shop' },
          { id: mobileId, name: 'mobile' },
          { id: webId, name: 'web' },
        ],
      );
      assert.equal(h.verticals[1].lanes.in_progress, 1);
      assert.equal(h.verticals[1].session.state, 'working');
      assert.equal(h.verticals[2].session.state, 'offline');
    }

    const h = await home(wsId);
    assert.deepEqual(h.project, { id: wsId, name: 'shop', parent_id: null });
    assert.equal(h.now_building.length, 1);
    assert.equal(h.now_building[0].agent, 'Ada');
    assert.deepEqual(h.now_building[0].board, { id: mobileId, name: 'mobile' });
    assert.equal(h.now_building[0].activity, 'Write app.tsx');
    assert.deepEqual(
      h.up_next.items.map((i: any) => [i.title, i.board.name]),
      [
        ['Web queued', 'web'],
        ['Workspace backlog', 'shop'],
      ],
    );
    assert.equal(h.up_next.total_pending, 2);
    const ada = h.agents.find((m: any) => m.name === 'Ada');
    const bob = h.agents.find((m: any) => m.name === 'Bob');
    assert.equal(ada.now, 'Write app.tsx');
    assert.equal(bob.now, null);

    // a vertical id scopes the board reads to that vertical
    const hv = await home(mobileId);
    assert.deepEqual(hv.project, { id: mobileId, name: 'mobile', parent_id: wsId });
    assert.equal(hv.up_next.total_pending, 0);
    assert.equal(hv.now_building.length, 1);
  });

  it('build runs credit the assigned member; live "now" follows the card across pings', async () => {
    const id = await project(join(daemon!.dbDir, 'attrib'));
    const card = await task(id, 'Assigned');
    await send('PATCH', `/task/${card}`, { assigned_agent: 'Ada', worktree_path: `.trees/${card}`, branch: `card/${card}` });
    const loose = await task(id, 'Unassigned');
    // the build hooks send the subagent TYPE as the agent
    await post('/event', { project_id: id, task_id: card, type: 'build_start', agent: 'builder' });
    assert.equal((await post(`/task/${card}/activity`, { agent: 'builder', role: 'builder', agent_id: 'b1', tokens: 10 })).status, 200);
    assert.equal((await post(`/task/${loose}/activity`, { agent: 'builder', agent_id: 'b2', tokens: 5 })).status, 200);

    const stats = (await (await fetch(`${base}/stats?project=${id}`)).json()) as any;
    assert.deepEqual(
      stats.agents.map((a: any) => [a.agent, a.cards, a.tokens]),
      [
        ['Ada', 1, 10],
        ['builder', 1, 5], // unassigned card falls back to the hook's agent
      ],
    );

    // first ping names the card; later pings (no .trees path in the tool input) don't
    await post('/status', { project_id: id, agent: 'builder', agent_id: 'b1', task_id: card, verb: 'started', detail: '' });
    await post('/status', { project_id: id, agent: 'builder', agent_id: 'b1', task_id: null, verb: 'running', detail: 'npm test' });
    let h = await home(id);
    const ada = h.agents.find((m: any) => m.name === 'Ada');
    assert.equal(ada.cards, 1);
    assert.equal(ada.now, 'running npm test');
    assert.equal(h.agents.find((m: any) => m.name === 'Bob').now, null);
    assert.equal(h.now_building.find((c: any) => c.id === card).activity, 'running npm test');

    // the subagent finishing clears it
    await post('/status', { project_id: id, agent: 'builder', agent_id: 'b1', verb: 'finished', detail: '' });
    h = await home(id);
    assert.equal(h.agents.find((m: any) => m.name === 'Ada').now, null);
  });

  it('unknown id → 404, missing param → 400', async () => {
    const res = await fetch(`${base}/home?project=does-not-exist`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'unknown project' });
    assert.equal((await fetch(`${base}/home`)).status, 400);
  });
});
