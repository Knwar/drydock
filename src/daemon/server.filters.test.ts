import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// End-to-end coverage for the dashboard / Home filters (scope, phase, tag, agent, from / to on
// when a done card entered done) on GET /workspace/summary and GET /home, and for
// GET /workspace/cards (the matching cards + the filter options, one read for the workspace).

describe('daemon dashboard / Home filters', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  const send = async (method: string, path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json()) as any;
    assert.equal(res.status, 200, `${method} ${path}: ${JSON.stringify(json)}`);
    return json;
  };
  const post = (path: string, body: unknown) => send('POST', path, body);
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    const json = (await res.json()) as any;
    assert.equal(res.status, 200, `GET ${path}: ${JSON.stringify(json)}`);
    return json;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let ws: string, web: string, api: string;
  const ph: Record<string, string> = {};
  const c: Record<string, string> = {};
  let doneAt: number; // after webDone entered done, before its later edit

  const card = async (key: string, project_id: string, opts: { phase?: string; tag?: string; agent?: string; lane?: string; spec?: boolean; deps?: string[] }) => {
    const { task_id } = await post('/task', {
      project_id,
      title: key,
      tag: opts.tag,
      phase_id: opts.phase,
      depends_on: opts.deps,
      requirements: opts.spec === false ? undefined : 'spec',
    });
    if (opts.agent) await send('PATCH', `/task/${task_id}`, { assigned_agent: opts.agent, worktree_path: `.trees/${task_id}`, branch: `card/${task_id}` });
    if (opts.lane && opts.lane !== 'backlog') await post(`/task/${task_id}/move`, { lane: opts.lane });
    c[key] = task_id;
    return task_id;
  };
  const byId = (list: any[]) => list.map((x) => x.id);
  const titles = (list: any[]) => list.map((x) => x.title);
  const board = (sum: any, id: string) => sum.boards.find((b: any) => b.project.id === id);
  const lanes = (backlog: number, queued: number, in_progress: number, in_review: number, done: number) => ({ backlog, queued, in_progress, in_review, done });

  before(async () => {
    daemon = await startDaemon();
    base = daemon.base;
    await post('/team', { name: 'Ada' });
    await post('/team', { name: 'Bob' });
    const root = join(daemon.dbDir, 'shop');
    for (const d of ['web', 'api']) mkdirSync(join(root, d), { recursive: true });
    ws = ((await get(`/project?root=${encodeURIComponent(root)}`)) as any).project_id;
    web = (await post('/vertical', { workspace_id: ws, name: 'web', root: join(root, 'web') })).project_id;
    api = (await post('/vertical', { workspace_id: ws, name: 'api', root: join(root, 'api') })).project_id;
    ph.w1 = (await post('/phase', { project_id: web, title: 'W1' })).phase_id;
    ph.w2 = (await post('/phase', { project_id: web, title: 'W2' })).phase_id;
    ph.a1 = (await post('/phase', { project_id: api, title: 'A1' })).phase_id;
    await post('/phase/advance', { project_id: web }); // W1 active
    await post('/phase/advance', { project_id: api }); // A1 active

    await card('webProg', web, { phase: ph.w1, tag: 'ui', agent: 'Ada', lane: 'in_progress' });
    await card('webQueued', web, { phase: ph.w1, tag: 'ui', agent: 'Bob', lane: 'queued' });
    await card('webBack1', web, { phase: ph.w1, tag: 'ui' });
    await card('webBack2', web, { phase: ph.w2, tag: 'db' });
    await card('webDone', web, { phase: ph.w1, tag: 'ui', agent: 'Ada', lane: 'done' });
    await card('apiProg', api, { phase: ph.a1, tag: 'db', agent: 'Bob', lane: 'in_progress' });
    await post(`/task/${c.apiProg}/block`, { reason: 'Which provider?' });
    await card('apiBack', api, { phase: ph.a1, tag: 'db', deps: [c.apiProg] });
    await card('apiDone', api, { phase: ph.a1, tag: 'db', agent: 'Bob', lane: 'done' });
    await card('wsBack', ws, { tag: 'ui', spec: false }); // no spec → a Needs-you item
    await sleep(30);
    doneAt = Date.now();
    await sleep(30);
    await send('PATCH', `/task/${c.webDone}`, { requirements: 'edited' }); // updated_at moves past doneAt; entering done doesn't
  });

  after(async () => {
    await daemon?.stop();
  });

  const summary = (q = '') => get(`/workspace/summary?project=${ws}${q}`);

  it('/workspace/summary unfiltered: every board shown, the plain counts', async () => {
    const s = await summary();
    assert.deepEqual(s.boards.map((b: any) => b.shown), [true, true, true]);
    assert.deepEqual(board(s, web).lanes, lanes(2, 1, 1, 0, 1));
    assert.deepEqual(board(s, api).lanes, lanes(1, 0, 1, 0, 1));
    assert.deepEqual(board(s, web).phase, { id: ph.w1, title: 'W1', done: 1, total: 4 });
    assert.deepEqual(titles(s.attention).sort(), ['apiProg', 'wsBack']);
  });

  it('/workspace/summary tag: lane counts, in-flight cards and Needs you', async () => {
    const s = await summary('&tag=ui');
    assert.deepEqual(s.boards.map((b: any) => b.shown), [true, true, true]); // a tag hides no board
    assert.deepEqual(board(s, ws).lanes, lanes(1, 0, 0, 0, 0));
    assert.deepEqual(board(s, web).lanes, lanes(1, 1, 1, 0, 1));
    assert.deepEqual(board(s, api).lanes, lanes(0, 0, 0, 0, 0));
    assert.deepEqual(byId(board(s, web).active), [c.webProg]);
    assert.deepEqual(board(s, api).active, []);
    assert.deepEqual(titles(s.attention), ['wsBack']); // the blocked db card is filtered out
    assert.deepEqual(board(s, web).phase, { id: ph.w1, title: 'W1', done: 1, total: 4 }); // every W1 card is ui
  });

  it('/workspace/summary agent: counts, in-flight, Needs you by the card\'s agent', async () => {
    const s = await summary('&agent=Bob');
    assert.deepEqual(board(s, web).lanes, lanes(0, 1, 0, 0, 0));
    assert.deepEqual(board(s, api).lanes, lanes(0, 0, 1, 0, 1));
    assert.deepEqual(byId(board(s, api).active), [c.apiProg]);
    assert.deepEqual(titles(s.attention), ['apiProg']);
    assert.deepEqual(board(s, web).phase, { id: ph.w1, title: 'W1', done: 0, total: 1 }); // the phase bar under the agent
  });

  it('/workspace/summary phase: only its board shows; the phase bar is that phase', async () => {
    const s = await summary(`&phase=${ph.w2}`);
    assert.deepEqual(s.boards.map((b: any) => [b.project.id, b.shown]), [[ws, false], [web, true], [api, false]]);
    assert.deepEqual(board(s, web).lanes, lanes(1, 0, 0, 0, 0));
    assert.deepEqual(board(s, web).phase, { id: ph.w2, title: 'W2', done: 0, total: 1 });
    assert.deepEqual(board(s, api).phase, null); // not its phase
    assert.deepEqual(s.attention, []);
  });

  it('/workspace/summary scope: a vertical → only it shows, only its Needs you; the workspace id → all', async () => {
    const s = await summary(`&scope=${api}`);
    assert.deepEqual(s.boards.map((b: any) => b.shown), [false, false, true]);
    assert.deepEqual(titles(s.attention), ['apiProg']);
    const all = await summary(`&scope=${ws}`);
    assert.deepEqual(all.boards.map((b: any) => b.shown), [true, true, true]);
    assert.equal(all.attention.length, 2);
  });

  it('/workspace/summary from / to: bound done cards by when they entered done (not their last edit)', async () => {
    const future = await summary(`&from=${Date.now() + 3_600_000}`);
    assert.equal(board(future, web).lanes.done, 0);
    assert.equal(board(future, web).lanes.backlog, 2); // open cards are never range-filtered
    const upToDone = await summary(`&to=${doneAt}`);
    assert.equal(board(upToDone, web).lanes.done, 1, 'entered done before doneAt, edited after');
    assert.equal(board(await summary(`&from=${doneAt}`), web).lanes.done, 0);
    // a day key in a time zone works too
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    assert.equal(board(await summary(`&from=${today}&tz=UTC`), web).lanes.done, 1);
    const bad = await fetch(`${base}/workspace/summary?project=${ws}&from=nope`);
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as any).error, /invalid from/);
  });

  const home = (project: string, q = '') => get(`/home?project=${project}${q}`);

  it('/home tag: now building, up next (readiness from depends_on), agents, verticals', async () => {
    const h = await home(ws, '&tag=db');
    assert.deepEqual(byId(h.now_building), [c.apiProg]);
    // web's db card is in W2, not the active W1: not pickable; api's waits on apiProg
    assert.deepEqual(h.up_next.items.map((i: any) => [i.id, i.ready, i.waiting_on.map((w: any) => w.id)]), [[c.apiBack, false, [c.apiProg]]]);
    assert.equal(h.up_next.total_pending, 1);
    assert.deepEqual(h.agents.map((m: any) => m.name), ['Bob']);
    assert.deepEqual(h.verticals.map((v: any) => [v.project.name, v.shown, v.lanes]), [
      ['shop', true, lanes(0, 0, 0, 0, 0)],
      ['web', true, lanes(1, 0, 0, 0, 0)],
      ['api', true, lanes(1, 0, 1, 0, 1)],
    ]);
  });

  it('/home phase: Up next picks that phase\'s backlog; only its board shows', async () => {
    const h = await home(ws, `&phase=${ph.w2}`);
    assert.deepEqual(h.up_next.items.map((i: any) => [i.id, i.ready]), [[c.webBack2, true]]);
    assert.equal(h.up_next.total_pending, 1);
    assert.deepEqual(h.now_building, []);
    assert.deepEqual(h.verticals.map((v: any) => v.shown), [false, true, false]);
    assert.deepEqual(h.agents, []); // no assigned card in W2
    // unfiltered: queued first, then the active phases' backlogs round-robin
    const all = await home(ws);
    assert.deepEqual(byId(all.up_next.items), [c.webQueued, c.wsBack, c.webBack1]);
    assert.equal(all.up_next.total_pending, 4);
  });

  it('/home agent + scope: just them; a vertical scope narrows every list', async () => {
    const h = await home(ws, '&agent=Ada');
    assert.deepEqual(h.agents.map((m: any) => m.name), ['Ada']);
    assert.deepEqual(byId(h.now_building), [c.webProg]);
    assert.deepEqual(h.up_next.items, []);
    const scoped = await home(ws, `&scope=${api}`);
    assert.deepEqual(byId(scoped.now_building), [c.apiProg]);
    assert.deepEqual(byId(scoped.up_next.items), [c.apiBack]);
    assert.deepEqual(scoped.agents.map((m: any) => m.name), ['Bob']);
    assert.deepEqual(scoped.verticals.map((v: any) => v.shown), [false, false, true]);
  });

  it('/home on a vertical: scoped to it by default; filters apply within', async () => {
    const h = await home(web);
    assert.deepEqual(h.verticals.map((v: any) => v.shown), [false, true, false]);
    assert.deepEqual(h.agents.map((m: any) => m.name).sort(), ['Ada', 'Bob']); // its own scope: not narrowed
    const tagged = await home(web, '&tag=ui&agent=Ada');
    assert.deepEqual(byId(tagged.now_building), [c.webProg]);
    assert.deepEqual(tagged.verticals.find((v: any) => v.project.id === web).lanes, lanes(0, 0, 1, 0, 1));
    assert.equal((await fetch(`${base}/home?project=${web}&to=bad`)).status, 400);
  });

  it('/workspace/cards: the matching cards across the workspace + the whole workspace\'s options', async () => {
    const all = await get(`/workspace/cards?project=${ws}`);
    assert.equal(all.workspace_id, ws);
    assert.deepEqual(all.boards, [
      { id: ws, name: 'shop' },
      { id: web, name: 'web' },
      { id: api, name: 'api' },
    ]);
    assert.equal(all.cards.length, 9); // a workspace id covers its verticals
    assert.deepEqual(all.phases.map((p: any) => [p.id, p.board, p.status]), [
      [ph.w1, web, 'active'],
      [ph.w2, web, 'planned'],
      [ph.a1, api, 'active'],
    ]);
    assert.deepEqual(all.tags, ['db', 'ui']);
    assert.deepEqual(all.agents, ['Ada', 'Bob']);
    const done = all.cards.find((x: any) => x.id === c.webDone);
    assert.deepEqual(Object.keys(done).sort(), ['agent', 'blocked', 'board', 'id', 'lane', 'lane_since', 'phase_id', 'tag', 'title']);
    assert.ok(done.lane_since <= doneAt, 'a done card\'s lane_since: when it entered done');
    assert.equal(all.cards.find((x: any) => x.id === c.apiProg).blocked, true);

    const f = await get(`/workspace/cards?project=${ws}&tag=ui&scope=${web}`);
    assert.deepEqual(f.cards.map((x: any) => x.id).sort(), [c.webBack1, c.webDone, c.webProg, c.webQueued].sort());
    assert.deepEqual(f.tags, ['db', 'ui'], 'options stay the whole workspace\'s');
    assert.deepEqual((await get(`/workspace/cards?project=${ws}&agent=Bob&from=${doneAt}`)).cards.map((x: any) => x.id).sort(), [c.apiProg, c.webQueued].sort());
    assert.deepEqual((await get(`/workspace/cards?project=${ws}&phase=${ph.a1}`)).cards.map((x: any) => x.id).sort(), [c.apiBack, c.apiDone, c.apiProg].sort());

    // a vertical id → its own cards; the options still cover the workspace
    const v = await get(`/workspace/cards?project=${api}`);
    assert.ok(v.cards.every((x: any) => x.board === api) && v.cards.length === 3);
    assert.equal(v.phases.length, 3);
    assert.equal((await fetch(`${base}/workspace/cards?project=nope`)).status, 404);
    assert.equal((await fetch(`${base}/workspace/cards`)).status, 400);
  });
});
