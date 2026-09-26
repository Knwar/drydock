import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { createPhase, createTask, createVertical, getOrCreateProject, moveTask, recordActivity, setPhaseBudget } from './board.js';
import {
  aggregateCost,
  CostParamError,
  costMetrics,
  DEFAULT_PRICES,
  dominantModel,
  ESTIMATE_METHOD,
  LEGACY_TOKEN_INFLATION,
  getPrices,
  loadCostRows,
  parseUsage,
  priceRows,
  ratesFor,
  setPrices,
  usageCost,
  type CostRow,
  type PriceTable,
} from './cost.js';
import { migrate, openDb, type DB } from './db.js';

const DAY = 86_400_000;
const tz = 'UTC';
const M = 1_000_000;

const PRICES = {
  models: {
    'claude-opus-5-5': { input: 10, output: 50, cache_read: 1, cache_creation: 12 },
    'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_creation: 1.2 },
  },
  default: { input: 100, output: 100, cache_read: 100, cache_creation: 100 },
};
const table = (): PriceTable => ({ ...structuredClone(DEFAULT_PRICES), ...structuredClone(PRICES), placeholder: false, note: null });
const u = (input: number, output: number, cache_read: number, cache_creation: number) => ({ input, output, cache_read, cache_creation });

describe('price table', () => {
  it('defaults are placeholders; the table round-trips through settings', () => {
    const db = openDb();
    const d = getPrices(db);
    assert.equal(d.placeholder, true);
    assert.match(d.note!, /set your rates/);
    assert.deepEqual(Object.keys(d.models).sort(), ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5']);
    const set = setPrices(db, { ...PRICES, currency: 'USD', placeholder: true }, 1234); // read-only fields are ignored
    assert.equal(set.placeholder, false);
    assert.equal(set.note, null);
    assert.equal(set.updated_at, 1234);
    assert.deepEqual(getPrices(db).models, PRICES.models);
    assert.deepEqual(getPrices(db).default, PRICES.default);
  });

  it('rejects invalid tables', () => {
    const db = openDb();
    const bad: unknown[] = [
      null,
      [],
      { models: {}, default: PRICES.default, extra: 1 },
      { default: PRICES.default },
      { models: PRICES.models },
      { models: { x: { input: 1, output: 1, cache_read: 1 } }, default: PRICES.default },
      { models: { x: { ...PRICES.default, input: -1 } }, default: PRICES.default },
      { models: { x: { ...PRICES.default, input: '3' } }, default: PRICES.default },
      { models: { x: { ...PRICES.default, bogus: 1 } }, default: PRICES.default },
      { models: { ' ': PRICES.default }, default: PRICES.default },
      { models: {}, default: { ...PRICES.default, output: 1e9 } },
      { models: { 'Claude-Opus-5-5': PRICES.default, 'claude-opus-5-5 ': PRICES.default }, default: PRICES.default }, // case-insensitive collision
    ];
    for (const b of bad) assert.throws(() => setPrices(db, b), CostParamError, JSON.stringify(b));
    assert.equal(getPrices(db).placeholder, true, 'nothing stored');
  });

  it('matches a model by its longest key prefix; unknown models fall back to the default', () => {
    const t = table();
    t.models['claude-opus-5'] = u(7, 7, 7, 7);
    const match = (m: string) => {
      const r = ratesFor(t, m);
      return [r.key, r.exact];
    };
    assert.deepEqual(match('claude-opus-5-5'), ['claude-opus-5-5', true]);
    assert.deepEqual(match('claude-opus-5-5[1m]'), ['claude-opus-5-5', true]);
    assert.deepEqual(match('Claude-Opus-5-5-20260901'), ['claude-opus-5-5', true]); // a dated snapshot is still exact
    assert.deepEqual(match('claude-opus-5-1'), ['claude-opus-5', false]); // family fallback
    assert.deepEqual(match('claude-opus-5-5-fast'), ['claude-opus-5-5', false]);
    assert.deepEqual(match('claude-opus-55'), [null, false]);
    assert.deepEqual(ratesFor(t, 'gpt-x'), { rates: PRICES.default, key: null, exact: false });
  });
});

describe('parseUsage', () => {
  it('accepts a per-model breakdown (missing types = 0); absent or empty → null', () => {
    assert.equal(parseUsage(undefined), null);
    assert.equal(parseUsage(null), null);
    assert.equal(parseUsage({}), null);
    assert.deepEqual(parseUsage({ m: { input: 1, output: 2 } }), { m: u(1, 2, 0, 0) });
    for (const bad of ['x', [], { m: 1 }, { m: { input: -1 } }, { m: { input: 1.5 } }, { m: { input: '1' } }]) {
      assert.throws(() => parseUsage(bad), CostParamError);
    }
  });
});

describe('pricing rows', () => {
  const row = (id: number, usage: CostRow['usage'], tokens = 0, tokens_out = 0): CostRow => ({
    id,
    project_id: 'p',
    task_id: `t${id}`,
    agent: null,
    tokens,
    tokens_out,
    created_at: 0,
    usage,
    card: null,
  });

  it('prices each model and token type at its own rate', () => {
    // opus: 10 + 50 + 10 (10M cache reads at 1) + 12 = 82; haiku: 2M input at 1 = 2
    const p = priceRows(
      [row(1, { 'claude-opus-5-5[1m]': u(M, M, 10 * M, M), 'claude-haiku-4-5-20251001': u(2 * M, 0, 0, 0) })],
      table(),
    );
    assert.equal(p.rows[0].cost, 84);
    assert.equal(p.rows[0].estimated, false);
    assert.deepEqual(p.rows[0].models, [
      { model: 'claude-opus-5-5[1m]', priceKey: 'claude-opus-5-5', exact: true, tokens: 13 * M, cost: 82 },
      { model: 'claude-haiku-4-5-20251001', priceKey: 'claude-haiku-4-5', exact: true, tokens: 2 * M, cost: 2 },
    ]);
    assert.equal(usageCost(u(M, 0, 0, 0), PRICES.default), 100);
  });

  it('estimates rows without a breakdown: deflated by the legacy inflation, then the dominant model\'s cache-read + output rates', () => {
    // 5.91M / 1.97 = 3M tokens, of which 1.97M / 1.97 = 1M output
    const rows = [row(1, { 'claude-haiku-4-5': u(M, 0, 0, 0) }), row(2, { 'claude-opus-5-5': u(0, 0, 5 * M, 0) }), row(3, null, 5_910_000, 1_970_000)];
    assert.equal(dominantModel(rows), 'claude-opus-5-5');
    const p = priceRows(rows, table());
    assert.equal(p.estimateModel, 'claude-opus-5-5');
    assert.equal(p.rows[2].estimated, true);
    assert.ok(Math.abs(p.rows[2].cost - (2 * 1 + 1 * 50)) < 1e-9); // 2M non-output at cache_read 1, 1M out at 50
    assert.equal(LEGACY_TOKEN_INFLATION, 1.97);
    assert.match(ESTIMATE_METHOD, /1\.97/);
    // no breakdown anywhere: the default rate
    const legacy = priceRows([row(1, null, 3_940_000, 1_970_000)], table());
    assert.equal(legacy.estimateModel, null);
    assert.ok(Math.abs(legacy.rows[0].cost - 200) < 1e-9);
  });

  it('flags unknown models (default rate) and family-key matches', () => {
    const t = table();
    t.models['claude-sonnet-5'] = u(3, 15, 0.3, 3.75);
    const p = priceRows([row(1, { 'mystery-1': u(M, 0, 0, 0), 'claude-sonnet-5-1': u(M, 0, 0, 0) })], t);
    assert.deepEqual(p.rows[0].models, [
      { model: 'mystery-1', priceKey: null, exact: false, tokens: M, cost: 100 },
      { model: 'claude-sonnet-5-1', priceKey: 'claude-sonnet-5', exact: false, tokens: M, cost: 3 },
    ]);
    const m = aggregateCost(p, t, {}, { tz, now: DAY });
    assert.deepEqual(m.unknownModels, [{ model: 'mystery-1', tokens: M, cost: 100 }]);
    assert.deepEqual(m.fallbackMatches, [{ model: 'claude-sonnet-5-1', priceKey: 'claude-sonnet-5', tokens: M, cost: 3 }]);
  });
});

describe('cost metrics (DB)', () => {
  const backdate = (db: DB, taskId: string, days: number) =>
    db.prepare('UPDATE card_activity SET created_at = created_at - ? WHERE task_id = ?').run(days * DAY, taskId);

  const seed = () => {
    const db = openDb();
    setPrices(db, PRICES);
    const p = getOrCreateProject(db, '/tmp/cost-p', 'app');
    const phase = createPhase(db, p.id, 'P1');
    const other = createPhase(db, p.id, 'P2');
    const a = createTask(db, p.id, 'a', { phase_id: phase.id, tag: 'ui' });
    const b = createTask(db, p.id, 'b', { phase_id: phase.id, tag: 'api' });
    const c = createTask(db, p.id, 'c', { phase_id: phase.id, tag: 'ui' });
    const loose = createTask(db, p.id, 'loose', { tag: 'ui' });
    moveTask(db, a.id, 'done');
    const run = (task_id: string, agent: string, usage: Parameters<typeof recordActivity>[1]['usage'], tokens = 0, tokens_out = 0) =>
      recordActivity(db, { project_id: p.id, task_id, agent, tokens, tokens_out, lines_added: 0, lines_removed: 0, ms: 1, usage });
    run(a.id, 'Ada', { 'claude-opus-5-5[1m]': u(M, M, 10 * M, M), 'claude-haiku-4-5-20251001': u(2 * M, 0, 0, 0) }, 15 * M, M); // 84
    run(b.id, 'Bob', { 'mystery-model': u(M, 0, 0, 0) }, M, 0); // 100, unknown
    run(a.id, 'Ada', null, 5_910_000, 1_970_000); // legacy, deflated /1.97 to 3M (1M out): 2M at opus cache_read 1 + 1M at output 50 = 52
    run(loose.id, 'Bob', { 'claude-haiku-4-5': u(0, 0, 0, M) }, M, 0); // 1.2
    return { db, p, phase, other, a, b, c, loose };
  };

  it('totals, estimated share, and every breakdown', () => {
    const { db, p, phase, a, b, loose } = seed();
    const now = Date.now();
    const m = costMetrics(db, { projectIds: [p.id] }, { tz, now });
    assert.equal(m.currency, 'USD');
    assert.deepEqual(m.prices, { placeholder: false, updated_at: getPrices(db).updated_at });
    assert.deepEqual(m.totals, { cost: 237.2, tokens: 22_910_000, runs: 4, cards: 3 });
    assert.equal(m.estimated.runs, 1);
    assert.equal(m.estimated.cost, 52);
    assert.equal(m.estimated.share, Math.round((52 / 237.2) * 1e6) / 1e6);
    assert.equal(m.estimated.model, 'claude-opus-5-5[1m]');
    assert.match(m.estimated.method, /cache-read rate/);
    assert.deepEqual(m.byType.cache_read, { tokens: 10 * M, cost: 10 });
    assert.deepEqual(m.byType.cache_creation, { tokens: 2 * M, cost: 13.2 });
    assert.deepEqual(m.byType.input, { tokens: 4 * M, cost: 112 });
    assert.deepEqual(m.unknownModels, [{ model: 'mystery-model', tokens: M, cost: 100 }]);
    assert.deepEqual(m.fallbackMatches, []);
    assert.deepEqual(
      m.byModel.map((x) => [x.model, x.priceKey, x.cost]),
      [
        ['mystery-model', null, 100],
        ['claude-opus-5-5[1m]', 'claude-opus-5-5', 82],
        ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 2],
        ['claude-haiku-4-5', 'claude-haiku-4-5', 1.2],
      ],
    );
    const firstBreakdown = (db.prepare('SELECT MIN(created_at) AS t FROM card_activity WHERE usage IS NOT NULL').get() as { t: number }).t;
    assert.equal(m.tokenBasisChangedAt, firstBreakdown);
    assert.equal(m.caveats.length, 3);
    assert.match(m.caveats[0], /streaming snapshot/);
    assert.match(m.caveats[1], /1 runs without a token breakdown/);
    assert.match(m.caveats[2], /totals\.tokens and estimated\.tokens include .* inflated/);
    assert.deepEqual(m.byAgent, [
      { agent: 'Ada', cost: 136, runs: 2, cards: 1 },
      { agent: 'Bob', cost: 101.2, runs: 2, cards: 2 },
    ]);
    assert.deepEqual(m.byPhase, [
      { phase_id: phase.id, title: 'P1', cost: 236, runs: 3, cards: 2 },
      { phase_id: null, title: null, cost: 1.2, runs: 1, cards: 1 },
    ]);
    assert.deepEqual(m.byBoard, [{ project_id: p.id, name: 'app', cost: 237.2, runs: 4, cards: 3 }]);
    assert.deepEqual(
      m.byCard.map((c) => [c.id, c.cost, c.runs, c.estimated, c.deleted]),
      [
        [a.id, 136, 2, true, false],
        [b.id, 100, 1, false, false],
        [loose.id, 1.2, 1, false, false],
      ],
    );
    assert.equal(m.cardCount, 3);
    assert.equal(m.weekly.reduce((s, w) => s + w.cost, 0), 237.2);
    assert.equal(costMetrics(db, { projectIds: [p.id] }, { tz, now, limit: 1 }).byCard.length, 1);
  });

  it('plans: the committed cards of each plan', () => {
    const { db, p, a, c } = seed();
    const pricing = priceRows(loadCostRows(db, [p.id]), getPrices(db));
    const m = aggregateCost(pricing, getPrices(db), {}, { tz, now: Date.now(), plans: [{ id: 'pl', title: 'Plan', cardIds: [a.id, c.id, 'gone'] }] });
    assert.deepEqual(m.byPlan, [{ id: 'pl', title: 'Plan', cost: 136, cards: 1 }]);
  });

  it('budgets: planned vs actual, projected at the median done-card cost', () => {
    const { db, p, phase, other } = seed();
    setPhaseBudget(db, phase.id, 200);
    const m = costMetrics(db, { projectIds: [p.id] }, { tz, now: Date.now() });
    assert.equal(m.medianCardCost, 136); // the one done card
    const p1 = m.budgets.find((x) => x.phase_id === phase.id)!;
    // actual 236; b and c still open: 236 + 2 x 136
    assert.deepEqual(p1, {
      phase_id: phase.id,
      title: 'P1',
      status: 'planned',
      budget: 200,
      actual: 236,
      remainingCards: 2,
      projected: 508,
      overBudget: true,
      projectedOverBudget: true,
    });
    const p2 = m.budgets.find((x) => x.phase_id === other.id)!;
    assert.deepEqual([p2.budget, p2.actual, p2.remainingCards, p2.projected, p2.overBudget], [null, 0, 0, 0, false]);
    assert.throws(() => setPhaseBudget(db, phase.id, -1));
    assert.throws(() => setPhaseBudget(db, phase.id, Number.NaN));
    assert.equal(setPhaseBudget(db, phase.id, null).budget_usd, null);
  });

  it('no done card with cost: the projection is unknown', () => {
    const db = openDb();
    const p = getOrCreateProject(db, '/tmp/cost-open', 'o');
    const phase = createPhase(db, p.id, 'P');
    const t = createTask(db, p.id, 't', { phase_id: phase.id });
    recordActivity(db, { project_id: p.id, task_id: t.id, tokens: M, tokens_out: 0, lines_added: 0, lines_removed: 0, ms: 0, usage: { x: u(M, 0, 0, 0) } });
    const [b] = costMetrics(db, { projectIds: [p.id] }, { tz, now: Date.now() }).budgets;
    assert.equal(b.projected, null);
    assert.equal(b.projectedOverBudget, false);
  });

  it('from/to window the runs; tag, agent and phase filter them; budgets stay all-time', () => {
    const { db, p, phase, b } = seed();
    backdate(db, b.id, 30);
    const now = Date.now();
    const recent = costMetrics(db, { projectIds: [p.id], from: now - 7 * DAY }, { tz, now });
    assert.equal(recent.totals.cost, 137.2);
    assert.equal(recent.range.from, now - 7 * DAY);
    assert.ok(recent.weekly.length >= 1 && recent.weekly.length <= 2);
    assert.equal(recent.budgets.find((x) => x.phase_id === phase.id)!.actual, 236);
    // model lists follow the same rows as the totals
    assert.deepEqual(recent.unknownModels, []);
    assert.deepEqual(recent.byModel.map((x) => x.model).sort(), ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]']);
    const old = costMetrics(db, { projectIds: [p.id], to: now - 7 * DAY }, { tz, now });
    assert.equal(old.totals.cost, 100);
    assert.deepEqual(old.unknownModels, [{ model: 'mystery-model', tokens: M, cost: 100 }]);
    assert.deepEqual(old.byModel.map((x) => x.model), ['mystery-model']);
    const ui = costMetrics(db, { projectIds: [p.id], tag: 'ui' }, { tz, now });
    assert.deepEqual(ui.unknownModels, []);
    assert.deepEqual(ui.byModel.map((x) => x.model).sort(), ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]']);
    const api = costMetrics(db, { projectIds: [p.id], tag: 'api' }, { tz, now });
    assert.deepEqual(api.byModel.map((x) => x.model), ['mystery-model']);
    assert.deepEqual(api.caveats.length, 1, 'no estimated runs in the api-tagged scope');
    assert.ok(old.weekly.length >= 3, 'zero-filled from the first run (30 days back) to `to`');
    assert.equal(old.weekly.filter((w) => w.cost > 0).length, 1);
    assert.equal(costMetrics(db, { projectIds: [p.id], tag: 'ui' }, { tz, now }).totals.cost, 137.2);
    assert.equal(costMetrics(db, { projectIds: [p.id], agent: 'Bob' }, { tz, now }).totals.cost, 101.2);
    const ph = costMetrics(db, { projectIds: [p.id], phaseId: phase.id }, { tz, now });
    assert.equal(ph.totals.cost, 236);
    assert.deepEqual(ph.budgets.map((x) => x.phase_id), [phase.id]);
  });

  it('a workspace includes its verticals (byBoard); a deleted card still counts', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-cost-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'api'));
    const db = openDb();
    const ws = getOrCreateProject(db, dir, 'ws');
    const v = createVertical(db, ws.id, 'api', join(dir, 'api'));
    const card = createTask(db, v.id, 'v-card');
    const run = (project_id: string, task_id: string) =>
      recordActivity(db, { project_id, task_id, tokens: M, tokens_out: 0, lines_added: 0, lines_removed: 0, ms: 0, usage: { x: u(M, 0, 0, 0) } });
    run(v.id, card.id);
    run(ws.id, 'deleted-card');
    const m = costMetrics(db, { projectIds: [ws.id] }, { tz, now: Date.now() });
    assert.equal(m.totals.cost, 2 * 15); // placeholder default rate: 15 per M input
    assert.deepEqual(m.byBoard.map((x) => x.name).sort(), ['api', 'ws']);
    const gone = m.byCard.find((c) => c.id === 'deleted-card')!;
    assert.deepEqual([gone.deleted, gone.title, gone.lane], [true, null, null]);
  });
});

describe('migration', () => {
  it('legacy card_activity rows are flagged cost_estimated; phases gain budget_usd', (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE card_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
      agent TEXT, agent_id TEXT, tokens INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      lines_added INTEGER NOT NULL DEFAULT 0, lines_removed INTEGER NOT NULL DEFAULT 0,
      ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE phases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT, plan TEXT,
      status TEXT NOT NULL DEFAULT 'planned', position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.prepare('INSERT INTO card_activity (project_id, task_id, tokens, created_at) VALUES (?, ?, ?, 1)').run('p', 't', 5);
    db.prepare(`INSERT INTO phases (id, project_id, title, created_at, updated_at) VALUES ('ph', 'p', 'P', 1, 1)`).run();
    migrate(db);
    assert.deepEqual({ ...(db.prepare('SELECT usage, cost_estimated FROM card_activity').get() as object) }, { usage: null, cost_estimated: 1 });
    assert.deepEqual({ ...(db.prepare('SELECT budget_usd FROM phases').get() as object) }, { budget_usd: null });
    migrate(db); // idempotent
    // a new row with a breakdown is not estimated; one without is
    db.prepare(`INSERT INTO card_activity (project_id, task_id, usage, created_at) VALUES ('p', 't', '{"m":{"input":1}}', 2)`).run();
    assert.deepEqual(
      (db.prepare('SELECT cost_estimated FROM card_activity ORDER BY id').all() as { cost_estimated: number }[]).map((r) => r.cost_estimated),
      [1, 0],
    );
  });
});
