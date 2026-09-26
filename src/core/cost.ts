/**
 * Cost (USD) of build runs: an editable per-model price table, and cost per
 * card / phase / plan / agent / board with phase budgets (planned vs actual).
 *
 * Data: card_activity.usage is the run's token breakdown keyed by model,
 * {"<model>": {input, output, cache_read, cache_creation}}. A JSON column (not
 * four more columns) because a run can span several models and the breakdown
 * stays one row per run (so run counts, ms and line churn are untouched), while
 * SQLite still aggregates it: `json_each(c.usage)` explodes it into one
 * (run, model) row with plain numeric fields, which is how loadCostRows reads it.
 *
 * Estimated cost: a row without a breakdown (recorded before it existed, or by
 * an older hook that only sends `tokens`/`tokens_out`) has cost_estimated = 1.
 * Its cost is estimated as ESTIMATE_METHOD says. Those rows' tokens come from
 * the old hook, which summed every transcript line, and a message is logged as
 * several lines that repeat its usage: measured over 210 local subagent
 * transcripts that inflated totals LEGACY_TOKEN_INFLATION = 1.97x overall
 * (p10 1.56x, p90 2.42x per run). So the tokens are first divided by that
 * factor; then the non-output part (tokens - tokens_out) is priced at the
 * cache-read rate and tokens_out at the output rate, of the scope's dominant
 * model (most tokens among the rows that do have a breakdown; none → the
 * table's default rate). Cache reads are the bulk of an agent run's input
 * side; pricing the total as input would overstate it many times over. Even
 * deflated, a single run's estimate can be off either way (the inflation varies
 * per run). Estimated cost is included in every total and reported separately
 * (`estimated`), with its share; `tokenBasisChangedAt` marks where token counts
 * switched from the inflated basis to the per-message one.
 *
 * Rates are USD per million tokens. The shipped defaults are PLACEHOLDERS
 * (`placeholder: true`, "set your rates"), not published prices: PUT
 * /settings/prices with your real rates. An unknown model is priced at the
 * `default` rate and listed in `unknownModels`; one priced only through a
 * shorter family key (a key "claude-opus-5" pricing "claude-opus-5-5") is
 * listed in `fallbackMatches`.
 *
 * Output tokens in a breakdown can undercount (see the hook's usageByModel):
 * messages the transcript only logged mid-stream carry a streaming snapshot.
 * Reported in `caveats`.
 */
import type { DB } from './db.js';
import {
  addDays,
  checkRange,
  dayKey,
  isoWeek,
  MetricsParamError,
  percentile,
  type MetricsFilter,
} from './metrics.js';
import type { ModelUsage, UsageBreakdown } from './types.js';

// ---------- price table ----------

/** USD per million tokens, per token type. */
export type Rates = ModelUsage;

export interface PriceTable {
  currency: 'USD';
  unit: 'per_million_tokens';
  /** true until the table is set: the defaults are placeholders, not real prices. */
  placeholder: boolean;
  note: string | null;
  /** Keyed by model id or id prefix: "claude-opus-5-5" also prices "claude-opus-5-5-20260901" and "claude-opus-5-5[1m]". */
  models: Record<string, Rates>;
  /** Rate for any model not in `models`. */
  default: Rates;
  updated_at: number | null;
}

const TOKEN_TYPES = ['input', 'output', 'cache_read', 'cache_creation'] as const;
type TokenType = (typeof TOKEN_TYPES)[number];

export const PLACEHOLDER_NOTE = 'Placeholder rates: set your rates (USD per million tokens) with PUT /settings/prices.';

// Placeholders with the usual shape (output 5x input, cache read 0.1x, cache write 1.25x); NOT published prices.
const rates = (input: number): Rates => ({ input, output: input * 5, cache_read: input / 10, cache_creation: input * 1.25 });
export const DEFAULT_PRICES: PriceTable = {
  currency: 'USD',
  unit: 'per_million_tokens',
  placeholder: true,
  note: PLACEHOLDER_NOTE,
  models: {
    'claude-fable-5-1': rates(20),
    'claude-opus-5-5': rates(15),
    'claude-sonnet-5': rates(3),
    'claude-haiku-4-5': rates(1),
  },
  default: rates(15),
  updated_at: null,
};

const PRICES_KEY = 'prices';
export const MAX_RATE = 10_000;
const MAX_MODELS = 200;
const MAX_MODEL_KEY = 200;

/** A bad price table / usage payload (the daemon maps it to 400). */
export class CostParamError extends Error {}

export function getPrices(db: DB): PriceTable {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PRICES_KEY) as { value: string } | undefined;
  if (!row) return structuredClone(DEFAULT_PRICES);
  const stored = JSON.parse(row.value) as Pick<PriceTable, 'models' | 'default' | 'updated_at'>;
  return { ...DEFAULT_PRICES, placeholder: false, note: null, models: stored.models, default: stored.default, updated_at: stored.updated_at };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseRates(v: unknown, where: string): Rates {
  if (!isObject(v)) throw new CostParamError(`${where} must be an object of rates`);
  for (const k of Object.keys(v))
    if (!(TOKEN_TYPES as readonly string[]).includes(k)) throw new CostParamError(`${where}: unknown token type ${k}`);
  const out = {} as Rates;
  for (const t of TOKEN_TYPES) {
    const n = v[t];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_RATE)
      throw new CostParamError(`${where}.${t} must be a number in [0, ${MAX_RATE}] (USD per million tokens)`);
    out[t] = n;
  }
  return out;
}

// read-only fields a client may round-trip from GET; ignored on PUT
const READ_ONLY = new Set(['currency', 'unit', 'placeholder', 'note', 'updated_at']);

/**
 * Replace the price table: `models` (model id/prefix → all four rates) and
 * `default` are both required. Returns the stored table.
 */
export function setPrices(db: DB, body: unknown, now = Date.now()): PriceTable {
  if (!isObject(body)) throw new CostParamError('body must be an object');
  for (const k of Object.keys(body))
    if (k !== 'models' && k !== 'default' && !READ_ONLY.has(k)) throw new CostParamError(`unknown field: ${k}`);
  if (!isObject(body.models)) throw new CostParamError('models must be an object keyed by model id');
  const entries = Object.entries(body.models);
  if (entries.length > MAX_MODELS) throw new CostParamError(`at most ${MAX_MODELS} models`);
  const models: Record<string, Rates> = {};
  for (const [key, v] of entries) {
    const id = key.trim().toLowerCase();
    if (!id || id.length > MAX_MODEL_KEY) throw new CostParamError(`model ids must be 1-${MAX_MODEL_KEY} characters`);
    if (Object.hasOwn(models, id)) throw new CostParamError(`duplicate model id (case-insensitive): ${key}`);
    models[id] = parseRates(v, `models.${key}`);
  }
  const stored = { models, default: parseRates(body.default, 'default'), updated_at: now };
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(PRICES_KEY, JSON.stringify(stored), now);
  return getPrices(db);
}

/** Canonical model id: lowercased, a context suffix like "[1m]" dropped. */
const normModel = (model: string) => model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');

/**
 * The rates for a model: the longest table key equal to it or a prefix of it
 * ("<key>-..."), else the default (key null). `exact` = the key names this very
 * model, maybe with a dated snapshot suffix ("-20251001"); false = a shorter
 * family key, or the default.
 */
export function ratesFor(table: PriceTable, model: string): { rates: Rates; key: string | null; exact: boolean } {
  const m = normModel(model);
  let best: string | null = null;
  for (const key of Object.keys(table.models)) {
    if ((m === key || m.startsWith(`${key}-`)) && (best === null || key.length > best.length)) best = key;
  }
  if (best === null) return { rates: table.default, key: null, exact: false };
  return { rates: table.models[best], key: best, exact: m === best || /^-\d{8}$/.test(m.slice(best.length)) };
}

/** USD for token counts at per-million rates. */
export const usageCost = (u: ModelUsage, r: Rates): number =>
  (u.input * r.input + u.output * r.output + u.cache_read * r.cache_read + u.cache_creation * r.cache_creation) / 1e6;

export const usageTokens = (u: ModelUsage): number => u.input + u.output + u.cache_read + u.cache_creation;

/**
 * Validate a usage breakdown posted by the build hook. null/undefined → null
 * (an old hook: the run's cost will be estimated); an empty object is null too.
 */
export function parseUsage(raw: unknown): UsageBreakdown | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw new CostParamError('usage must be an object keyed by model');
  const out: UsageBreakdown = {};
  for (const [model, v] of Object.entries(raw)) {
    if (!model.trim() || model.length > MAX_MODEL_KEY) throw new CostParamError('usage model ids must be non-empty');
    if (!isObject(v)) throw new CostParamError(`usage.${model} must be an object`);
    const u = {} as ModelUsage;
    for (const t of TOKEN_TYPES) {
      const n = v[t] ?? 0;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
        throw new CostParamError(`usage.${model}.${t} must be a non-negative integer`);
      u[t] = n;
    }
    out[model] = u;
  }
  return Object.keys(out).length ? out : null;
}

/** Measured duplicate-line inflation of the old hook's token totals (see the header). */
export const LEGACY_TOKEN_INFLATION = 1.97;

export const ESTIMATE_METHOD =
  `rows without a token breakdown: tokens divided by ${LEGACY_TOKEN_INFLATION} (the old hook counted each transcript line, ~${LEGACY_TOKEN_INFLATION}x inflated on average, 1.56x-2.42x per run), then non-output tokens priced at the cache-read rate and output at the output rate, of the scope's dominant model (else the default rate); a single run's estimate can be off either way`;

export const OUTPUT_CAVEAT =
  'output tokens come from transcripts: a message logged only mid-stream carries a streaming snapshot, so output (and its cost) undercounts';

// ---------- rows ----------

/** One build run with its per-model usage (usage null = no breakdown, cost estimated). */
export interface CostRow {
  id: number;
  project_id: string;
  task_id: string;
  agent: string | null;
  tokens: number;
  tokens_out: number;
  created_at: number;
  usage: UsageBreakdown | null;
  /** The card, or null when it has been deleted (its runs' cost still counts). */
  card: { title: string; phase_id: string | null; lane: string; tag: string | null } | null;
}

/**
 * Build runs on the scope's boards (a workspace id expands to its verticals),
 * all time; json_each explodes each run's usage into (run, model) rows that are
 * folded back here. `phaseId` is applied in SQL; tag/agent/range in costMetrics.
 */
export function loadCostRows(db: DB, projectIds: string[], phaseId?: string): CostRow[] {
  if (!projectIds.length) return [];
  const qs = projectIds.map(() => '?').join(', ');
  const params: string[] = [...projectIds, ...projectIds];
  let phaseSql = '';
  if (phaseId !== undefined) {
    phaseSql = 'AND t.phase_id = ?';
    params.push(phaseId);
  }
  const raw = db
    .prepare(
      `SELECT c.id, c.project_id, c.task_id, c.agent, c.tokens, c.tokens_out, c.created_at,
              t.id AS t_id, t.title, t.phase_id, t.lane, t.tag,
              j.key AS model, json_extract(j.value, '$.input') AS input, json_extract(j.value, '$.output') AS output,
              json_extract(j.value, '$.cache_read') AS cache_read, json_extract(j.value, '$.cache_creation') AS cache_creation
       FROM card_activity c
       LEFT JOIN tasks t ON t.id = c.task_id
       LEFT JOIN json_each(CASE WHEN c.cost_estimated = 0 THEN c.usage END) j
       WHERE (c.project_id IN (${qs}) OR c.project_id IN (SELECT id FROM projects WHERE parent_id IN (${qs}))) ${phaseSql}
       ORDER BY c.id`,
    )
    .all(...params) as {
    id: number;
    project_id: string;
    task_id: string;
    agent: string | null;
    tokens: number;
    tokens_out: number;
    created_at: number;
    t_id: string | null;
    title: string;
    phase_id: string | null;
    lane: string;
    tag: string | null;
    model: string | null;
    input: number | null;
    output: number | null;
    cache_read: number | null;
    cache_creation: number | null;
  }[];
  const rows: CostRow[] = [];
  for (const r of raw) {
    let row = rows[rows.length - 1];
    if (row?.id !== r.id) {
      row = {
        id: r.id,
        project_id: r.project_id,
        task_id: r.task_id,
        agent: r.agent,
        tokens: r.tokens,
        tokens_out: r.tokens_out,
        created_at: r.created_at,
        usage: null,
        card: r.t_id === null ? null : { title: r.title, phase_id: r.phase_id, lane: r.lane, tag: r.tag },
      };
      rows.push(row);
    }
    if (r.model !== null) {
      (row.usage ??= {})[r.model] = {
        input: r.input ?? 0,
        output: r.output ?? 0,
        cache_read: r.cache_read ?? 0,
        cache_creation: r.cache_creation ?? 0,
      };
    }
  }
  return rows;
}

// ---------- pricing rows (pure) ----------

/** One model's share of a priced run. */
export interface PricedModel {
  model: string;
  priceKey: string | null;
  exact: boolean;
  tokens: number;
  cost: number;
}

export interface PricedRow extends CostRow {
  cost: number;
  estimated: boolean;
  /** Per-model pricing of a breakdown row ([] for an estimated row). */
  models: PricedModel[];
}

export interface Pricing {
  rows: PricedRow[];
  /** The model whose rates priced the estimated rows (null = the default rate). */
  estimateModel: string | null;
}

/** The model with the most tokens across the rows that have a breakdown, or null. */
export function dominantModel(rows: CostRow[]): string | null {
  const totals = new Map<string, number>();
  for (const r of rows) for (const [m, u] of Object.entries(r.usage ?? {})) totals.set(m, (totals.get(m) ?? 0) + usageTokens(u));
  let best: string | null = null;
  for (const [m, n] of totals) if (best === null || n > totals.get(best)!) best = m;
  return best;
}

/** Price every row: breakdown rows per model; the rest by ESTIMATE_METHOD. */
export function priceRows(rows: CostRow[], table: PriceTable): Pricing {
  const estimateModel = dominantModel(rows);
  const estRates = estimateModel === null ? table.default : ratesFor(table, estimateModel).rates;
  const priced = rows.map((r): PricedRow => {
    if (!r.usage) {
      const tokens = r.tokens / LEGACY_TOKEN_INFLATION;
      const out = Math.min(r.tokens_out / LEGACY_TOKEN_INFLATION, tokens);
      const cost = usageCost({ input: 0, output: out, cache_read: tokens - out, cache_creation: 0 }, estRates);
      return { ...r, cost, estimated: true, models: [] };
    }
    const models = Object.entries(r.usage).map(([model, u]): PricedModel => {
      const { rates: rt, key, exact } = ratesFor(table, model);
      return { model, priceKey: key, exact, tokens: usageTokens(u), cost: usageCost(u, rt) };
    });
    return { ...r, cost: models.reduce((s, m) => s + m.cost, 0), estimated: false, models };
  });
  return { rows: priced, estimateModel };
}

// ---------- aggregation ----------

export interface CostOptions {
  tz: string;
  now: number;
  /** byCard length (top N by cost). */
  limit?: number;
  /** Board names for byBoard. */
  boardNames?: Map<string, string>;
  /** Phases on the scope's boards (for byPhase titles and budgets). */
  phases?: CostPhase[];
  /** Not-done card count per phase (budget projection). */
  remainingByPhase?: Map<string, number>;
  /** Committed plans: their card ids. */
  plans?: { id: string; title: string; cardIds: string[] }[];
}

export interface CostPhase {
  id: string;
  project_id: string;
  title: string;
  status: string;
  budget_usd: number | null;
}

export interface CostBudget {
  phase_id: string;
  title: string;
  status: string;
  budget: number | null;
  /** All-time cost of the phase's cards (from/to don't apply; the other filters do). */
  actual: number;
  remainingCards: number;
  /** actual + remainingCards x medianCardCost; null without a median (no done card with cost yet). */
  projected: number | null;
  overBudget: boolean;
  projectedOverBudget: boolean;
}

export interface CostMetrics {
  range: { from: number | null; to: number; tz: string };
  currency: 'USD';
  prices: { placeholder: boolean; updated_at: number | null };
  totals: { cost: number; tokens: number; runs: number; cards: number };
  /** Tokens + cost per token type, over the rows with a breakdown (estimated rows are not split by type). */
  byType: Record<TokenType, { tokens: number; cost: number }>;
  estimated: { runs: number; tokens: number; cost: number; share: number | null; method: string; model: string | null };
  unknownModels: { model: string; tokens: number; cost: number }[];
  /** Models priced only through a shorter family key of the table (not their own). */
  fallbackMatches: { model: string; priceKey: string; tokens: number; cost: number }[];
  byModel: { model: string; priceKey: string | null; tokens: number; cost: number }[];
  /** When token counts switched basis: the scope's first run with a breakdown (null = none yet). */
  tokenBasisChangedAt: number | null;
  /** Known limits of the numbers. */
  caveats: string[];
  byPhase: { phase_id: string | null; title: string | null; cost: number; runs: number; cards: number }[];
  byAgent: { agent: string | null; cost: number; runs: number; cards: number }[];
  byBoard: { project_id: string; name: string | null; cost: number; runs: number; cards: number }[];
  byPlan: { id: string; title: string; cost: number; cards: number }[];
  byCard: { id: string; title: string | null; phase_id: string | null; project_id: string; lane: string | null; cost: number; tokens: number; runs: number; estimated: boolean; deleted: boolean }[];
  /** Cards with any cost in the window (byCard holds the top `limit` of them). */
  cardCount: number;
  weekly: { week: string; start: string; cost: number }[];
  /** Median all-time cost of the scope's done cards (the budget projection's per-card cost), null with none. */
  medianCardCost: number | null;
  budgets: CostBudget[];
}

export const DEFAULT_TOP_CARDS = 10;

const round = (n: number) => Math.round(n * 1e6) / 1e6; // micro-dollars: stable JSON, no float noise

interface Bucket {
  cost: number;
  runs: number;
  cards: Set<string>;
}
const bucket = (m: Map<string, Bucket>, k: string): Bucket => {
  let b = m.get(k);
  if (!b) m.set(k, (b = { cost: 0, runs: 0, cards: new Set() }));
  return b;
};
const addTo = (b: Bucket, r: PricedRow) => {
  b.cost += r.cost;
  b.runs++;
  b.cards.add(r.task_id);
};

/**
 * Aggregate priced, all-time rows. `filter.tag` / `filter.agent` (the run's
 * credited agent) / from-to (the run's time) select the rows every view is
 * built from, except the budgets and the median card cost, which ignore
 * from/to (a budget covers the phase's whole life).
 */
export function aggregateCost(pricing: Pricing, table: PriceTable, filter: MetricsFilter, opts: CostOptions): CostMetrics {
  const to = filter.to ?? opts.now;
  if (filter.from !== undefined) checkRange(filter.from, to);
  const scoped = pricing.rows.filter(
    (r) => (filter.tag === undefined || r.card?.tag === filter.tag) && (filter.agent === undefined || r.agent === filter.agent),
  );
  const rows = scoped.filter((r) => r.created_at <= to && (filter.from === undefined || r.created_at >= filter.from));

  const byType = Object.fromEntries(TOKEN_TYPES.map((t) => [t, { tokens: 0, cost: 0 }])) as CostMetrics['byType'];
  const phases = new Map<string, Bucket>();
  const agents = new Map<string, Bucket>();
  const boards = new Map<string, Bucket>();
  const cards = new Map<string, Bucket & { tokens: number; estimated: boolean; row: PricedRow }>();
  const models = new Map<string, Omit<PricedModel, 'model'>>();
  let cost = 0;
  let tokens = 0;
  const est = { runs: 0, tokens: 0, cost: 0 };
  for (const r of rows) {
    cost += r.cost;
    tokens += r.tokens;
    if (r.estimated) {
      est.runs++;
      est.tokens += r.tokens;
      est.cost += r.cost;
    } else {
      for (const [model, u] of Object.entries(r.usage!)) {
        const rt = ratesFor(table, model).rates;
        for (const t of TOKEN_TYPES) {
          byType[t].tokens += u[t];
          byType[t].cost += (u[t] * rt[t]) / 1e6;
        }
      }
      for (const pm of r.models) {
        const m = models.get(pm.model) ?? { priceKey: pm.priceKey, exact: pm.exact, tokens: 0, cost: 0 };
        m.tokens += pm.tokens;
        m.cost += pm.cost;
        models.set(pm.model, m);
      }
    }
    addTo(bucket(phases, r.card?.phase_id ?? ''), r);
    addTo(bucket(agents, r.agent ?? ''), r);
    addTo(bucket(boards, r.project_id), r);
    let c = cards.get(r.task_id);
    if (!c) cards.set(r.task_id, (c = { cost: 0, runs: 0, cards: new Set(), tokens: 0, estimated: false, row: r }));
    addTo(c, r);
    c.tokens += r.tokens;
    c.estimated ||= r.estimated;
  }

  // weekly: ISO weeks of local days, zero-filled over [from (else the first run), to]
  const from = filter.from ?? rows.reduce((m, r) => Math.min(m, r.created_at), to);
  checkRange(from, to);
  const weekly: CostMetrics['weekly'] = [];
  const weekIndex = new Map<string, number>();
  for (let d = dayKey(from, opts.tz), last = dayKey(to, opts.tz); d <= last; d = addDays(d, 1)) {
    const w = isoWeek(d);
    if (!weekIndex.has(w.week)) {
      weekIndex.set(w.week, weekly.length);
      weekly.push({ ...w, cost: 0 });
    }
  }
  for (const r of rows) {
    const i = weekIndex.get(isoWeek(dayKey(r.created_at, opts.tz)).week);
    if (i !== undefined) weekly[i].cost += r.cost;
  }

  const breakdownAts = scoped.filter((r) => !r.estimated).map((r) => r.created_at);
  const tokenBasisChangedAt = breakdownAts.length ? Math.min(...breakdownAts) : null;
  const byModelList = [...models].map(([model, m]) => ({ model, ...m, cost: round(m.cost) }));
  const caveats = [OUTPUT_CAVEAT];
  if (est.runs) caveats.push(`estimated cost (${est.runs} runs without a token breakdown): ${ESTIMATE_METHOD}`);

  // budgets: all-time actual per phase, projected with the median done-card cost
  const allTime = new Map<string, { cost: number; phase: string | null; done: boolean }>();
  for (const r of scoped) {
    const c = allTime.get(r.task_id) ?? { cost: 0, phase: r.card?.phase_id ?? null, done: r.card?.lane === 'done' };
    c.cost += r.cost;
    allTime.set(r.task_id, c);
  }
  const doneCosts = [...allTime.values()].filter((c) => c.done && c.cost > 0).map((c) => c.cost).sort((a, b) => a - b);
  const medianCardCost = percentile(doneCosts, 50);
  const phaseActual = new Map<string, number>();
  for (const c of allTime.values()) if (c.phase) phaseActual.set(c.phase, (phaseActual.get(c.phase) ?? 0) + c.cost);
  const budgets: CostBudget[] = (opts.phases ?? [])
    .filter((p) => filter.phaseId === undefined || p.id === filter.phaseId)
    .map((p) => {
      const actual = phaseActual.get(p.id) ?? 0;
      const remainingCards = opts.remainingByPhase?.get(p.id) ?? 0;
      const projected = remainingCards === 0 ? actual : medianCardCost === null ? null : actual + remainingCards * medianCardCost;
      return {
        phase_id: p.id,
        title: p.title,
        status: p.status,
        budget: p.budget_usd,
        actual: round(actual),
        remainingCards,
        projected: projected === null ? null : round(projected),
        overBudget: p.budget_usd !== null && actual > p.budget_usd,
        projectedOverBudget: p.budget_usd !== null && projected !== null && projected > p.budget_usd,
      };
    });

  const phaseInfo = new Map((opts.phases ?? []).map((p) => [p.id, p]));
  const sorted = <T extends { cost: number }>(xs: T[]) => xs.sort((a, b) => b.cost - a.cost);
  const limit = opts.limit ?? DEFAULT_TOP_CARDS;
  const cardList = sorted(
    [...cards].map(([id, c]) => ({
      id,
      title: c.row.card?.title ?? null,
      phase_id: c.row.card?.phase_id ?? null,
      project_id: c.row.project_id,
      lane: c.row.card?.lane ?? null,
      cost: round(c.cost),
      tokens: c.tokens,
      runs: c.runs,
      estimated: c.estimated,
      deleted: c.row.card === null,
    })),
  );
  const cardCost = new Map([...cards].map(([id, c]) => [id, c.cost]));

  return {
    range: { from: filter.from ?? null, to, tz: opts.tz },
    currency: 'USD',
    prices: { placeholder: table.placeholder, updated_at: table.updated_at },
    totals: { cost: round(cost), tokens, runs: rows.length, cards: cards.size },
    byType: Object.fromEntries(TOKEN_TYPES.map((t) => [t, { tokens: byType[t].tokens, cost: round(byType[t].cost) }])) as CostMetrics['byType'],
    estimated: {
      runs: est.runs,
      tokens: est.tokens,
      cost: round(est.cost),
      share: cost > 0 ? round(est.cost / cost) : null,
      method: ESTIMATE_METHOD,
      model: pricing.estimateModel,
    },
    unknownModels: sorted(byModelList.filter((m) => m.priceKey === null).map(({ model, tokens, cost }) => ({ model, tokens, cost }))),
    fallbackMatches: sorted(
      byModelList.flatMap(({ model, priceKey, exact, tokens, cost }) => (priceKey !== null && !exact ? [{ model, priceKey, tokens, cost }] : [])),
    ),
    byModel: sorted(byModelList.map(({ model, priceKey, tokens, cost }) => ({ model, priceKey, tokens, cost }))),
    tokenBasisChangedAt,
    caveats,
    byPhase: sorted(
      [...phases].map(([id, b]) => ({
        phase_id: id || null,
        title: id ? (phaseInfo.get(id)?.title ?? null) : null,
        cost: round(b.cost),
        runs: b.runs,
        cards: b.cards.size,
      })),
    ),
    byAgent: sorted([...agents].map(([agent, b]) => ({ agent: agent || null, cost: round(b.cost), runs: b.runs, cards: b.cards.size }))),
    byBoard: sorted(
      [...boards].map(([id, b]) => ({ project_id: id, name: opts.boardNames?.get(id) ?? null, cost: round(b.cost), runs: b.runs, cards: b.cards.size })),
    ),
    byPlan: sorted(
      (opts.plans ?? []).map((p) => {
        const ids = p.cardIds.filter((id) => cardCost.has(id));
        return { id: p.id, title: p.title, cost: round(ids.reduce((s, id) => s + cardCost.get(id)!, 0)), cards: ids.length };
      }),
    ),
    byCard: cardList.slice(0, limit),
    cardCount: cardList.length,
    weekly: weekly.map((w) => ({ ...w, cost: round(w.cost) })),
    medianCardCost: medianCardCost === null ? null : round(medianCardCost),
    budgets,
  };
}

// ---------- DB entry point ----------

export interface CostFilter extends MetricsFilter {
  projectIds: string[];
}

/** /metrics/cost: load the scope's runs, price them, aggregate. */
export function costMetrics(
  db: DB,
  filter: CostFilter,
  opts: { tz: string; now: number; limit?: number; plans?: CostOptions['plans'] },
): CostMetrics {
  if (filter.from !== undefined) checkRange(filter.from, filter.to ?? opts.now);
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new MetricsParamError('limit must be >= 1');
  const table = getPrices(db);
  const pricing = priceRows(loadCostRows(db, filter.projectIds, filter.phaseId), table);
  const qs = filter.projectIds.map(() => '?').join(', ');
  const boardIds = filter.projectIds.length
    ? (db
        .prepare(`SELECT id, name FROM projects WHERE id IN (${qs}) OR parent_id IN (${qs})`)
        .all(...filter.projectIds, ...filter.projectIds) as { id: string; name: string }[])
    : [];
  const boardNames = new Map(boardIds.map((b) => [b.id, b.name]));
  const bq = boardIds.map(() => '?').join(', ');
  const phases = boardIds.length
    ? (db
        .prepare(`SELECT id, project_id, title, status, budget_usd FROM phases WHERE project_id IN (${bq}) ORDER BY project_id, position`)
        .all(...boardIds.map((b) => b.id)) as CostPhase[])
    : [];
  const remainingByPhase = new Map<string, number>();
  if (boardIds.length) {
    const tagSql = filter.tag !== undefined ? 'AND tag = ?' : '';
    const rows = db
      .prepare(
        `SELECT phase_id, COUNT(*) AS n FROM tasks
         WHERE project_id IN (${bq}) AND phase_id IS NOT NULL AND lane != 'done' ${tagSql} GROUP BY phase_id`,
      )
      .all(...boardIds.map((b) => b.id), ...(filter.tag !== undefined ? [filter.tag] : [])) as { phase_id: string; n: number }[];
    for (const r of rows) remainingByPhase.set(r.phase_id, r.n);
  }
  return aggregateCost(pricing, table, filter, { ...opts, boardNames, phases, remainingByPhase });
}
