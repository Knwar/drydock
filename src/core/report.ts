/**
 * Weekly status report: one read-only view assembled from the existing metrics
 * modules (schedule, flow, quality, wait-time, cost, decisions/risks,
 * milestones). Nothing is re-computed here: `loadReport` gathers the modules'
 * outputs for a project (a workspace includes its verticals) and a date range;
 * `buildReport` (pure) shapes them; `reportMarkdown` (pure) renders Markdown.
 *
 * RAG rules (per phase, from its schedule status, see schedule.ts):
 *  - on_track → green, at_risk → amber, late → red,
 *    complete / done → done, unknown → grey.
 *  - An open blocker on a card in a green phase makes it amber (the reason says
 *    so). Blockers never change another colour.
 *  - A needs-you wait on a card in the phase is listed under the phase; it does
 *    not change the colour.
 *  - The reason is the schedule's reason (+ the blocker note).
 * Overall RAG: the worst RAG of the ACTIVE phases, ordered
 *    red > amber > green > grey > done
 * so it is grey only when no active phase can be forecast. When any active
 * phase has no target date, the reason adds "N active phase(s) have no target".
 * No active phase → grey.
 *
 * Range: [from, to] epoch ms; the default is the last 7 days in the tz (the
 * end's day and the 6 days before it, from the start of the first day). `to`
 * defaults to now; `from` to the start of the day 6 days before `to`.
 */
import type { DB } from './db.js';
import { addDays, dayKey, deriveCards, flowFromDerived, loadCardHistories, startOfDay } from './metrics.js';
import { qualityFromDerived } from './quality.js';
import { waitMetrics } from './wait-time.js';
import { costMetrics, type CostBudget } from './cost.js';
import { listDecisions, listRisks, workspaceOf, type Decision, type Listed, type Risk } from './decisions.js';
import { schedule, type ScheduleStatus } from './schedule.js';
import type { Lane, PhaseStatus, WorkType } from './types.js';

export type Rag = 'green' | 'amber' | 'red' | 'done' | 'grey';

export const RAG_OF: Record<ScheduleStatus, Rag> = {
  on_track: 'green',
  at_risk: 'amber',
  late: 'red',
  complete: 'done',
  done: 'done',
  unknown: 'grey',
};

/** Worst first. */
export const RAG_SEVERITY: Rag[] = ['red', 'amber', 'green', 'grey', 'done'];

export const DEFAULT_REPORT_DAYS = 7;
export const NEXT_MILESTONE_DAYS = 14;

// ---------- input (what the loader gathers) ----------

export interface ReportPhaseInput {
  id: string;
  project_id: string;
  title: string;
  phase_status: PhaseStatus;
  status: ScheduleStatus;
  reason: string;
  target_date: string | null;
  p50: string | null;
  p85: string | null;
  /** schedule.ts's p95 (same simulation as p50/p85); absent = no forecast. */
  p95?: string | null;
  total: number;
  remaining: number;
}

export interface ReportCardInput {
  id: string;
  title: string;
  project_id: string;
  phase_id: string | null;
  lane: Lane;
  doneAt: number | null;
}

export interface ReportInput {
  project: { id: string; name: string };
  /** The workspace, when the project is a vertical. */
  workspace: { id: string; name: string } | null;
  /** The boards in scope (the project first). */
  boards: { id: string; name: string }[];
  range: { from: number; to: number; tz: string };
  today: string;
  generatedAt: number;
  phases: ReportPhaseInput[];
  milestones: { id: string; project_id: string; title: string; date: string; phase_id: string | null }[];
  cards: ReportCardInput[];
  blockers: { project_id: string; task_id: string; title: string; phase_id: string | null; reason: string | null; since: number }[];
  needsYou: { project_id: string; task_id: string | null; reason: string | null; since: number }[];
  flow: { throughput: number; cycleP50: number | null; cycleP85: number | null };
  quality: { firstPassRate: number | null; reviewed: number };
  wait: { needsYouMs: number; needsYouCount: number };
  cost: { total: number; runs: number; placeholder: boolean; caveats: string[]; budgets: CostBudget[]; tokenBasisChangedAt: number | null };
  risks: Listed<Risk>[];
  decisions: Listed<Decision>[];
}

// ---------- output ----------

export interface ReportCard {
  id: string;
  title: string;
  project_id: string;
  board: string;
  phase_id: string | null;
  phase: string | null;
}

export interface ReportPhase {
  id: string;
  project_id: string;
  board: string;
  title: string;
  phase_status: PhaseStatus;
  schedule_status: ScheduleStatus;
  rag: Rag;
  reason: string;
  target_date: string | null;
  p50: string | null;
  p85: string | null;
  p95: string | null;
  total: number;
  remaining: number;
  blockers: { task_id: string; title: string; reason: string | null; since: number }[];
  needs_you: { task_id: string; title: string; reason: string | null; since: number }[];
}

export interface Report {
  project: { id: string; name: string };
  workspace: { id: string; name: string } | null;
  boards: { id: string; name: string }[];
  range: { from: number; to: number; tz: string; from_day: string; to_day: string };
  today: string;
  generated_at: number;
  overall: { rag: Rag; reason: string };
  phases: ReportPhase[];
  blockers: (ReportCard & { reason: string | null; since: number })[];
  shipped: {
    total: number;
    boards: { project_id: string; board: string; phases: { phase_id: string | null; phase: string | null; cards: (ReportCard & { done_at: number })[] }[] }[];
  };
  next: {
    queued: ReportCard[];
    in_progress: ReportCard[];
    in_review: ReportCard[];
    milestones: { id: string; title: string; date: string; board: string; phase: string | null }[];
  };
  metrics: {
    throughput: number;
    cycle_time: { p50_ms: number | null; p85_ms: number | null };
    first_pass: { rate: number | null; reviewed: number };
    waiting_on_you: { total_ms: number; count: number; now: { count: number; longest_ms: number | null } };
    cost: {
      total_usd: number;
      runs: number;
      placeholder_prices: boolean;
      budgets: { phase_id: string; phase: string; budget_usd: number; actual_usd: number; projected_usd: number | null; status: 'over' | 'projected_over' | 'ok' }[];
      /** The cost module's caveats, as sent. */
      caveats: string[];
      /** The same in plain language (placeholder prices first), for people. */
      notes: string[];
    };
  };
  risks: {
    open: (Listed<Risk> & { board: string })[];
    closed: (Listed<Risk> & { board: string })[];
  };
  decisions: {
    made: (Listed<Decision> & { board: string })[];
    superseded: (Listed<Decision> & { board: string })[];
  };
}

// ---------- pure rules ----------

/** A phase's RAG: its schedule status mapped (see the header), green → amber on an open blocker. */
export function phaseRag(status: ScheduleStatus, openBlockers: number): Rag {
  const rag = RAG_OF[status];
  return rag === 'green' && openBlockers > 0 ? 'amber' : rag;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The worst RAG of the active phases (grey with none), noting active phases without a target. */
export function overallRag(
  phases: Pick<ReportPhase, 'phase_status' | 'rag' | 'title' | 'target_date'>[],
): { rag: Rag; reason: string } {
  const active = phases.filter((p) => p.phase_status === 'active');
  if (!active.length) return { rag: 'grey', reason: 'no active phase' };
  const worst = [...active].sort((a, b) => RAG_SEVERITY.indexOf(a.rag) - RAG_SEVERITY.indexOf(b.rag))[0];
  const same = active.filter((p) => p.rag === worst.rag).map((p) => p.title);
  const untargeted = active.filter((p) => p.target_date === null).length;
  const note = untargeted ? `; ${untargeted === 1 ? '1 active phase has' : `${untargeted} active phases have`} no target` : '';
  return { rag: worst.rag, reason: `worst active phase${same.length > 1 ? 's' : ''}: ${same.join(', ')}${note}` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 3 Aug (a YYYY-MM-DD day). */
const shortDay = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

/**
 * The cost caveats in plain language. Mirrors the Metrics view's cost notes
 * (src/overlay/app.js mxCostNotes): keep the two in step. Unknown caveats pass
 * through as sent. `since` = the day token counts switched basis (null = never).
 */
export function costNotes(placeholder: boolean, caveats: string[], since: string | null): string[] {
  const s = since === null ? null : shortDay(since);
  const notes = placeholder ? ['Prices are placeholders: set your rates in Settings → Prices'] : [];
  for (const raw of caveats) {
    if (raw.startsWith('output tokens come from transcripts')) notes.push('Output tokens are undercounted, so costs read low');
    else if (raw.startsWith('estimated cost ('))
      notes.push(s ? `Costs before ${s} are estimates` : 'These costs are estimates (no run has a token breakdown yet)');
    else if (raw.startsWith('totals.tokens and estimated.tokens include'))
      notes.push(s ? `Token totals before ${s} are roughly double-counted` : 'Token totals are roughly double-counted');
    else notes.push(raw);
  }
  return notes;
}

/** Shape the modules' outputs into the report (pure). */
export function buildReport(input: ReportInput): Report {
  const { range } = input;
  const inRange = (t: number | null) => t !== null && t >= range.from && t <= range.to;
  const boardName = new Map(input.boards.map((b) => [b.id, b.name]));
  const phaseTitle = new Map(input.phases.map((p) => [p.id, p.title]));
  const cardById = new Map(input.cards.map((c) => [c.id, c]));
  const board = (id: string) => boardName.get(id) ?? id;
  const card = (c: { id: string; title: string; project_id: string; phase_id: string | null }): ReportCard => ({
    id: c.id,
    title: c.title,
    project_id: c.project_id,
    board: board(c.project_id),
    phase_id: c.phase_id,
    phase: c.phase_id === null ? null : (phaseTitle.get(c.phase_id) ?? null),
  });

  const phases: ReportPhase[] = input.phases.map((p) => {
    const blockers = input.blockers
      .filter((b) => b.phase_id === p.id)
      .map((b) => ({ task_id: b.task_id, title: b.title, reason: b.reason, since: b.since }));
    const needs = input.needsYou.flatMap((n) => {
      const c = n.task_id === null ? undefined : cardById.get(n.task_id);
      return c && c.phase_id === p.id ? [{ task_id: c.id, title: c.title, reason: n.reason, since: n.since }] : [];
    });
    const rag = phaseRag(p.status, blockers.length);
    const reason = rag !== RAG_OF[p.status] ? `${p.reason}; ${plural(blockers.length, 'open blocker')}` : p.reason;
    return {
      id: p.id,
      project_id: p.project_id,
      board: board(p.project_id),
      title: p.title,
      phase_status: p.phase_status,
      schedule_status: p.status,
      rag,
      reason,
      target_date: p.target_date,
      p50: p.p50,
      p85: p.p85,
      p95: p.p95 ?? null,
      total: p.total,
      remaining: p.remaining,
      blockers,
      needs_you: needs,
    };
  });

  // shipped: done in range, grouped by board (scope order) then phase (phase order, no phase last)
  const done = input.cards.filter((c) => c.lane === 'done' && inRange(c.doneAt)).sort((a, b) => a.doneAt! - b.doneAt!);
  const phaseOrder = new Map(input.phases.map((p, i) => [p.id, i]));
  const shippedBoards = input.boards
    .map((b) => {
      const mine = done.filter((c) => c.project_id === b.id);
      const keys = [...new Set(mine.map((c) => c.phase_id))].sort(
        (x, y) => (x === null ? Infinity : (phaseOrder.get(x) ?? 1e9)) - (y === null ? Infinity : (phaseOrder.get(y) ?? 1e9)),
      );
      return {
        project_id: b.id,
        board: b.name,
        phases: keys.map((k) => ({
          phase_id: k,
          phase: k === null ? null : (phaseTitle.get(k) ?? null),
          cards: mine.filter((c) => c.phase_id === k).map((c) => ({ ...card(c), done_at: c.doneAt! })),
        })),
      };
    })
    .filter((b) => b.phases.length);

  const lastMilestoneDay = addDays(input.today, NEXT_MILESTONE_DAYS);
  const budgets = input.cost.budgets
    .filter((b) => b.budget !== null)
    .map((b) => ({
      phase_id: b.phase_id,
      phase: b.title,
      budget_usd: b.budget!,
      actual_usd: b.actual,
      projected_usd: b.projected,
      status: (b.overBudget ? 'over' : b.projectedOverBudget ? 'projected_over' : 'ok') as 'over' | 'projected_over' | 'ok',
    }));
  const withBoard = <T extends { project_id: string }>(x: T) => ({ ...x, board: board(x.project_id) });
  const made = input.decisions.filter((d) => inRange(d.decided_at));
  const madeIds = new Set(made.map((d) => d.id));

  return {
    project: input.project,
    workspace: input.workspace,
    boards: input.boards,
    range: { ...range, from_day: dayKey(range.from, range.tz), to_day: dayKey(range.to, range.tz) },
    today: input.today,
    generated_at: input.generatedAt,
    overall: overallRag(phases),
    phases,
    blockers: input.blockers.map((b) => ({ ...card({ id: b.task_id, ...b }), reason: b.reason, since: b.since })),
    shipped: { total: done.length, boards: shippedBoards },
    next: {
      queued: input.cards.filter((c) => c.lane === 'queued').map(card),
      in_progress: input.cards.filter((c) => c.lane === 'in_progress').map(card),
      in_review: input.cards.filter((c) => c.lane === 'in_review').map(card),
      milestones: input.milestones
        .filter((m) => m.date >= input.today && m.date <= lastMilestoneDay)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((m) => ({
          id: m.id,
          title: m.title,
          date: m.date,
          board: board(m.project_id),
          phase: m.phase_id === null ? null : (phaseTitle.get(m.phase_id) ?? null),
        })),
    },
    metrics: {
      throughput: input.flow.throughput,
      cycle_time: { p50_ms: input.flow.cycleP50, p85_ms: input.flow.cycleP85 },
      first_pass: { rate: input.quality.firstPassRate, reviewed: input.quality.reviewed },
      waiting_on_you: {
        total_ms: input.wait.needsYouMs,
        count: input.wait.needsYouCount,
        now: {
          count: input.needsYou.length,
          longest_ms: input.needsYou.length ? Math.max(...input.needsYou.map((n) => input.generatedAt - n.since)) : null,
        },
      },
      cost: {
        total_usd: input.cost.total,
        runs: input.cost.runs,
        placeholder_prices: input.cost.placeholder,
        budgets,
        caveats: input.cost.caveats,
        notes: costNotes(
          input.cost.placeholder,
          input.cost.caveats,
          input.cost.tokenBasisChangedAt === null ? null : dayKey(input.cost.tokenBasisChangedAt, range.tz),
        ),
      },
    },
    risks: {
      open: input.risks.filter((r) => r.status === 'open' || r.status === 'mitigating').map(withBoard),
      closed: input.risks.filter((r) => (r.status === 'closed' || r.status === 'occurred') && inRange(r.closed_at)).map(withBoard),
    },
    decisions: {
      made: made.map(withBoard),
      superseded: input.decisions.filter((d) => d.status === 'superseded' && inRange(d.updated_at) && !madeIds.has(d.id)).map(withBoard),
    },
  };
}

// ---------- DB loader ----------

export class ReportParamError extends Error {}

/** The default range ending at `to` (default now): from the start of the day 6 days before `to`'s day (in tz). */
export function defaultRange(to: number, tz: string, days = DEFAULT_REPORT_DAYS): { from: number; to: number } {
  return { from: startOfDay(addDays(dayKey(to, tz), -(days - 1)), tz), to };
}

/** Gather every module's output for `projectId` (+ its verticals) over [from, to] and build the report. */
/**
 * workType (a work type, or 'none' for unclassified cards that still exist)
 * narrows the card-based parts: cards, flow, quality, waits/blockers and cost.
 * The phase table (schedule) stays whole: it is per phase, not per card.
 */
export function loadReport(
  db: DB,
  projectId: string,
  opts: { tz: string; now: number; from?: number; to?: number; workType?: WorkType | 'none' },
): Report {
  const { tz, now } = opts;
  const to = opts.to ?? now;
  const from = opts.from ?? defaultRange(to, tz).from;
  if (from > to) throw new ReportParamError('from must be <= to');
  const ws = workspaceOf(db, projectId);
  const names = db.prepare('SELECT id, name FROM projects WHERE id = ? OR parent_id = ? ORDER BY created_at, rowid').all(projectId, projectId) as {
    id: string;
    name: string;
  }[];
  const self = names.find((b) => b.id === projectId)!;
  const boards = [self, ...names.filter((b) => b.id !== projectId)];
  const wsRow = ws === projectId ? null : (db.prepare('SELECT id, name FROM projects WHERE id = ?').get(ws) as { id: string; name: string });

  const sched = schedule(db, projectId, { tz, now });
  const { workType } = opts;
  const ds = deriveCards(loadCardHistories(db, { projectIds: [projectId], workType }), now);
  const flow = flowFromDerived(ds, { tz, now, from, to });
  const quality = qualityFromDerived(ds, { tz, now, from, to });
  const wait = waitMetrics(db, { projectIds: [projectId], workType, from, to }, { tz, now });
  const cost = costMetrics(db, { projectIds: [projectId], workType, from, to }, { tz, now });

  return buildReport({
    project: self,
    workspace: wsRow,
    boards,
    range: { from, to, tz },
    today: sched.today,
    generatedAt: now,
    phases: sched.phases,
    milestones: sched.milestones,
    cards: ds.filter((x) => !x.m.deleted).map(({ m }) => ({ id: m.id, title: m.title, project_id: m.project_id, phase_id: m.phase_id, lane: m.lane, doneAt: m.doneAt })),
    blockers: wait.waiting.blockers,
    needsYou: wait.waiting.needsYou,
    flow: { throughput: flow.throughput.total, cycleP50: flow.cycleTime.p50, cycleP85: flow.cycleTime.p85 },
    quality: { firstPassRate: quality.totals.firstPassRate, reviewed: quality.totals.reviewed },
    wait: { needsYouMs: wait.needsYou.totalMs, needsYouCount: wait.needsYou.count },
    cost: { total: cost.totals.cost, runs: cost.totals.runs, placeholder: cost.prices.placeholder, caveats: cost.caveats, budgets: cost.budgets, tokenBasisChangedAt: cost.tokenBasisChangedAt },
    risks: listRisks(db, projectId),
    decisions: listDecisions(db, projectId),
  });
}

// ---------- Markdown ----------

const RAG_LABEL: Record<Rag, string> = { green: 'Green', amber: 'Amber', red: 'Red', done: 'Done', grey: 'Grey' };

/** A duration: 45m, 5.5h, 3.2d. */
export function fmtSpan(ms: number | null): string {
  if (ms === null) return 'n/a';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}h`;
  const d = h / 24;
  return `${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)}d`;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;
/** One line of plain text: no newlines. */
const line = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();
/**
 * User text as inert Markdown on one line: backslash-escapes the inline syntax
 * (emphasis, code, links/images, HTML, headings, quotes, tables, entities) and a
 * leading list marker (1. / - / +), so a title can't restyle or restructure the page.
 */
export const mdEscape = (s: string) =>
  line(s)
    .replace(/[\\`*_[\]()<>#|~&!]/g, '\\$&')
    .replace(/^(\d+)\./, '$1\\.')
    .replace(/^([-+=])/, '\\$1');
const esc = mdEscape;

/** The report as Markdown: headings, a phase table, bullet lists. */
export function reportMarkdown(r: Report): string {
  const out: string[] = [];
  const title = r.workspace ? `${r.workspace.name} / ${r.project.name}` : r.project.name;
  out.push(`# Status report: ${esc(title)}`, '');
  out.push(`**${r.range.from_day} to ${r.range.to_day}** (${r.range.tz}) · Overall: **${RAG_LABEL[r.overall.rag]}** (${esc(r.overall.reason)})`, '');

  out.push('## Phases', '');
  if (!r.phases.length) out.push('_No phases._', '');
  else {
    const multi = r.boards.length > 1;
    out.push(`| ${multi ? 'Board | ' : ''}Phase | RAG | Target | Cards left | Reason |`);
    out.push(`|${multi ? ' --- |' : ''} --- | --- | --- | --- | --- |`);
    for (const p of r.phases)
      out.push(
        `| ${multi ? `${esc(p.board)} | ` : ''}${esc(p.title)} | ${RAG_LABEL[p.rag]} | ${p.target_date ?? '-'} | ${p.remaining}/${p.total} | ${esc(p.reason)} |`,
      );
    out.push('');
    const waits = r.phases.flatMap((p) => [
      ...p.blockers.map((b) => `- Blocked in ${esc(p.title)}: ${esc(b.title)}${b.reason ? ` (${esc(b.reason)})` : ''}`),
      ...p.needs_you.map((n) => `- Waiting on you in ${esc(p.title)}: ${esc(n.title)}${n.reason ? ` (${esc(n.reason)})` : ''}`),
    ]);
    if (waits.length) out.push(...waits, '');
  }

  const unphased = r.blockers.filter((b) => b.phase_id === null);
  if (unphased.length) {
    out.push('## Blockers (no phase)', '');
    for (const b of unphased) out.push(`- ${esc(b.title)} [${esc(b.board)}]${b.reason ? `: ${esc(b.reason)}` : ''}`);
    out.push('');
  }

  out.push(`## Shipped (${r.shipped.total})`, '');
  if (!r.shipped.total) out.push('_Nothing shipped in this range._', '');
  for (const b of r.shipped.boards) {
    out.push(`### ${esc(b.board)}`, '');
    for (const p of b.phases) {
      out.push(`- **${esc(p.phase ?? 'No phase')}**`);
      for (const c of p.cards) out.push(`  - ${esc(c.title)}`);
    }
    out.push('');
  }

  out.push('## Next', '');
  const next = (label: string, cards: ReportCard[]) => {
    out.push(`**${label} (${cards.length})**`, '');
    if (!cards.length) out.push('- none');
    for (const c of cards) out.push(`- ${esc(c.title)} [${esc(c.board)}${c.phase ? ` · ${esc(c.phase)}` : ''}]`);
    out.push('');
  };
  next('In progress', r.next.in_progress);
  next('In review', r.next.in_review);
  next('Queued', r.next.queued);
  out.push(`**Milestones in the next ${NEXT_MILESTONE_DAYS} days (${r.next.milestones.length})**`, '');
  if (!r.next.milestones.length) out.push('- none');
  for (const m of r.next.milestones) out.push(`- ${m.date}: ${esc(m.title)} [${esc(m.board)}${m.phase ? ` · ${esc(m.phase)}` : ''}]`);
  out.push('');

  const m = r.metrics;
  out.push('## Metrics', '');
  out.push(`- Throughput: ${plural(m.throughput, 'card')} done`);
  out.push(`- Cycle time: p50 ${fmtSpan(m.cycle_time.p50_ms)}, p85 ${fmtSpan(m.cycle_time.p85_ms)}`);
  out.push(
    `- First-pass review rate: ${m.first_pass.rate === null ? 'n/a' : `${Math.round(m.first_pass.rate * 100)}%`} (${plural(m.first_pass.reviewed, 'reviewed card')})`,
  );
  out.push(
    `- Waiting on you: ${fmtSpan(m.waiting_on_you.total_ms)} over ${plural(m.waiting_on_you.count, 'wait')}; now ${m.waiting_on_you.now.count ? `${m.waiting_on_you.now.count} waiting (longest ${fmtSpan(m.waiting_on_you.now.longest_ms)})` : 'none waiting'}`,
  );
  out.push(`- Cost: ${money(m.cost.total_usd)} over ${plural(m.cost.runs, 'run')}${m.cost.placeholder_prices ? ' (placeholder prices)' : ''}`);
  for (const b of m.cost.budgets)
    out.push(
      `  - Budget ${esc(b.phase)}: ${money(b.actual_usd)} of ${money(b.budget_usd)}${b.projected_usd === null ? '' : `, projected ${money(b.projected_usd)}`} (${b.status === 'over' ? 'over budget' : b.status === 'projected_over' ? 'projected over budget' : 'on budget'})`,
    );
  if (m.cost.notes.length) {
    out.push('', '_Cost notes:_', '');
    for (const c of m.cost.notes) out.push(`- ${esc(c)}`);
  }
  out.push('');

  out.push('## Risks', '');
  if (!r.risks.open.length && !r.risks.closed.length) out.push('_No open risks._', '');
  for (const x of r.risks.open)
    out.push(`- **${x.score}** ${esc(x.title)} (${x.status}${x.owner ? `, owner ${esc(x.owner)}` : ''})${x.mitigation ? `: ${esc(x.mitigation)}` : ''}`);
  for (const x of r.risks.closed) out.push(`- ${x.status === 'occurred' ? 'Occurred' : 'Closed'}: ${esc(x.title)}`);
  if (r.risks.open.length || r.risks.closed.length) out.push('');

  out.push('## Decisions', '');
  if (!r.decisions.made.length && !r.decisions.superseded.length) out.push('_No decisions in this range._', '');
  for (const d of r.decisions.made)
    out.push(`- ${dayKey(d.decided_at, r.range.tz)}: **${esc(d.title)}**: ${esc(d.decision)}${d.status === 'superseded' ? ' (since superseded)' : ''}`);
  for (const d of r.decisions.superseded) out.push(`- Superseded: ${esc(d.title)}`);
  if (r.decisions.made.length || r.decisions.superseded.length) out.push('');

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
