/**
 * Agentic flow metrics: how autonomously cards ship, who stops the work, how big
 * the batches are, whether specs are met, and the governance posture. Built only
 * on what is already recorded (no new capture):
 *
 *  - autonomy:  cards done in [from, to]; autonomous = no `block` and no `redirect`
 *               event anywhere in the card's history. Weekly by the done week. needsHuman
 *               lists the others (newest done first, capped at NEEDS_HUMAN_CAP) for a drill.
 *  - stops:     events in [from, to]. Agent self-stops = `block` (raise_blocker).
 *               Human interrupts = `redirect` (redirect_task) + reopens: a move back
 *               into in_progress from in_review / done that does NOT follow a fail
 *               review (a review fail's rework is routine, not an interrupt).
 *               ratio = agent / human (null with no human stops). Weekly by event week.
 *  - batch:     per done card, lines_added + lines_removed summed over its card_activity
 *               rows. A card has line data only when it has activity rows and none is
 *               `estimated` (legacy counts not recomputable from git, which line totals
 *               elsewhere exclude); the others are counted in `noData`.
 *  - specAdherence: done cards per phase: acceptance criteria total / checked (the card's
 *               current subtasks) and the review first-pass rate (from the last redirect,
 *               as quality.ts counts it). Overall: done cards with at least one criterion,
 *               all checked, AND a first review that passed.
 *  - governance:
 *      - tool events (the PostToolUse hook's `tool` events) in [from, to]: tied = task_id
 *        set. The hook only records events it can tie to a card, so `untied` only counts
 *        events posted some other way: a floor, not a measure of untracked work.
 *      - risky Bash commands, matched on the recorded command text (the hook stores it in
 *        payload.file, cut to 80 chars, with everything up to a `.trees/<id>/` path stripped,
 *        which can drop the command itself when it uses an absolute worktree path). It is
 *        recorded after the tool ran, so these are commands that ran, not refused attempts;
 *        matches inside echo / grep strings can be false positives.
 *      - done cards linked to a decision (governance_links, target_type 'card').
 *
 * Window: [from, to]; `to` defaults to now, `from` to the earliest done / stop / tool
 * event in the scope (else `to`), clamped to the range cap. Weekly series are the
 * window's ISO weeks, zero-filled.
 */
import type { DB } from './db.js';
import {
  addDays,
  checkRange,
  dayKey,
  deriveCards,
  isoWeek,
  loadCardHistories,
  matchingCardIds,
  MAX_RANGE_DAYS,
  percentile,
  sortEvents,
  type DerivedCard,
  type MetricsFilter,
} from './metrics.js';
import { cardQuality } from './quality.js';
import { getActivePhase } from './board.js';
import { getPrices, loadCostRows, matchesCostFilter, priceRows, type CostFilter } from './cost.js';
import { phaseForecastInfo } from './forecast.js';
import { longestChain } from './plan-graph.js';
import { usageBurn, type ForecastInfo, type LimitReport, type UsageBurn, type UsageSample } from './usage-burn.js';
import { computeWait, loadBlockers, loadNeedsYou } from './wait-time.js';

export const DEFAULT_BATCH_LINES = 200;

/** `rm` with both a recursive and a force flag, in any order / spelling (-rf, -Rf, -fR, -r -f, --recursive --force). */
function isRmRf(command: string): boolean {
  for (const m of command.matchAll(/\brm((?:\s+-[^\s]*)+)/g)) {
    const flags = m[1].trim().split(/\s+/);
    const short = flags.filter((f) => /^-[a-zA-Z]+$/.test(f)).join('');
    const recursive = /[rR]/.test(short) || flags.includes('--recursive');
    const force = /f/.test(short) || flags.includes('--force');
    if (recursive && force) return true;
  }
  return false;
}

/** Conservative risky-command patterns, matched on recorded Bash command text. */
export const RISKY_PATTERNS: { name: string; test: (command: string) => boolean }[] = [
  { name: 'rm -rf', test: isRmRf },
  // --force-with-lease is the safe force push: not counted
  { name: 'git push --force', test: (c) => /\bgit\s+push\b.*(?:--force(?![-\w])|\s-f\b)/.test(c) },
  { name: 'git reset --hard', test: (c) => /\bgit\s+reset\b.*--hard\b/.test(c) },
  { name: 'DROP TABLE', test: (c) => /\bdrop\s+table\b/i.test(c) },
  { name: 'chmod 777', test: (c) => /\bchmod\s+(?:-\w+\s+)*0?777\b/.test(c) },
  { name: 'curl | sh', test: (c) => /\bcurl\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/.test(c) },
];

/** A recorded `tool` event (payload already parsed). */
export interface ToolEvent {
  task_id: string | null;
  tool: string | null;
  /** The recorded file path or Bash command (payload.file). */
  input: string | null;
  created_at: number;
}

/** Everything the aggregation needs, already scoped by the loader. */
export interface AgenticInput {
  cards: DerivedCard[];
  /** Card id → acceptance criteria counts (current subtasks). */
  subtasks: Map<string, { total: number; checked: number }>;
  /** Card id → lines changed; only cards with line data. */
  lines: Map<string, number>;
  /** Ids of cards linked to a decision. */
  decisionLinked: Set<string>;
  toolEvents: ToolEvent[];
  phaseTitles?: Map<string, string>;
}

export interface AgenticOptions {
  tz: string;
  now: number;
  from?: number;
  to?: number;
  batchLines?: number;
}

type Week = { week: string; start: string };

export interface AgenticMetrics {
  range: { from: number; to: number; tz: string };
  autonomy: {
    done: number;
    autonomous: number;
    pct: number | null;
    weekly: (Week & { done: number; autonomous: number; pct: number | null })[];
    /** Done cards in the window that had a block or redirect, newest done first, at most NEEDS_HUMAN_CAP. */
    needsHuman: { id: string; title: string; doneAt: number }[];
  };
  stops: {
    agent: number;
    human: number;
    redirects: number;
    reopens: number;
    /** agent / human; null with no human stops. */
    ratio: number | null;
    weekly: (Week & { agent: number; human: number })[];
  };
  batch: {
    threshold: number;
    /** Done cards with line data. */
    cards: number;
    over: number;
    pctOver: number | null;
    median: number | null;
    top: { id: string; title: string; lines: number; doneAt: number }[];
    /** Done cards without line data (excluded above). */
    noData: number;
  };
  specAdherence: {
    byPhase: {
      phase_id: string | null;
      title: string | null;
      cards: number;
      criteria: { total: number; checked: number };
      reviewed: number;
      firstPassRate: number | null;
      /** Done cards in the phase with all criteria checked AND a first-pass review. */
      adherent: number;
    }[];
    done: number;
    adherent: number;
    pct: number | null;
  };
  governance: {
    toolEvents: { total: number; tied: number; untied: number; tiedPct: number | null; note: string };
    risky: {
      count: number | null;
      byPattern: Record<string, number> | null;
      reason: string | null;
      caveat: string | null;
    };
    decisionLinked: { done: number; linked: number; pct: number | null };
  };
}

const ratio = (n: number, d: number) => (d ? n / d : null);

function field(payload: unknown, key: string): unknown {
  let p = payload;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      return null;
    }
  }
  return p && typeof p === 'object' ? (p as Record<string, unknown>)[key] : null;
}

/** A card's stop events: blocks (agent) and redirects / reopens not following a fail review (human). */
export function cardStops(x: DerivedCard): { at: number; kind: 'agent' | 'redirect' | 'reopen' }[] {
  const out: { at: number; kind: 'agent' | 'redirect' | 'reopen' }[] = [];
  let failPending = false;
  for (const e of sortEvents(x.h.events)) {
    if (e.type === 'review') failPending = field(e.payload, 'verdict') === 'fail';
    else if (e.type === 'block') out.push({ at: e.created_at, kind: 'agent' });
    else if (e.type === 'redirect') {
      failPending = false;
      out.push({ at: e.created_at, kind: 'redirect' });
    } else if (e.type === 'move') {
      // only the move right after a fail review is its rework; any other lane change clears the fail
      const from = field(e.payload, 'from');
      if (field(e.payload, 'to') === 'in_progress' && (from === 'in_review' || from === 'done') && !failPending)
        out.push({ at: e.created_at, kind: 'reopen' });
      failPending = false;
    }
  }
  return out;
}

/** The most cards autonomy.needsHuman lists. */
export const NEEDS_HUMAN_CAP = 200;

const isAutonomous = (x: DerivedCard) => !x.h.events.some((e) => e.type === 'block' || e.type === 'redirect');

/** The command a risky pattern matches, else null. */
export function riskyPattern(command: string): string | null {
  return RISKY_PATTERNS.find((p) => p.test(command))?.name ?? null;
}

const TOOL_NOTE =
  'The activity hook only records tool events it can tie to a card, so untied is a floor, not a measure of untracked agent work.';
const RISKY_CAVEAT =
  'Matched on the Bash command text the activity hook records, after the command ran, so refused attempts are not counted. ' +
  'The text is cut to 80 characters (patterns past the cut are missed) and everything up to a `.trees/<id>/` path is stripped, ' +
  'so a command using an absolute worktree path can lose the command itself. Matches inside echo / grep strings can be false positives.';

export function agenticFromInput(input: AgenticInput, opts: AgenticOptions): AgenticMetrics {
  const { tz, now } = opts;
  const to = opts.to ?? now;
  const threshold = opts.batchLines ?? DEFAULT_BATCH_LINES;
  const stopsByCard = input.cards.map((x) => ({ x, stops: cardStops(x) }));
  let earliest = to;
  for (const { x, stops } of stopsByCard) {
    if (x.m.doneAt !== null) earliest = Math.min(earliest, x.m.doneAt);
    for (const s of stops) earliest = Math.min(earliest, s.at);
  }
  for (const t of input.toolEvents) earliest = Math.min(earliest, t.created_at);
  const from = opts.from ?? Math.max(earliest, to - (MAX_RANGE_DAYS - 1) * 86_400_000);
  checkRange(from, to);
  const inWin = (t: number) => t >= from && t <= to;

  const weeks: Week[] = [];
  const last = isoWeek(dayKey(to, tz));
  for (let w = isoWeek(dayKey(from, tz)); w.start <= last.start; w = isoWeek(addDays(w.start, 7))) weeks.push(w);
  const weekOf = (t: number) => isoWeek(dayKey(t, tz)).week;

  // autonomy
  const done = input.cards.filter((x) => x.m.doneAt !== null && inWin(x.m.doneAt));
  const autoWeeks = new Map(weeks.map((w) => [w.week, { done: 0, autonomous: 0 }]));
  let autonomous = 0;
  const needsHuman: DerivedCard[] = [];
  for (const x of done) {
    const a = isAutonomous(x);
    if (a) autonomous++;
    else needsHuman.push(x);
    const w = autoWeeks.get(weekOf(x.m.doneAt!));
    if (w) {
      w.done++;
      if (a) w.autonomous++;
    }
  }

  // stops
  const stopWeeks = new Map(weeks.map((w) => [w.week, { agent: 0, human: 0 }]));
  const counts = { agent: 0, redirect: 0, reopen: 0 };
  for (const { stops } of stopsByCard) {
    for (const s of stops) {
      if (!inWin(s.at)) continue;
      counts[s.kind]++;
      const w = stopWeeks.get(weekOf(s.at));
      if (w) w[s.kind === 'agent' ? 'agent' : 'human']++;
    }
  }
  const human = counts.redirect + counts.reopen;

  // batch
  const sized = done.flatMap((x) => {
    const lines = input.lines.get(x.m.id);
    return lines === undefined ? [] : [{ id: x.m.id, title: x.m.title, lines, doneAt: x.m.doneAt! }];
  });
  const sortedLines = sized.map((s) => s.lines).sort((a, b) => a - b);
  const over = sized.filter((s) => s.lines > threshold).length;

  // spec adherence
  const quality = new Map(done.map((x) => [x.m.id, cardQuality(x)]));
  const phases = new Map<string | null, DerivedCard[]>();
  for (const x of done) {
    const k = x.m.phase_id;
    if (!phases.has(k)) phases.set(k, []);
    phases.get(k)!.push(x);
  }
  const titles = input.phaseTitles ?? new Map<string, string>();
  const crit = (x: DerivedCard) => input.subtasks.get(x.m.id) ?? { total: 0, checked: 0 };
  const isAdherent = (x: DerivedCard) => {
    const c = crit(x);
    const q = quality.get(x.m.id)!;
    return c.total > 0 && c.checked === c.total && q.reviewed && q.firstPass;
  };
  const adherent = done.filter(isAdherent).length;

  // governance
  const tools = input.toolEvents.filter((t) => inWin(t.created_at));
  const tied = tools.filter((t) => t.task_id !== null).length;
  const bash = tools.filter((t) => t.tool === 'Bash');
  const stored = bash.filter((t) => t.input);
  let risky: AgenticMetrics['governance']['risky'];
  if (bash.length > 0 && stored.length === 0) {
    risky = { count: null, byPattern: null, reason: 'No Bash command text is recorded for the Bash tool events in this window.', caveat: null };
  } else {
    const byPattern = Object.fromEntries(RISKY_PATTERNS.map((p) => [p.name, 0]));
    let count = 0;
    for (const t of stored) {
      const name = riskyPattern(t.input!);
      if (name) {
        byPattern[name]++;
        count++;
      }
    }
    risky = { count, byPattern, reason: null, caveat: RISKY_CAVEAT };
  }
  const linked = done.filter((x) => input.decisionLinked.has(x.m.id)).length;

  return {
    range: { from, to, tz },
    autonomy: {
      done: done.length,
      autonomous,
      pct: ratio(autonomous, done.length),
      weekly: weeks.map((w) => {
        const a = autoWeeks.get(w.week)!;
        return { ...w, ...a, pct: ratio(a.autonomous, a.done) };
      }),
      needsHuman: needsHuman
        .sort((a, b) => b.m.doneAt! - a.m.doneAt! || a.m.id.localeCompare(b.m.id))
        .slice(0, NEEDS_HUMAN_CAP)
        .map((x) => ({ id: x.m.id, title: x.m.title, doneAt: x.m.doneAt! })),
    },
    stops: {
      agent: counts.agent,
      human,
      redirects: counts.redirect,
      reopens: counts.reopen,
      ratio: ratio(counts.agent, human),
      weekly: weeks.map((w) => ({ ...w, ...stopWeeks.get(w.week)! })),
    },
    batch: {
      threshold,
      cards: sized.length,
      over,
      pctOver: ratio(over, sized.length),
      median: percentile(sortedLines, 50),
      top: [...sized].sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id)).slice(0, 5),
      noData: done.length - sized.length,
    },
    specAdherence: {
      byPhase: [...phases.entries()].map(([phase_id, xs]) => {
        const qs = xs.map((x) => quality.get(x.m.id)!).filter((q) => q.reviewed);
        return {
          phase_id,
          title: phase_id === null ? null : (titles.get(phase_id) ?? null),
          cards: xs.length,
          criteria: xs.reduce((s, x) => ({ total: s.total + crit(x).total, checked: s.checked + crit(x).checked }), { total: 0, checked: 0 }),
          reviewed: qs.length,
          firstPassRate: ratio(qs.filter((q) => q.firstPass).length, qs.length),
          adherent: xs.filter(isAdherent).length,
        };
      }),
      done: done.length,
      adherent,
      pct: ratio(adherent, done.length),
    },
    governance: {
      toolEvents: { total: tools.length, tied, untied: tools.length - tied, tiedPct: ratio(tied, tools.length), note: TOOL_NOTE },
      risky,
      decisionLinked: { done: done.length, linked, pct: ratio(linked, done.length) },
    },
  };
}

// ---------- loader ----------

/** Load + aggregate. The range is validated before anything is loaded. */
export function agenticMetrics(db: DB, filter: MetricsFilter, opts: { tz: string; now: number; batchLines?: number }): AgenticMetrics {
  const to = filter.to ?? opts.now;
  if (filter.from !== undefined) checkRange(filter.from, to);
  // cards whose life overlaps the window (a done card's done time and its stops fall within its life)
  const cards = deriveCards(loadCardHistories(db, filter), opts.now);
  const ids = JSON.stringify(cards.map((x) => x.m.id));

  const subtasks = new Map<string, { total: number; checked: number }>();
  for (const r of db.prepare('SELECT id, subtasks FROM tasks WHERE id IN (SELECT value FROM json_each(?))').all(ids) as {
    id: string;
    subtasks: string | null;
  }[]) {
    let list: unknown;
    try {
      list = JSON.parse(r.subtasks ?? '[]');
    } catch {
      list = [];
    }
    const items = Array.isArray(list) ? list : [];
    subtasks.set(r.id, { total: items.length, checked: items.filter((s) => s && typeof s === 'object' && s.done === true).length });
  }

  const lines = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT task_id, SUM(estimated) AS est, SUM(lines_added + lines_removed) AS lines
       FROM card_activity WHERE task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id`,
    )
    .all(ids) as { task_id: string; est: number; lines: number }[]) {
    if (r.est === 0) lines.set(r.task_id, r.lines);
  }

  const decisionLinked = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT target_id FROM governance_links
           WHERE kind = 'decision' AND target_type = 'card' AND target_id IN (SELECT value FROM json_each(?))`,
        )
        .all(ids) as { target_id: string }[]
    ).map((r) => r.target_id),
  );

  // tool events: tied ones through the card filter (scope incl. verticals, phase, tag, agent, work type);
  // untied ones (no card) only match a filter without card fields, by the event's board
  const cardFiltered = filter.phaseId !== undefined || filter.tag !== undefined || filter.agent !== undefined || filter.workType !== undefined;
  const boards = filter.projectIds
    ? (
        db
          .prepare('SELECT id FROM projects WHERE id IN (SELECT value FROM json_each(?)) OR parent_id IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify(filter.projectIds), JSON.stringify(filter.projectIds)) as { id: string }[]
      ).map((r) => r.id)
    : null;
  const toolRows = db
    .prepare(
      `SELECT task_id, payload, created_at FROM task_events
       WHERE type = 'tool' AND created_at <= ? AND created_at >= ?
         AND (task_id IN (SELECT value FROM json_each(?))
              OR (task_id IS NULL AND ? AND (? IS NULL OR project_id IN (SELECT value FROM json_each(?)))))
       ORDER BY id`,
    )
    .all(
      to,
      filter.from ?? to - (MAX_RANGE_DAYS - 1) * 86_400_000,
      JSON.stringify([...matchingCardIds(db, filter)]),
      cardFiltered ? 0 : 1,
      boards === null ? null : 1,
      JSON.stringify(boards ?? []),
    ) as { task_id: string | null; payload: string | null; created_at: number }[];
  const toolEvents: ToolEvent[] = toolRows.map((r) => {
    const tool = field(r.payload, 'tool');
    const input = field(r.payload, 'file');
    return {
      task_id: r.task_id,
      tool: typeof tool === 'string' ? tool : null,
      input: typeof input === 'string' && input ? input : null,
      created_at: r.created_at,
    };
  });

  const phaseIds = [...new Set(cards.flatMap((x) => (x.m.phase_id === null ? [] : [x.m.phase_id])))];
  const phaseTitles = new Map(
    (db.prepare('SELECT id, title FROM phases WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(phaseIds)) as {
      id: string;
      title: string;
    }[]).map((p) => [p.id, p.title]),
  );

  return agenticFromInput(
    { cards, subtasks, lines, decisionLinked, toolEvents, phaseTitles },
    { ...opts, from: filter.from, to: filter.to },
  );
}

// =====================================================================================
// Agentic cost (/metrics/agentic-cost): what rework, waiting on the human, spend spikes
// and the usage limits cost. Built on cost.ts pricing, wait-time.ts, usage-burn.ts and
// forecast.ts; nothing is re-priced or re-derived here.
//
//  - reworkCost: build runs (card_activity rows, priced by cost.ts) in [from, to] that
//    belong to a FAILED review round. Attribution rule: a run belongs to the first review
//    of its card recorded at or after the run's created_at. Runs are recorded when they end,
//    and only builder runs are recorded (on-build-stop.js; reviewer runs leave no row), so
//    this is the build run the review judged: the run a review failed counts as rework.
//    Runs after the card's last review belong to no round yet and are never rework.
//    Redirects don't reset this: a review is a review whichever attempt it judged.
//    100% rework: a card whose every reviewed run preceded a fail (e.g. capped after two
//    fails, or failed with its fix not yet reviewed) is all rework, and pct is 1 when every
//    run in the window preceded a failed review.
//  - decisionLatencyCost: human-wait hours in [from, to] x the median, over credited agents,
//    of the agent's spend / its active hours (card_activity.ms; runs without a recorded
//    duration are left out of both) in the window: "$ of idle agent time". Wait hours are
//    the UNION per board of the needs_you and blocker intervals (wait-time.ts loaders),
//    clipped to the window (open ones run to now): a blocker normally overlaps a needs_you
//    wait, and overlapping time on a board counts once. needsYouHours / blockedHours are
//    wait-time.ts's own totals (each on its own, so they can sum to more than the union).
//    Live (not windowed): days of slip and the queue.
//      - slip: blocked time (all of it, open blockers up to now) on the cards of the active
//        phase's critical path: the longest depends_on chain among the phase's cards
//        (plan-graph longestChain). With no chain of 2+ cards there is no critical path, and
//        it falls back to the phase's in-flight cards (queued / in_progress / in_review),
//        flagged `approximation: true`.
//      - queue: needs_you sessions + open blockers in scope now, oldest first.
//  - costAnomaly: daily spend per phase over [from - 14 days, to] (local days in tz). A day
//    in [from, to] is flagged when spend > mean + 2 sigma of its 14 trailing days, counting
//    only trailing days on or after the phase's first spend ever (idle days after that are
//    real zeros; days before it are no data), only with >= 5 such days, and only when the
//    trailing days are not all zero (so a flat-zero baseline never flags). sigma: population.
//    judgedDays: the in-range days some phase could judge (>= 5 such trailing days; a flat-zero
//    baseline still counts as judged); 0 = not enough history to flag anything.
//  - usageRunway (live, no range): usage-burn.ts over the daemon's usage samples (persisted
//    in usage_samples) and the active phase's forecast (forecast.ts phaseForecastInfo).
//    weeklyBeforeP85 is usage-burn's vsForecast (hit day on or before the p85 day), true when
//    the limit is already reached, and null when unknown: no projection, no forecast, or the
//    window resets before the hit. gapDays = p85 day - hit day (calendar days; > 0 = runs
//    out that many days early).
// =====================================================================================

export const ANOMALY_TRAILING_DAYS = 14;
export const ANOMALY_MIN_DAYS = 5;
export const ANOMALY_SIGMAS = 2;
const HOUR = 3_600_000;

/** A priced build run (a cost.ts PricedRow, trimmed to what the cost figures use). */
export interface CostRun {
  id: number;
  task_id: string;
  title: string | null;
  phase_id: string | null;
  agent: string | null;
  cost: number;
  tokens: number;
  ms: number;
  created_at: number;
}

export interface ReviewRecord {
  task_id: string;
  round: number;
  verdict: string;
  created_at: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface ReworkCost {
  cost: number;
  tokens: number;
  runs: number;
  /** Rework share (0..1) of all spend in the window; null with no spend. */
  pct: number | null;
  totalCost: number;
  top: { id: string; title: string | null; cost: number; tokens: number; failedRounds: number }[];
}

/** The review round a run belongs to: its card's first review at or after the run (see the header). */
export function roundOfRun(run: Pick<CostRun, 'created_at'>, reviews: ReviewRecord[]): ReviewRecord | null {
  let best: ReviewRecord | null = null;
  for (const r of reviews) if (r.created_at >= run.created_at && (best === null || r.created_at < best.created_at)) best = r;
  return best;
}

/** Rework over runs already narrowed to the window and filter. */
export function reworkCost(runs: CostRun[], reviewsByCard: Map<string, ReviewRecord[]>): ReworkCost {
  let total = 0;
  const cards = new Map<string, { title: string | null; cost: number; tokens: number; rounds: Set<string> }>();
  let cost = 0;
  let tokens = 0;
  let n = 0;
  for (const r of runs) {
    total += r.cost;
    const rev = roundOfRun(r, reviewsByCard.get(r.task_id) ?? []);
    if (rev?.verdict !== 'fail') continue;
    cost += r.cost;
    tokens += r.tokens;
    n++;
    const c = cards.get(r.task_id) ?? { title: r.title, cost: 0, tokens: 0, rounds: new Set<string>() };
    c.cost += r.cost;
    c.tokens += r.tokens;
    c.rounds.add(`${rev.round}@${rev.created_at}`);
    cards.set(r.task_id, c);
  }
  return {
    cost: round6(cost),
    tokens,
    runs: n,
    pct: total > 0 ? cost / total : null,
    totalCost: round6(total),
    top: [...cards.entries()]
      .sort((a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([id, c]) => ({ id, title: c.title, cost: round6(c.cost), tokens: c.tokens, failedRounds: c.rounds.size })),
  };
}

/**
 * Median over credited agents of spend / active hours; null with none. Runs without a recorded
 * duration (ms = 0) are left out of both the spend and the hours.
 */
export function costPerAgentHour(runs: CostRun[]): number | null {
  const agents = new Map<string, { cost: number; ms: number }>();
  for (const r of runs) {
    if (r.ms <= 0) continue;
    const a = agents.get(r.agent ?? '') ?? { cost: 0, ms: 0 };
    a.cost += r.cost;
    a.ms += r.ms;
    agents.set(r.agent ?? '', a);
  }
  const rates = [...agents.values()].map((a) => a.cost / (a.ms / HOUR)).sort((a, b) => a - b);
  if (!rates.length) return null;
  const mid = rates.length >> 1;
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

/**
 * Waiting time with overlaps counted once per board: the union of each board's intervals,
 * clipped to [from, min(to, now)] (open intervals run to now).
 */
export function unionWaitMs(
  intervals: { project_id: string; from: number; to: number | null }[],
  win: { from: number; to: number; now: number },
): number {
  const end = Math.min(win.to, win.now);
  const byBoard = new Map<string, [number, number][]>();
  for (const i of intervals) {
    const a = Math.max(i.from, win.from);
    const b = Math.min(i.to ?? win.now, end);
    if (b <= a) continue;
    if (!byBoard.has(i.project_id)) byBoard.set(i.project_id, []);
    byBoard.get(i.project_id)!.push([a, b]);
  }
  let total = 0;
  for (const spans of byBoard.values()) {
    spans.sort((x, y) => x[0] - y[0]);
    let [cs, ce] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      if (a <= ce) ce = Math.max(ce, b);
      else {
        total += ce - cs;
        [cs, ce] = [a, b];
      }
    }
    total += ce - cs;
  }
  return total;
}

export interface SlipCard {
  id: string;
  title: string;
  lane: string;
  depends_on: string[];
}

export interface Slip {
  phase: { id: string; title: string } | null;
  basis: 'critical_path' | 'in_flight' | null;
  /** True when no critical path exists and in-flight cards stand in for it. */
  approximation: boolean;
  cards: { id: string; title: string; blockedMs: number }[];
  blockedMs: number;
  days: number;
  reason: string | null;
}

/** Days of slip from the phase's cards and their blocker intervals (open ones run to now). */
export function slipDays(
  phase: { id: string; title: string } | null,
  cards: SlipCard[],
  blockers: { task_id: string; from: number; to: number | null }[],
  now: number,
): Slip {
  if (!phase) return { phase: null, basis: null, approximation: false, cards: [], blockedMs: 0, days: 0, reason: 'no active phase' };
  const ids = new Set(cards.map((c) => c.id));
  const edges = cards.flatMap((c) => c.depends_on.filter((d) => ids.has(d)).map((d) => ({ from: d, to: c.id })));
  const chain = longestChain(cards, edges);
  const critical = chain.length >= 2;
  const onPath = critical
    ? chain.map((id) => cards.find((c) => c.id === id)!)
    : cards.filter((c) => c.lane === 'queued' || c.lane === 'in_progress' || c.lane === 'in_review');
  const blockedOf = (id: string) =>
    blockers.filter((b) => b.task_id === id).reduce((s, b) => s + Math.max(0, (b.to ?? now) - b.from), 0);
  const list = onPath.map((c) => ({ id: c.id, title: c.title, blockedMs: blockedOf(c.id) }));
  const blockedMs = list.reduce((s, c) => s + c.blockedMs, 0);
  return {
    phase,
    basis: critical ? 'critical_path' : 'in_flight',
    approximation: !critical,
    cards: list,
    blockedMs,
    days: blockedMs / 86_400_000,
    reason: critical ? null : "no critical path (no depends_on chain of 2+ cards in the phase): blocked time on the phase's in-flight cards instead",
  };
}

export interface CostAnomaly {
  range: { from: string; to: string; trailingFrom: string };
  series: { phase_id: string | null; title: string | null; days: { date: string; spend: number }[] }[];
  flagged: { date: string; phase_id: string | null; title: string | null; spend: number; mean: number; sigma: number }[];
  /** In-range days that at least one phase had >= minDays trailing days of data for (0 = not enough history). */
  judgedDays: number;
  /** The rule: trailing window length, the minimum trailing days of data, and the sigmas over the mean. */
  trailingDays: number;
  minDays: number;
  sigmas: number;
}

/** Daily spend per phase and the days over mean + 2 sigma of their trailing 14 days. */
export function costAnomaly(
  runs: Pick<CostRun, 'phase_id' | 'cost' | 'created_at'>[],
  opts: { from: number; to: number; tz: string; phaseTitles?: Map<string, string> },
): CostAnomaly {
  const fromDay = dayKey(opts.from, opts.tz);
  const toDay = dayKey(opts.to, opts.tz);
  const trailingFrom = addDays(fromDay, -ANOMALY_TRAILING_DAYS);
  const days: string[] = [];
  for (let d = trailingFrom; d <= toDay; d = addDays(d, 1)) days.push(d);
  const byPhase = new Map<string | null, Map<string, number>>();
  const firstSpend = new Map<string | null, string>(); // the phase's first spend day, over all history
  for (const r of runs) {
    const day = dayKey(r.created_at, opts.tz);
    const f = firstSpend.get(r.phase_id);
    if (f === undefined || day < f) firstSpend.set(r.phase_id, day);
    if (day < trailingFrom || day > toDay) continue;
    const m = byPhase.get(r.phase_id) ?? new Map<string, number>();
    m.set(day, (m.get(day) ?? 0) + r.cost);
    byPhase.set(r.phase_id, m);
  }
  const title = (id: string | null) => (id === null ? null : (opts.phaseTitles?.get(id) ?? null));
  const series: CostAnomaly['series'] = [];
  const flagged: CostAnomaly['flagged'] = [];
  const judged = new Set<string>();
  for (const [phase_id, m] of byPhase) {
    const spend = days.map((d) => m.get(d) ?? 0);
    const firstDay = firstSpend.get(phase_id)!;
    const first = days.findIndex((d) => d >= firstDay);
    series.push({ phase_id, title: title(phase_id), days: days.map((date, i) => ({ date, spend: round6(spend[i]) })) });
    for (let i = ANOMALY_TRAILING_DAYS; i < days.length; i++) {
      const trailing = spend.slice(Math.max(i - ANOMALY_TRAILING_DAYS, first), i);
      if (trailing.length < ANOMALY_MIN_DAYS) continue;
      judged.add(days[i]);
      const mean = trailing.reduce((s, v) => s + v, 0) / trailing.length;
      const sigma = Math.sqrt(trailing.reduce((s, v) => s + (v - mean) ** 2, 0) / trailing.length);
      // a flat-zero baseline (sigma 0, no spend) would flag any spend at all: not an anomaly signal
      if (sigma === 0 && !trailing.some((v) => v > 0)) continue;
      if (spend[i] > mean + ANOMALY_SIGMAS * sigma)
        flagged.push({ date: days[i], phase_id, title: title(phase_id), spend: round6(spend[i]), mean: round6(mean), sigma: round6(sigma) });
    }
  }
  flagged.sort((a, b) => a.date.localeCompare(b.date) || String(a.phase_id).localeCompare(String(b.phase_id)));
  return {
    range: { from: fromDay, to: toDay, trailingFrom },
    series,
    flagged,
    judgedDays: judged.size,
    trailingDays: ANOMALY_TRAILING_DAYS,
    minDays: ANOMALY_MIN_DAYS,
    sigmas: ANOMALY_SIGMAS,
  };
}

export type UsageRunway =
  | {
      status: 'ok';
      fiveHour: LimitReport | null;
      weekly: LimitReport | null;
      forecast: ForecastInfo | null;
      /** Does the weekly limit run out before the active phase's p85 finish? null = unknown (no projection / no forecast / the window resets first). */
      weeklyBeforeP85: boolean | null;
      /** p85 day - the weekly hit day, in days (> 0: runs out that many days before p85); null when weeklyBeforeP85 is. */
      gapDays: number | null;
      messages: string[];
    }
  | { status: 'unavailable'; reason: string; forecast: ForecastInfo | null };

/** The runway from a usage-burn view: when the limits run out and the weekly limit vs the p85 finish. */
export function usageRunway(burn: UsageBurn, info: ForecastInfo | null, tz: string, now: number): UsageRunway {
  if (burn.status !== 'ok') return { status: 'unavailable', reason: burn.reason, forecast: info };
  const week = burn.limits.seven_day;
  let before: boolean | null = null;
  let gap: number | null = null;
  if (week && info?.status === 'ok') {
    // usage-burn's own comparison (set when the limit is hit before its window resets); reached = runs out now
    if (week.vsForecast !== null) before = week.vsForecast !== 'after_p85';
    else if (week.state === 'reached') before = true;
    if (before !== null) {
      const [a, b] = [dayKey(week.hitsAt ?? now, tz), info.p85.date].map((d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
      gap = Math.round((b - a) / 86_400_000);
    }
  }
  return {
    status: 'ok',
    fiveHour: burn.limits.five_hour,
    weekly: week,
    forecast: info,
    weeklyBeforeP85: before,
    gapDays: gap,
    messages: burn.messages,
  };
}

export interface AgenticCost {
  range: { from: number | null; to: number; tz: string };
  currency: 'USD';
  prices: { placeholder: boolean };
  reworkCost: ReworkCost;
  decisionLatencyCost: {
    label: '$ of idle agent time';
    humanWaitHours: number;
    needsYouHours: number;
    blockedHours: number;
    /** Median over credited agents of spend / active hours in the window; null without run time. */
    costPerAgentHour: number | null;
    /** humanWaitHours x costPerAgentHour; null without a rate. */
    idleCost: number | null;
    /** Live (now), not windowed; null in a compare's previous run. */
    slip: Slip | null;
    queue:
      | { kind: 'needs_you' | 'blocker'; project_id: string; task_id: string | null; title: string | null; reason: string | null; since: number; waitingMs: number }[]
      | null;
  };
  costAnomaly: CostAnomaly;
  /** Live only; null in a compare's previous run. */
  usageRunway: UsageRunway | null;
}

/**
 * Load + compute. `project` is the requested board (its active phase drives slip and the runway);
 * `live: false` skips the live parts (a compare's previous window).
 */
export function agenticCostMetrics(
  db: DB,
  filter: CostFilter,
  opts: {
    tz: string;
    now: number;
    project: string;
    live?: boolean;
    /** The daemon's usage samples (loaded from usage_samples at startup, kept in step with it). */
    samples?: UsageSample[];
  },
): AgenticCost {
  const { tz, now } = opts;
  const to = filter.to ?? now;
  if (filter.from !== undefined) checkRange(filter.from, to);
  const table = getPrices(db);
  const priced = priceRows(loadCostRows(db, filter.projectIds, filter.phaseId), table).rows.filter((r) => matchesCostFilter(r, filter));
  const msById = new Map(
    (
      db.prepare('SELECT id, ms FROM card_activity WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(priced.map((r) => r.id))) as {
        id: number;
        ms: number;
      }[]
    ).map((r) => [r.id, r.ms]),
  );
  const runs: CostRun[] = priced.map((r) => ({
    id: r.id,
    task_id: r.task_id,
    title: r.card?.title ?? null,
    phase_id: r.card?.phase_id ?? null,
    agent: r.agent,
    cost: r.cost,
    tokens: r.tokens,
    ms: msById.get(r.id) ?? 0,
    created_at: r.created_at,
  }));
  const inWindow = runs.filter((r) => r.created_at <= to && (filter.from === undefined || r.created_at >= filter.from));

  const reviewsByCard = new Map<string, ReviewRecord[]>();
  for (const r of db
    .prepare('SELECT task_id, round, verdict, created_at FROM reviews WHERE task_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...new Set(inWindow.map((r) => r.task_id))])) as ReviewRecord[]) {
    if (!reviewsByCard.has(r.task_id)) reviewsByCard.set(r.task_id, []);
    reviewsByCard.get(r.task_id)!.push(r);
  }

  const waitFilter = { projectIds: filter.projectIds, phaseId: filter.phaseId, tag: filter.tag, agent: filter.agent, workType: filter.workType, from: filter.from, to: filter.to };
  const needs = loadNeedsYou(db, waitFilter);
  const blockers = loadBlockers(db, waitFilter);
  const wait = computeWait(needs, blockers, { tz, now, from: filter.from, to: filter.to });
  // overlapping needs_you and blocker time on a board counts once
  const waitHours =
    unionWaitMs(
      [
        ...needs.map((n) => ({ project_id: n.project_id, from: n.started_at, to: n.ended_at })),
        ...blockers.map((b) => ({ project_id: b.project_id, from: b.from, to: b.to })),
      ],
      { from: wait.range.from, to: wait.range.to, now },
    ) / HOUR;
  const rate = costPerAgentHour(inWindow);

  const phaseTitles = new Map((db.prepare('SELECT id, title FROM phases').all() as { id: string; title: string }[]).map((p) => [p.id, p.title]));
  // no from: the window starts at the first run in it (capped like every other metrics range)
  const anomalyFrom = filter.from ?? Math.max(inWindow.reduce((m, r) => Math.min(m, r.created_at), to), to - (MAX_RANGE_DAYS - 1) * 86_400_000);

  let slip: Slip | null = null;
  let queue: AgenticCost['decisionLatencyCost']['queue'] = null;
  let runway: UsageRunway | null = null;
  if (opts.live !== false) {
    const row = (
      filter.phaseId !== undefined
        ? db.prepare('SELECT id, title FROM phases WHERE id = ?').get(filter.phaseId)
        : getActivePhase(db, opts.project)
    ) as { id: string; title: string } | null | undefined;
    const phase = row ? { id: row.id, title: row.title } : null;
    const cards = phase
      ? (db.prepare('SELECT id, title, lane, depends_on FROM tasks WHERE phase_id = ? ORDER BY position, id').all(phase.id) as {
          id: string;
          title: string;
          lane: string;
          depends_on: string | null;
        }[]).map((c) => {
          let deps: unknown;
          try {
            deps = JSON.parse(c.depends_on ?? '[]');
          } catch {
            deps = [];
          }
          return { ...c, depends_on: Array.isArray(deps) ? deps.filter((d): d is string => typeof d === 'string') : [] };
        })
      : [];
    slip = slipDays(phase, cards, phase ? loadBlockers(db, { phaseId: phase.id }) : [], now);
    const needTitles = new Map(
      (db
        .prepare('SELECT id, title FROM tasks WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(wait.waiting.needsYou.flatMap((n) => (n.task_id ? [n.task_id] : [])))) as { id: string; title: string }[]).map((t) => [t.id, t.title]),
    );
    queue = [
      ...wait.waiting.needsYou.map((n) => ({
        kind: 'needs_you' as const,
        project_id: n.project_id,
        task_id: n.task_id,
        title: n.task_id ? (needTitles.get(n.task_id) ?? null) : null,
        reason: n.reason,
        since: n.since,
        waitingMs: n.waitingMs,
      })),
      ...wait.waiting.blockers.map((b) => ({ kind: 'blocker' as const, project_id: b.project_id, task_id: b.task_id, title: b.title, reason: b.reason, since: b.since, waitingMs: b.waitingMs })),
    ].sort((a, b) => a.since - b.since);
    const info = phaseForecastInfo(db, opts.project, phase, { tz, now });
    runway = usageRunway(usageBurn(opts.samples ?? [], info, { tz, now }), info, tz, now);
  }

  return {
    range: { from: filter.from ?? null, to, tz },
    currency: 'USD',
    prices: { placeholder: table.placeholder },
    reworkCost: reworkCost(inWindow, reviewsByCard),
    decisionLatencyCost: {
      label: '$ of idle agent time',
      humanWaitHours: waitHours,
      needsYouHours: wait.needsYou.totalMs / HOUR,
      blockedHours: wait.blocked.totalMs / HOUR,
      costPerAgentHour: rate === null ? null : round6(rate),
      idleCost: rate === null ? null : round6(waitHours * rate),
      slip,
      queue,
    },
    costAnomaly: costAnomaly(runs, { from: anomalyFrom, to, tz, phaseTitles }),
    usageRunway: runway,
  };
}
