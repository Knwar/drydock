/**
 * Agentic flow metrics: how autonomously cards ship, who stops the work, how big
 * the batches are, whether specs are met, and the governance posture. Built only
 * on what is already recorded (no new capture):
 *
 *  - autonomy:  cards done in [from, to]; autonomous = no `block` and no `redirect`
 *               event anywhere in the card's history. Weekly by the done week.
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
    top: { id: string; title: string; lines: number }[];
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
  for (const x of done) {
    const a = isAutonomous(x);
    if (a) autonomous++;
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
    return lines === undefined ? [] : [{ id: x.m.id, title: x.m.title, lines }];
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
