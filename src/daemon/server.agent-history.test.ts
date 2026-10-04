import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { agentHistory } from '../core/agent-history.js';
import { openDb, type DB } from '../core/db.js';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// GET /agents/:name/history against the REAL daemon (temp DB, random port). History is seeded
// through the API, then its timestamps are moved into two back-to-back 7-day windows.

const H = 3_600_000;
const D = 24 * H;
const M = 1_000_000;
const ADA = 'Ada Lovelace';

describe('daemon GET /agents/:name/history', () => {
  let daemon: TestDaemon | undefined;
  let db: DB | undefined;
  let base: string;
  let pid: string;
  let cur: string;
  let prev: string;
  let other: string;
  // current window C = [T0, T0 + 7d - 1], previous P = [T0 - 7d, T0 - 1]
  const today = new Date();
  const T0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 14 * D;
  const C = { from: T0, to: T0 + 7 * D - 1 };
  const P = { from: T0 - 7 * D, to: T0 - 1 };
  const STARTED = Date.now() - 60_000;

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await send(method, path, body);
    const b = (await r.json()) as any;
    assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(b)}`);
    return b;
  };
  const get = (path: string) => ok('GET', path);
  const status = async (path: string) => {
    const r = await send('GET', path);
    return { status: r.status, body: (await r.json()) as any };
  };
  const win = (w: { from: number; to: number }) => `from=${w.from}&to=${w.to}`;
  const hist = (name: string, q = '') => `/agents/${encodeURIComponent(name)}/history?project=${pid}&tz=UTC${q ? `&${q}` : ''}`;

  /** Run a card action, then move the events it logged (and the card's times) to `t`. */
  const at = async (id: string, t: number, action: () => Promise<unknown>) => {
    await action();
    db!.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ? AND created_at > ?').run(t, id, STARTED);
    db!.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(t, id);
  };
  const create = async (title: string, t: number) => {
    const id = (await ok('POST', '/task', { project_id: pid, title })).task_id as string;
    db!.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(t, id);
    db!.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(t, t, id);
    return id;
  };
  const assign = (id: string, agent: string, t: number) =>
    at(id, t, () => ok('PATCH', `/task/${id}`, { assigned_agent: agent, worktree_path: `.trees/${id}`, branch: `card/${id}` }));
  const move = (id: string, lane: string, t: number) => at(id, t, () => ok('POST', `/task/${id}/move`, { lane }));
  const review = (id: string, verdict: string, t: number) => at(id, t, () => ok('POST', `/task/${id}/review`, { verdict }));
  const spend = async (id: string, input: number, t: number) => {
    await ok('POST', `/task/${id}/activity`, { agent: 'builder', usage: { 'model-x': { input } } });
    db!.prepare('UPDATE card_activity SET created_at = ? WHERE task_id = ? AND created_at > ?').run(t, id, STARTED);
  };
  /** A card Ada builds start to finish: assigned at `t`, reviewed + done a day later; spends `input` tokens. */
  const build = async (title: string, agent: string, t: number, input: number) => {
    const id = await create(title, t - H);
    await assign(id, agent, t);
    await spend(id, input, t + H);
    await move(id, 'in_review', t + 2 * H);
    await review(id, 'pass', t + 3 * H);
    await move(id, 'done', t + D);
    return id;
  };

  before(async () => {
    daemon = await startDaemon({ env: { KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    base = daemon.base;
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    pid = (await get(`/project?root=${encodeURIComponent(root)}`)).project_id;
    db = openDb(join(daemon.dbDir, 'board.db'));
    await ok('PUT', '/settings/prices', { models: {}, default: { input: 1, output: 1, cache_read: 1, cache_creation: 1 } });
    await ok('POST', '/team', { name: ADA });
    await ok('POST', '/team', { name: 'Bob' });

    prev = await build('prev', ADA, T0 - 5 * D, M); // $1, in P
    cur = await build('cur', ADA, T0 + 2 * D, 2 * M); // $2, in C
    other = await build('other', 'Bob', T0 + 2 * D, 5 * M); // Bob's $5, never Ada's
  });

  after(async () => {
    db?.close();
    await daemon?.stop();
  });

  it("all time: the agent's cards, runs and totals (a URL-encoded name with spaces)", async () => {
    const r = await get(hist(ADA));
    assert.equal(r.agent, ADA);
    assert.deepEqual(r.cards.map((c: any) => c.id).sort(), [cur, prev].sort());
    assert.ok(!r.cards.some((c: any) => c.id === other));
    assert.equal(r.runs.length, 2);
    assert.equal(r.totals.cardsDone, 2);
    assert.equal(r.totals.cost, 3);
    assert.equal(r.totals.tokens, 3 * M);
    assert.equal(r.totals.firstPassRate, 1);
    assert.ok(!('previous' in r) && !('window' in r), 'no compare block without compare');
    // matches the core call for the same scope
    const direct = agentHistory(db!, { projectIds: [pid], agent: ADA, tz: 'UTC' });
    assert.deepEqual(r.totals, direct.totals);
  });

  it('range filtering: only the window\'s cards and runs', async () => {
    const c = await get(hist(ADA, win(C)));
    assert.deepEqual(c.cards.map((x: any) => x.id), [cur]);
    assert.deepEqual(c.runs.map((x: any) => x.task_id), [cur]);
    assert.deepEqual([c.totals.cardsDone, c.totals.cost], [1, 2]);
    const p = await get(hist(ADA, win(P)));
    assert.deepEqual(p.cards.map((x: any) => x.id), [prev]);
    assert.deepEqual([p.totals.cardsDone, p.totals.cost], [1, 1]);
    // YYYY-MM-DD bounds parse like the metrics routes
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const d = await get(hist(ADA, `from=${day(C.from)}&to=${day(C.to)}`));
    assert.deepEqual(d.totals, c.totals);
  });

  it('compare=previous: previous totals only, plus window + previousWindow', async () => {
    const r = await get(hist(ADA, `${win(C)}&compare=previous`));
    assert.deepEqual(r.window, C);
    assert.deepEqual(r.previousWindow, P);
    const direct = agentHistory(db!, { projectIds: [pid], agent: ADA, tz: 'UTC', from: P.from, to: P.to });
    assert.deepEqual(r.previous, direct.totals);
    assert.equal(r.previous.cost, 1);
    assert.ok(!('cards' in r.previous) && !('runs' in r.previous), 'never the cards or runs arrays');
    // the current result is the plain one
    const plain = await get(hist(ADA, win(C)));
    const { previous, window, previousWindow, ...rest } = r;
    assert.deepEqual(rest, plain);
    // all time: nothing to compare against
    const all = await get(hist(ADA, 'compare=previous'));
    assert.equal(all.previous, null);
    assert.equal(all.window, null);
  });

  it('an off-roster name returns a valid, empty history', async () => {
    const r = await get(hist('Nobody Here', win(C)));
    assert.equal(r.agent, 'Nobody Here');
    assert.deepEqual(r.cards, []);
    assert.deepEqual(r.runs, []);
    assert.equal(r.totals.cardsDone, 0);
    assert.equal(r.totals.cost, 0);
  });

  it('unknown project 404, missing project 400, bad params 400', async () => {
    assert.equal((await status(`/agents/Bob/history?project=nope`)).status, 404);
    assert.equal((await status(`/agents/Bob/history`)).status, 400);
    for (const q of ['from=garbage', 'to=2026-13-45', 'tz=Not/AZone', `${win(C)}&compare=bogus`, `from=${C.to}&to=${C.from}`]) {
      const r = await status(`/agents/Bob/history?project=${pid}&${q}`);
      assert.equal(r.status, 400, `${q}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await status(`/agents/%E0%A4%A/history?project=${pid}`)).status, 400, 'malformed encoding');
  });
});
