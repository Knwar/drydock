import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../core/db.js';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// Cost routes against the REAL daemon (temp DB, random port): the activity
// route's token breakdown, /settings/prices, /metrics/cost, phase budgets and
// /metrics/usage-burn. Bound on all interfaces so the loopback gates can be hit
// from a LAN address.

function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

const M = 1_000_000;
const PRICES = {
  models: { 'claude-opus-5-5': { input: 10, output: 50, cache_read: 1, cache_creation: 12 } },
  default: { input: 100, output: 100, cache_read: 100, cache_creation: 100 },
};

describe('daemon cost routes', () => {
  let daemon: TestDaemon | undefined;
  let base: string;
  let pid: string;
  let phaseId: string;
  let cardA: string;
  let cardB: string;

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (res: Response | Promise<Response>) => {
    const r = await res;
    return { status: r.status, body: (await r.json()) as any };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await json(send(method, path, body));
    assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  before(async () => {
    daemon = await startDaemon({ env: { HOST: '0.0.0.0', KANKAN_DISPATCHER: '0', KANKAN_TERMINAL: '0' } });
    base = daemon.base;
    const root = join(daemon.dbDir, 'app');
    mkdirSync(root, { recursive: true });
    pid = (await ok('GET', `/project?root=${encodeURIComponent(root)}`)).project_id;
    phaseId = (await ok('POST', '/phase', { project_id: pid, title: 'P1' })).phase_id;
    cardA = (await ok('POST', '/task', { project_id: pid, title: 'a', phase_id: phaseId })).task_id;
    cardB = (await ok('POST', '/task', { project_id: pid, title: 'b', phase_id: phaseId })).task_id;
  });

  after(async () => {
    await daemon?.stop();
  });

  it('prices: placeholder defaults; PUT validates and replaces', async () => {
    const d = await ok('GET', '/settings/prices');
    assert.equal(d.placeholder, true);
    assert.match(d.note, /set your rates/);
    assert.equal((await send('PUT', '/settings/prices', { models: {}, default: { input: -1 } })).status, 400);
    assert.equal((await send('PUT', '/settings/prices', { models: 'x', default: PRICES.default })).status, 400);
    assert.equal((await send('PUT', '/settings/prices', { ...PRICES, bogus: 1 })).status, 400);
    const set = await ok('PUT', '/settings/prices', PRICES);
    assert.equal(set.placeholder, false);
    assert.deepEqual((await ok('GET', '/settings/prices')).models, PRICES.models);
  });

  it('activity: accepts the per-model breakdown and old tokens-only payloads; rejects a bad breakdown', async () => {
    await ok('POST', `/task/${cardA}/activity`, {
      agent: 'builder',
      tokens: 13 * M,
      tokens_out: M,
      usage: { 'claude-opus-5-5': { input: M, output: M, cache_read: 10 * M, cache_creation: M } }, // 82
    });
    await ok('POST', `/task/${cardB}/activity`, { agent: 'builder', usage: { 'mystery-1': { input: M } } }); // 100, tokens derived
    await ok('POST', `/task/${cardA}/activity`, { agent: 'builder', tokens: 3 * M, tokens_out: M }); // old hook: estimated 2 + 50
    const bad = await json(send('POST', `/task/${cardA}/activity`, { tokens: 1, usage: { m: { input: -5 } } }));
    assert.equal(bad.status, 400);
    const db = openDb(join(daemon!.dbDir, 'board.db'));
    try {
      const rows = db.prepare('SELECT task_id, tokens, tokens_out, usage, cost_estimated FROM card_activity ORDER BY id').all() as any[];
      assert.equal(rows.length, 3, 'the rejected payload recorded nothing');
      assert.deepEqual(JSON.parse(rows[0].usage), { 'claude-opus-5-5': { input: M, output: M, cache_read: 10 * M, cache_creation: M } });
      assert.equal(rows[0].cost_estimated, 0);
      assert.deepEqual([rows[1].tokens, rows[1].tokens_out, rows[1].cost_estimated], [M, 0, 0]);
      assert.deepEqual([rows[2].usage, rows[2].cost_estimated], [null, 1]);
    } finally {
      db.close();
    }
  });

  it('/metrics/cost: totals, estimated share, breakdowns; 400/404', async () => {
    const m = await ok('GET', `/metrics/cost?project=${pid}&tz=UTC`);
    assert.deepEqual(m.totals, { cost: 234, tokens: 17 * M, runs: 3, cards: 2 });
    assert.equal(m.estimated.cost, 52);
    assert.equal(m.estimated.share, Math.round((52 / 234) * 1e6) / 1e6);
    assert.deepEqual(m.unknownModels, [{ model: 'mystery-1', tokens: M, cost: 100 }]);
    assert.deepEqual(m.byPhase.map((p: any) => [p.phase_id, p.cost]), [[phaseId, 234]]);
    assert.deepEqual(m.byCard.map((c: any) => [c.id, c.cost, c.estimated]), [[cardA, 134, true], [cardB, 100, false]]);
    assert.equal(m.byBoard[0].project_id, pid);
    assert.equal(m.byAgent.length, 1);
    assert.ok(m.weekly.length >= 1);
    assert.deepEqual(m.byPlan, []);
    assert.equal((await ok('GET', `/metrics/cost?project=${pid}&limit=1`)).byCard.length, 1);
    assert.equal((await ok('GET', `/metrics/cost?project=${pid}&to=2000-01-01`)).totals.cost, 0);
    assert.equal((await send('GET', `/metrics/cost?project=${pid}&from=2999-01-01`)).status, 400); // from after to (now)
    assert.equal((await send('GET', '/metrics/cost')).status, 400);
    assert.equal((await send('GET', '/metrics/cost?project=nope')).status, 404);
    assert.equal((await send('GET', `/metrics/cost?project=${pid}&limit=0`)).status, 400);
    assert.equal((await send('GET', `/metrics/cost?project=${pid}&from=garbage`)).status, 400);
    assert.equal((await send('GET', `/metrics/cost?project=${pid}&tz=Nowhere/City`)).status, 400);
  });

  it('budgets: PUT /phase/:id/budget; planned vs actual in /metrics/cost', async () => {
    const phase = await ok('PUT', `/phase/${phaseId}/budget`, { budget_usd: 500 });
    assert.equal(phase.budget_usd, 500);
    assert.equal((await send('PUT', `/phase/${phaseId}/budget`, { budget_usd: -3 })).status, 400);
    assert.equal((await send('PUT', `/phase/${phaseId}/budget`, { budget_usd: 'lots' })).status, 400);
    assert.equal((await send('PUT', `/phase/${phaseId}/budget`, {})).status, 400);
    assert.equal((await send('PUT', '/phase/nope/budget', { budget_usd: 1 })).status, 404);
    await ok('POST', `/task/${cardA}/move`, { lane: 'done' });
    const m = await ok('GET', `/metrics/cost?project=${pid}&tz=UTC`);
    assert.equal(m.medianCardCost, 134);
    const [b] = m.budgets;
    // actual 234; one open card (b) x the median done-card cost 134
    assert.deepEqual(
      [b.phase_id, b.budget, b.actual, b.remainingCards, b.projected, b.overBudget, b.projectedOverBudget],
      [phaseId, 500, 234, 1, 368, false, false],
    );
    assert.equal((await ok('PUT', `/phase/${phaseId}/budget`, { budget_usd: null })).budget_usd, null);
  });

  it('/metrics/usage-burn: unavailable until usage is pushed, then projected (with the phase forecast status)', async () => {
    const before = await ok('GET', '/metrics/usage-burn');
    assert.equal(before.status, 'unavailable');
    assert.match(before.reason, /usage/);
    const resets = Math.floor((Date.now() + 2 * 3_600_000) / 1000); // epoch seconds, as the statusline sends
    await ok('POST', '/usage', { five_hour: { used_percentage: 90, resets_at: resets }, seven_day: { used_percentage: 10, resets_at: resets + 4 * 86_400 } });
    const r = await ok('GET', `/metrics/usage-burn?tz=UTC`);
    assert.equal(r.status, 'ok');
    assert.equal(r.forecast, null);
    assert.equal(r.limits.five_hour.rateSource, 'window_average');
    assert.equal(r.limits.five_hour.beforeReset, true);
    assert.equal(r.limits.seven_day.beforeReset, false);
    assert.equal(r.messages.length, 2);
    const withPhase = await ok('GET', `/metrics/usage-burn?project=${pid}&tz=UTC`);
    assert.deepEqual([withPhase.forecast.status, withPhase.forecast.phase], ['no_phase', null]); // P1 was never activated
    const named = await ok('GET', `/metrics/usage-burn?project=${pid}&phase=${phaseId}&tz=UTC`);
    assert.equal(named.forecast.status, 'insufficient_history');
    assert.equal(named.forecast.phase.id, phaseId);
    assert.equal((await send('GET', '/metrics/usage-burn?project=nope')).status, 404);
    assert.equal((await send('GET', `/metrics/usage-burn?project=${pid}&phase=nope`)).status, 404);
    assert.equal((await send('GET', `/metrics/usage-burn?phase=${phaseId}`)).status, 400);
  });

  it('a non-loopback caller gets 403 on PUT prices and PUT budget (GET prices stays open)', async (t) => {
    const ip = nonLoopbackIPv4();
    if (!ip) return t.skip('no non-loopback IPv4 interface on this host');
    const lan = `http://${ip}:${daemon!.port}`;
    assert.equal((await fetch(`${lan}/settings/prices`, { method: 'PUT', body: JSON.stringify(PRICES) })).status, 403);
    assert.equal((await fetch(`${lan}/phase/${phaseId}/budget`, { method: 'PUT', body: '{"budget_usd":1}' })).status, 403);
    assert.equal((await fetch(`${lan}/settings/prices`)).status, 200);
  });
});
