/**
 * An agent's track record: the cards a team member worked on, its build runs,
 * period totals and a weekly series of the same totals. Built on the existing
 * derivations: metrics.ts (lane history, cycle time, blocked intervals, review
 * rounds), quality.ts (first pass) and cost.ts (per-run pricing).
 *
 * Attribution. `agent` is a team member name (a member id is accepted too).
 * Each card has a holder timeline from its events: an assign hands the card to
 * its event agent's member; a reassign ({from, to}) to the first of payload.to,
 * then its event agent, that resolves to a member (else the raw label, to
 * first); a redirect clears it. A label that is not a member
 * is held as-is; an assign without any label leaves nobody holding the card.
 * A card with no assign events is held by its assigned_agent for its whole
 * life. Events at the same ms as a run apply before it (an assign + run at
 * the same instant credits the new holder).
 *  - Runs (card_activity): credited to the run's agent when that label is a
 *    team member; a subagent-type label ('builder', 'reviewer', ...) or none is
 *    credited to the card's holder at the run's time, else the raw label. A run
 *    on a deleted card (no events left) only matches by label.
 *  - Blockers: the block event's agent when it is a member, else the holder.
 *  - Done / first pass: the agent held the card when it reached done / at its
 *    final review (since the last redirect).
 *  - A card counts when, in the window, the agent has credited runs on it, held
 *    it, or raised a blocker on it.
 *  - Member renames: updateTeamMember (board.ts) rewrites the agent label in
 *    card_activity, tasks and task_events, so history already carries the new
 *    name; no old-name table exists to resolve against. A reassign payload's
 *    `to` is not rewritten (an old name no longer resolves), hence the
 *    event-agent fallback above; nothing writes reassign events today.
 *
 * Per-card fields are the agent's part:
 *  - rounds: review events while the agent held the card (any time; legacy
 *    cards without review events fall back to metrics.ts's rounds when the
 *    agent holds the card now).
 *  - first_pass: quality.ts's first pass (since the last redirect) when the
 *    agent held the card at its final review; null otherwise or unreviewed.
 *  - outcome: done (held at done), reassigned / redirected (how the agent's
 *    last tenure ended), else the current lane.
 *
 * Window [from, to] (inclusive, epoch ms; both optional), applied uniformly:
 *  - runs (and so cost, tokens, hours, lines) by their time;
 *  - first/last worked: the agent's tenures and runs clamped to the window
 *    (a tenure still open runs to min(now, to));
 *  - done: done_at is always the card's done time, but the card counts as done
 *    (cardsDone, cycle time) only when done_at is inside the window;
 *  - first pass by final review time;
 *  - blockers: every agent-raised blocked interval overlapping the window,
 *    blocked_ms clipped to [from, to]; bucketed by max(start, from).
 * Weekly buckets are ISO weeks (Monday start) in `tz`, zero-filled over the window.
 * workType (optional) keeps only the cards of that type ('none' = unclassified) and the runs
 * on them, after attribution (a run on a deleted card has no type: it never matches).
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
import type { AgentHistory, AgentHistoryCard, AgentHistoryRun, AgentHistoryTotals, Lane, WorkType } from './types.js';

export interface AgentHistoryOptions {
  /** Boards in scope; a workspace id expands to itself + its verticals. */
  projectIds: string[];
  /** Team member name (or id). */
  agent: string;
  from?: number;
  to?: number;
  /** Week buckets' time zone (default: the process's local zone). */
  tz?: string;
  /** Only cards of this work type, and runs on them ('none' = unclassified). */
  workType?: WorkType | 'none';
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

function payloadField(p: string | Record<string, unknown> | null, key: string): unknown {
  let v: unknown = p;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : null;
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
      if (e.type === 'assign' || e.type === 'reassign') {
        // a reassign names the new agent in payload.to; a label that resolves to a member wins
        // (payload.to is not rewritten on a member rename, the agent column is)
        const raw = e.type === 'reassign' ? payloadField(e.payload, 'to') : null;
        const to = typeof raw === 'string' && raw ? raw : null;
        const agentLabel = e.agent ?? null;
        steps.push({ at, holder: resolve(to) ?? resolve(agentLabel) ?? to ?? agentLabel, type: 'assign' });
      }
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
  // the Type filter: cards of that work type ('none' = unclassified); a deleted card has none to match
  const typeOk = (taskId: string): boolean => {
    if (opts.workType === undefined) return true;
    const x = byId.get(taskId);
    if (!x) return false;
    const t = x.h.card.work_type ?? null;
    return opts.workType === 'none' ? t === null : t === opts.workType;
  };
  const allRuns = priced.filter((r) => creditedTo(r) === agent && typeOk(r.task_id));
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
    if (!typeOk(x.m.id)) continue;
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
    const current = tenures[tenures.length - 1];
    if (current && current.end === null) current.to = x.m.doneAt;

    const cardRuns = runsByCard.get(x.m.id) ?? [];
    const windowRuns = cardRuns.filter((r) => inWindow(r.created_at, from, to));
    const lo = from ?? -Infinity;
    const hi = to ?? Infinity;
    // the agent's tenures clamped to the window; one still open (not reassigned, redirected or done) runs to min(now, to)
    const spans = tenures
      .map((t) => ({ from: Math.max(t.from, lo), to: Math.min(t.to ?? now, hi) }))
      .filter((t) => t.from <= t.to);
    const held = tenures.some((t) => t.from <= hi && (t.to ?? now) >= lo);

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
        return (resolve(ev?.agent) ?? holderAt(x, b.from)) === agent && b.from <= hi && (b.to ?? now) >= lo;
      })
      .map((b) => ({ at: Math.max(b.from, lo), ms: Math.max(0, Math.min(b.to ?? now, hi) - Math.max(b.from, lo)) }));
    if (!windowRuns.length && !held && !blockers.length) continue;

    const q = cardQuality(x);
    const doneCounted = x.m.doneAt !== null && holderAt(x, x.m.doneAt) === agent;
    const last = tenures[tenures.length - 1];
    const outcome = last && last.end !== null ? last.end : x.m.lane;
    const worked = [...spans.flatMap((t) => [t.from, t.to]), ...windowRuns.map((r) => r.created_at), ...blockers.map((b) => b.at)];
    const lines = windowRuns.filter((r) => !extra.get(r.id)?.estimated);
    const heldAtReview = q.reviewed && holderAt(x, q.finalAt!) === agent;
    const reviewsHeld = x.d.reviews.filter((r) => holderAt(x, r.at) === agent).length;
    const rounds =
      x.d.reviews.length === 0 && x.m.reviewRoundsSource !== 'reviews' && holderAt(x, Infinity) === agent ? x.m.reviewRounds : reviewsHeld;

    facts.push({
      q,
      cycleMs: x.m.cycleTimeMs,
      doneCounted,
      qualityCounted: heldAtReview,
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
        rounds,
        first_pass: heldAtReview ? q.firstPass : null,
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
