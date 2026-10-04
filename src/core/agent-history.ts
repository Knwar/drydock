/**
 * An agent's track record: the cards a team member worked on, its build runs,
 * period totals and a weekly series of the same totals. Built on the existing
 * derivations: metrics.ts (lane history, cycle time, blocked intervals, review
 * rounds), quality.ts (first pass) and cost.ts (per-run pricing).
 *
 * Attribution. `agent` is a team member name (a member id is accepted too).
 * Each card has a holder timeline from its events: an assign (or reassign)
 * hands the card to that label's member, a redirect clears it; a card with no
 * assign events is held by its assigned_agent for its whole life.
 *  - Runs (card_activity): credited to the run's agent when that label is a
 *    team member; a subagent-type label ('builder', 'reviewer', ...) or none is
 *    credited to the card's holder at the run's time.
 *  - Blockers: the block event's agent when it is a member, else the holder.
 *  - Done / first pass: the agent held the card when it reached done / at its
 *    final review (since the last redirect).
 *  - A card counts when the agent has credited runs in the window, or held it
 *    (assigned / reassigned to it, or assigned_agent) at some point in the window.
 *
 * Window [from, to] (inclusive, epoch ms; both optional): runs by their time,
 * blockers by their start, done by done time, first pass by final review time.
 * Weekly buckets are ISO weeks (Monday start) in `tz`, zero-filled over the window.
 */
import { memberName } from './board.js';
import { getPrices, loadCostRows, priceRows } from './cost.js';
import type { DB } from './db.js';
import {
  addDays,
  checkRange,
  dayKey,
  deriveCards,
  isoWeek,
  loadCardHistories,
  localTimeZone,
  MAX_RANGE_DAYS,
  percentile,
  sortEvents,
  type DerivedCard,
} from './metrics.js';
import { cardQuality, qualityStats, type CardQuality } from './quality.js';
import type { AgentHistory, AgentHistoryCard, AgentHistoryRun, AgentHistoryTotals, Lane } from './types.js';

export interface AgentHistoryOptions {
  /** Boards in scope; a workspace id expands to itself + its verticals. */
  projectIds: string[];
  /** Team member name (or id). */
  agent: string;
  from?: number;
  to?: number;
  /** Week buckets' time zone (default: the process's local zone). */
  tz?: string;
  now?: number;
}

/** A card with the fields beyond the base AgentHistoryCard type. */
export interface AgentHistoryCardDetail extends AgentHistoryCard {
  board: { id: string; name: string };
  phase: { id: string; title: string | null } | null;
  lane: Lane;
  first_worked_at: number | null;
  last_worked_at: number | null;
  /** First review passed; null = not reviewed (since the last redirect). */
  first_pass: boolean | null;
  blocked_ms: number;
}

export interface AgentHistoryDetail extends AgentHistory {
  cards: AgentHistoryCardDetail[];
}

const HOUR = 3_600_000;

/** A span the agent held a card: [from, to), to null = still holding. */
interface Tenure {
  from: number;
  to: number | null;
  /** What ended it: another assign, a redirect, or nothing (open). */
  end: 'reassigned' | 'redirected' | null;
}

/** Per-card facts the totals are bucketed from. */
interface CardFacts {
  card: AgentHistoryCardDetail;
  q: CardQuality;
  cycleMs: number | null;
  doneCounted: boolean; // the agent held it at done
  qualityCounted: boolean; // the agent held it at its final review
  doneWeek: string | null;
  reviewWeek: string | null;
  blockers: { at: number; ms: number }[];
}

const inWindow = (t: number, from?: number, to?: number) => (from === undefined || t >= from) && (to === undefined || t <= to);

/** Totals over a bucket: its runs and blockers, the cards done in it and the cards whose final review is in it. */
function totalsOf(runs: AgentHistoryRun[], done: CardFacts[], reviewed: CardFacts[], blockers: number): AgentHistoryTotals {
  const cycles = done.flatMap((f) => (f.cycleMs === null ? [] : [f.cycleMs])).sort((a, b) => a - b);
  return {
    cardsDone: done.length,
    firstPassRate: qualityStats(reviewed.map((f) => f.q)).firstPassRate,
    medianCycleMs: percentile(cycles, 50),
    cost: runs.reduce((s, r) => s + r.cost, 0),
    tokens: runs.reduce((s, r) => s + r.tokens, 0),
    blockers,
    hours: runs.reduce((s, r) => s + r.ms, 0) / HOUR,
  };
}

export function agentHistory(db: DB, opts: AgentHistoryOptions): AgentHistoryDetail {
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? localTimeZone();
  const { from, to } = opts;
  if (from !== undefined) checkRange(from, to ?? now);

  // Member labels: id or name → name. A label that is not a member is a subagent type.
  const members = db.prepare('SELECT id, name FROM team_members').all() as { id: string; name: string }[];
  const memberOf = new Map<string, string>();
  for (const m of members) memberOf.set(m.id, m.name);
  for (const m of members) memberOf.set(m.name, m.name);
  const agent = memberName(db, opts.agent);
  const resolve = (label: string | null | undefined): string | null => (label ? (memberOf.get(label) ?? null) : null);

  // Every card in scope (no agent/date prefilter: attribution needs the label mapping below).
  const ds = deriveCards(loadCardHistories(db, { projectIds: opts.projectIds }), now);
  const byId = new Map(ds.map((x) => [x.m.id, x]));

  // Holder timeline per card: assign/reassign → that member (or the raw label), redirect → nobody.
  const holders = new Map<string, { at: number; holder: string | null; type: 'assign' | 'redirect' }[]>();
  const holderSteps = (x: DerivedCard) => {
    let steps = holders.get(x.m.id);
    if (steps) return steps;
    steps = [];
    let prev = -Infinity;
    for (const e of sortEvents(x.h.events)) {
      const at = Math.max(e.created_at, prev); // the same clamping as deriveLaneHistory
      prev = at;
      if (e.type === 'assign' || e.type === 'reassign') steps.push({ at, holder: resolve(e.agent) ?? e.agent ?? null, type: 'assign' });
      else if (e.type === 'redirect') steps.push({ at, holder: null, type: 'redirect' });
    }
    if (!steps.length && x.h.card.assigned_agent) {
      const a = x.h.card.assigned_agent;
      steps.push({ at: -Infinity, holder: resolve(a) ?? a, type: 'assign' });
    }
    holders.set(x.m.id, steps);
    return steps;
  };
  const holderAt = (x: DerivedCard, t: number): string | null => {
    let h: string | null = null;
    for (const s of holderSteps(x)) if (s.at <= t) h = s.holder;
    return h;
  };

  // Runs: priced over the whole scope (the estimate model is the scope's, as in the cost view).
  // Label mapping ported from the daemon's /home agent status (src/daemon/server.ts, the
  // `entriesOf` / `cardAgent` block): a subagent-type label is matched to a team member
  // through the card it ran on (task_id), the raw label is the fallback.
  const priced = priceRows(loadCostRows(db, opts.projectIds), getPrices(db)).rows;
  const creditedTo = (r: (typeof priced)[number]): string | null => {
    const member = resolve(r.agent);
    if (member) return member;
    const x = byId.get(r.task_id);
    return (x ? holderAt(x, r.created_at) : null) ?? r.agent;
  };
  const allRuns = priced.filter((r) => creditedTo(r) === agent);
  const runsByCard = new Map<string, typeof allRuns>();
  for (const r of allRuns) {
    if (!runsByCard.has(r.task_id)) runsByCard.set(r.task_id, []);
    runsByCard.get(r.task_id)!.push(r);
  }
  const extra = new Map<number, { role: string | null; ms: number; lines_added: number; lines_removed: number; estimated: number }>();
  if (allRuns.length) {
    const rows = db
      .prepare(
        `SELECT id, role, ms, lines_added, lines_removed, estimated FROM card_activity
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(allRuns.map((r) => r.id))) as {
      id: number;
      role: string | null;
      ms: number;
      lines_added: number;
      lines_removed: number;
      estimated: number;
    }[];
    for (const r of rows) extra.set(r.id, r);
  }
  const toRun = (r: (typeof priced)[number]): AgentHistoryRun => ({
    task_id: r.task_id,
    role: extra.get(r.id)?.role ?? null,
    at: r.created_at,
    ms: extra.get(r.id)?.ms ?? 0,
    tokens: r.tokens,
    cost: r.cost,
  });

  // Board and phase names.
  const boardNames = new Map(
    (db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[]).map((p) => [p.id, p.name]),
  );
  const phaseTitles = new Map(
    (db.prepare('SELECT id, title FROM phases').all() as { id: string; title: string }[]).map((p) => [p.id, p.title]),
  );

  const facts: CardFacts[] = [];
  for (const x of ds) {
    const steps = holderSteps(x);
    // consecutive assigns to the same agent (a re-dispatch) extend one tenure
    const tenures: Tenure[] = [];
    for (const s of steps) {
      const open = tenures.length > 0 && tenures[tenures.length - 1].end === null && tenures[tenures.length - 1].to === null;
      if (s.holder === agent) {
        if (!open) tenures.push({ from: s.at === -Infinity ? x.m.createdAt : s.at, to: null, end: null });
      } else if (open) {
        tenures[tenures.length - 1] = { ...tenures[tenures.length - 1], to: s.at, end: s.type === 'redirect' ? 'redirected' : 'reassigned' };
      }
    }
    const last = tenures[tenures.length - 1];
    if (last && last.end === null) last.to = x.m.doneAt;

    const cardRuns = runsByCard.get(x.m.id) ?? [];
    const windowRuns = cardRuns.filter((r) => inWindow(r.created_at, from, to));
    const held = tenures.some((t) => (to === undefined || t.from <= to) && (from === undefined || (t.to ?? now) >= from));
    if (!windowRuns.length && !held) continue;

    // Blockers the agent raised: each blocked interval belongs to the block event that opened it.
    const blockEvents: { at: number; agent: string | null }[] = [];
    let prev = -Infinity;
    for (const e of sortEvents(x.h.events)) {
      const at = Math.max(e.created_at, prev);
      prev = at;
      if (e.type === 'block') blockEvents.push({ at, agent: e.agent ?? null });
    }
    const blockers = x.d.blocked
      .filter((b) => {
        const ev = blockEvents.find((e) => e.at === b.from);
        return (resolve(ev?.agent) ?? holderAt(x, b.from)) === agent && inWindow(b.from, from, to);
      })
      .map((b) => ({ at: b.from, ms: Math.max(0, (b.to ?? now) - b.from) }));

    const q = cardQuality(x);
    const doneCounted = x.m.doneAt !== null && holderAt(x, x.m.doneAt) === agent;
    const outcome = last && last.end !== null ? last.end : x.m.lane;
    const eventTimes = x.h.events.map((e) => e.created_at);
    const ends = tenures.map((t) => t.to ?? Math.max(t.from, ...eventTimes.filter((e) => e >= t.from)));
    const worked = [...tenures.map((t) => t.from), ...ends, ...cardRuns.map((r) => r.created_at)];
    const lines = windowRuns.filter((r) => !extra.get(r.id)?.estimated);

    facts.push({
      q,
      cycleMs: x.m.cycleTimeMs,
      doneCounted,
      qualityCounted: q.reviewed && holderAt(x, q.finalAt!) === agent,
      doneWeek: x.m.doneAt === null ? null : isoWeek(dayKey(x.m.doneAt, tz)).start,
      reviewWeek: q.finalAt === null ? null : isoWeek(dayKey(q.finalAt, tz)).start,
      blockers,
      card: {
        id: x.m.id,
        title: x.m.title,
        project_id: x.m.project_id,
        board: { id: x.m.project_id, name: boardNames.get(x.m.project_id) ?? x.m.project_id },
        phase: x.m.phase_id === null ? null : { id: x.m.phase_id, title: phaseTitles.get(x.m.phase_id) ?? null },
        lane: x.m.lane,
        started_at: worked.length ? Math.min(...worked) : null,
        first_worked_at: worked.length ? Math.min(...worked) : null,
        last_worked_at: worked.length ? Math.max(...worked) : null,
        done_at: x.m.doneAt,
        outcome,
        rounds: x.m.reviewRounds,
        first_pass: q.reviewed ? q.firstPass : null,
        blockers: blockers.length,
        blocked_ms: blockers.reduce((s, b) => s + b.ms, 0),
        cost: windowRuns.reduce((s, r) => s + r.cost, 0),
        tokens: windowRuns.reduce((s, r) => s + r.tokens, 0),
        lines_added: lines.reduce((s, r) => s + (extra.get(r.id)?.lines_added ?? 0), 0),
        lines_removed: lines.reduce((s, r) => s + (extra.get(r.id)?.lines_removed ?? 0), 0),
      },
    });
  }
  facts.sort((a, b) => (b.card.last_worked_at ?? 0) - (a.card.last_worked_at ?? 0) || a.card.id.localeCompare(b.card.id));

  const runs = allRuns
    .filter((r) => inWindow(r.created_at, from, to))
    .map(toRun)
    .sort((a, b) => b.at - a.at);
  const allBlockers = facts.flatMap((f) => f.blockers);

  // Weekly series over the window (default start: the earliest activity, capped like quality.ts).
  const end = to ?? now;
  const earliest = facts.reduce((m, f) => Math.min(m, f.card.first_worked_at ?? m), runs.reduce((m, r) => Math.min(m, r.at), end));
  const start = from ?? Math.max(earliest, end - (MAX_RANGE_DAYS - 1) * 86_400_000);
  const weeks: { week: string; runs: AgentHistoryRun[]; blockers: number }[] = [];
  const lastWeek = isoWeek(dayKey(end, tz)).start;
  for (let w = isoWeek(dayKey(start, tz)).start; w <= lastWeek; w = addDays(w, 7)) weeks.push({ week: w, runs: [], blockers: 0 });
  const weekIdx = new Map(weeks.map((w, i) => [w.week, i]));
  const weekOf = (t: number) => weeks[weekIdx.get(isoWeek(dayKey(t, tz)).start) ?? -1];
  for (const r of runs) weekOf(r.at)?.runs.push(r);
  for (const b of allBlockers) {
    const w = weekOf(b.at);
    if (w) w.blockers++;
  }
  const done = facts.filter((f) => f.doneCounted && inWindow(f.card.done_at!, from, to));
  const reviewed = facts.filter((f) => f.qualityCounted && inWindow(f.q.finalAt!, from, to));

  return {
    agent,
    cards: facts.map((f) => f.card),
    runs,
    totals: totalsOf(runs, done, reviewed, allBlockers.length),
    weekly: weeks.map((w) => ({
      week: w.week,
      ...totalsOf(
        w.runs,
        done.filter((f) => f.doneWeek === w.week),
        reviewed.filter((f) => f.reviewWeek === w.week),
        w.blockers,
      ),
    })),
  };
}
