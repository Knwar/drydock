/**
 * Daily snapshots of each phase (forecast, scope, spend, risk, RAG) and of each
 * milestone's date, so trends and "what changed since X" can be read back.
 *
 * `takeSnapshots` upserts one phase_snapshots row per phase of the project (a
 * workspace includes its verticals', as in schedule.ts) and one
 * milestone_snapshots row per milestone in scope, keyed by day: running it
 * again on the same day overwrites that day's rows.
 *
 *  - p50/p85/p95: schedule.ts's Monte Carlo with a fixed seed (deterministic).
 *  - spend_usd / budget_usd: cost.ts's per-phase budgets (all-time actual).
 *  - open_risk_score: sum of likelihood x impact of the open|mitigating risks
 *    linked to the phase (governance_links, target_type 'phase'). A phase with
 *    NO risk links at all (whatever their status) instead takes its board's
 *    unlinked open|mitigating risks (risks with no governance_links row of any
 *    kind), so a board that never links risks still shows its exposure on
 *    every phase. A phase whose linked risks are all closed scores 0.
 *  - rag: report.ts's phaseRag (schedule status + open blockers on the
 *    phase's cards), normalised to the column's red|amber|green: 'done' (a
 *    complete/done phase) → green, 'grey' (unknown) → null.
 */
import type { DB } from './db.js';
import type { MilestoneSnapshot, PhaseSnapshot } from './types.js';
import { dayKey } from './metrics.js';
import { schedule } from './schedule.js';
import { costMetrics } from './cost.js';
import { phaseRag, type Rag } from './report.js';
import { projectScope } from './decisions.js';

/** The fixed seed snapshots forecast with, so a day's numbers are reproducible. */
export const SNAPSHOT_SEED = 1;

const DAY = 86_400_000;

export interface SnapshotOptions {
  tz?: string;
  now?: number;
  seed?: number;
}

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const ragColumn = (r: Rag): string | null => (r === 'done' ? 'green' : r === 'grey' ? null : r);

/** Upsert `date`'s phase and milestone snapshots for `projectId` (default date: today, local). */
export function takeSnapshots(
  db: DB,
  projectId: string,
  date?: string,
  opts: SnapshotOptions = {},
): { phases: number; milestones: number } {
  const tz = opts.tz ?? localTz();
  const now = opts.now ?? Date.now();
  const day = date ?? dayKey(now, tz);
  const sched = schedule(db, projectId, { tz, now, seed: opts.seed ?? SNAPSHOT_SEED });
  const budgets = new Map(costMetrics(db, { projectIds: [projectId] }, { tz, now }).budgets.map((b) => [b.phase_id, b]));

  const blockers = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE phase_id = ? AND blocked_at IS NOT NULL AND lane != 'done'",
  );
  const riskLinks = db.prepare(
    "SELECT COUNT(*) AS n FROM governance_links WHERE kind = 'risk' AND target_type = 'phase' AND target_id = ?",
  );
  const linkedScore = db.prepare(
    `SELECT COALESCE(SUM(r.likelihood * r.impact), 0) AS s FROM risks r
      WHERE r.status IN ('open', 'mitigating')
        AND EXISTS (SELECT 1 FROM governance_links g WHERE g.kind = 'risk' AND g.item_id = r.id AND g.target_type = 'phase' AND g.target_id = ?)`,
  );
  const unlinkedScore = db.prepare(
    `SELECT COALESCE(SUM(r.likelihood * r.impact), 0) AS s FROM risks r
      WHERE r.project_id = ? AND r.status IN ('open', 'mitigating')
        AND NOT EXISTS (SELECT 1 FROM governance_links g WHERE g.kind = 'risk' AND g.item_id = r.id)`,
  );
  const upsertPhase = db.prepare(
    `INSERT INTO phase_snapshots (project_id, phase_id, date, target_date, p50, p85, p95, scope, done, budget_usd, spend_usd, open_risk_score, rag, created_at)
     VALUES (@project_id, @phase_id, @date, @target_date, @p50, @p85, @p95, @scope, @done, @budget_usd, @spend_usd, @open_risk_score, @rag, @created_at)
     ON CONFLICT (phase_id, date) DO UPDATE SET
       project_id = excluded.project_id, target_date = excluded.target_date, p50 = excluded.p50, p85 = excluded.p85,
       p95 = excluded.p95, scope = excluded.scope, done = excluded.done, budget_usd = excluded.budget_usd,
       spend_usd = excluded.spend_usd, open_risk_score = excluded.open_risk_score, rag = excluded.rag,
       created_at = excluded.created_at`,
  );
  const upsertMilestone = db.prepare(
    `INSERT INTO milestone_snapshots (milestone_id, project_id, date, milestone_date) VALUES (?, ?, ?, ?)
     ON CONFLICT (milestone_id, date) DO UPDATE SET project_id = excluded.project_id, milestone_date = excluded.milestone_date`,
  );

  return db.transaction(() => {
    for (const p of sched.phases) {
      const linked = (riskLinks.get(p.id) as { n: number }).n > 0;
      const score = linked
        ? (linkedScore.get(p.id) as { s: number }).s
        : (unlinkedScore.get(p.project_id) as { s: number }).s;
      const row: PhaseSnapshot = {
        project_id: p.project_id,
        phase_id: p.id,
        date: day,
        target_date: p.target_date,
        p50: p.p50,
        p85: p.p85,
        p95: p.p95 ?? null,
        scope: p.total,
        done: p.total - p.remaining,
        budget_usd: budgets.get(p.id)?.budget ?? null,
        spend_usd: budgets.get(p.id)?.actual ?? 0,
        open_risk_score: score,
        rag: ragColumn(phaseRag(p.status, (blockers.get(p.id) as { n: number }).n)),
        created_at: now,
      };
      upsertPhase.run(row);
    }
    for (const m of sched.milestones) upsertMilestone.run(m.id, m.project_id, day, m.date);
    return { phases: sched.phases.length, milestones: sched.milestones.length };
  })();
}

export interface MilestoneSeries {
  milestone_id: string;
  /** null when the milestone has since been deleted. */
  title: string | null;
  series: { date: string; milestone_date: string }[];
}

export interface History {
  phases: PhaseSnapshot[];
  milestones: MilestoneSeries[];
}

/**
 * Snapshots of `projectId`'s phases (a workspace includes its verticals') in
 * [from, to] (inclusive YYYY-MM-DD, both optional), ordered by date; plus the
 * milestone series in the project's scope (projectScope, as listMilestones),
 * each ordered by date. With `phaseId`, only that phase's rows and the
 * milestones currently tied to it.
 */
export function getHistory(db: DB, projectId: string, q: { phaseId?: string; from?: string; to?: string } = {}): History {
  const where: string[] = [];
  const params: string[] = [];
  if (q.from !== undefined) {
    where.push('s.date >= ?');
    params.push(q.from);
  }
  if (q.to !== undefined) {
    where.push('s.date <= ?');
    params.push(q.to);
  }
  const range = where.length ? `AND ${where.join(' AND ')}` : '';

  const phaseSql = q.phaseId !== undefined ? 'AND s.phase_id = ?' : '';
  const phases = db
    .prepare(
      `SELECT s.* FROM phase_snapshots s
        WHERE (s.project_id = ? OR s.project_id IN (SELECT id FROM projects WHERE parent_id = ?)) ${phaseSql} ${range}
        ORDER BY s.date, s.project_id, s.phase_id`,
    )
    .all(projectId, projectId, ...(q.phaseId !== undefined ? [q.phaseId] : []), ...params) as PhaseSnapshot[];

  const ids = [...projectScope(db, projectId).keys()];
  const msPhaseSql = q.phaseId !== undefined ? 'AND m.phase_id = ?' : '';
  const rows = db
    .prepare(
      `SELECT s.milestone_id, m.title, s.date, s.milestone_date FROM milestone_snapshots s
         LEFT JOIN milestones m ON m.id = s.milestone_id
        WHERE s.project_id IN (${ids.map(() => '?').join(', ')}) ${msPhaseSql} ${range}
        ORDER BY s.milestone_id, s.date`,
    )
    .all(...ids, ...(q.phaseId !== undefined ? [q.phaseId] : []), ...params) as (MilestoneSnapshot & { title: string | null })[];
  const series = new Map<string, MilestoneSeries>();
  for (const r of rows) {
    let s = series.get(r.milestone_id);
    if (!s) series.set(r.milestone_id, (s = { milestone_id: r.milestone_id, title: r.title, series: [] }));
    s.series.push({ date: r.date, milestone_date: r.milestone_date });
  }
  return { phases, milestones: [...series.values()] };
}

export interface Deltas {
  phase_id: string;
  /** The baseline and latest snapshot days compared. */
  from: string;
  to: string;
  /** Days the p85 forecast and the target moved (positive = later); null when either side lacks one. */
  slipDays: { p85: number | null; target: number | null };
  /** pct is a percentage of the baseline scope (null when the baseline was 0 or unknown). */
  scopeChange: { abs: number | null; pct: number | null };
  budgetChange: number | null;
  spendChange: number | null;
  riskScoreChange: number | null;
  /** Milestones tied to the phase whose date moved between the two days (days: positive = later). */
  milestoneMoves: { id: string; title: string; fromDate: string; toDate: string; days: number }[];
}

const daysBetween = (a: string | null, b: string | null): number | null =>
  a === null || b === null ? null : Math.round((Date.parse(b) - Date.parse(a)) / DAY);

const diff = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : Math.round((b - a) * 1e6) / 1e6;

/**
 * Compare a phase's latest snapshot (the latest on or before `untilDate` when
 * given) with a baseline: the earliest snapshot on or after `sinceDate`, or its
 * first snapshot without one. null when there is no snapshot to compare (none
 * at all, or none in [sinceDate, untilDate]).
 */
export function deltasSince(db: DB, phaseId: string, sinceDate?: string, untilDate?: string): Deltas | null {
  const base = db
    .prepare('SELECT * FROM phase_snapshots WHERE phase_id = ? AND date >= ? ORDER BY date LIMIT 1')
    .get(phaseId, sinceDate ?? '') as PhaseSnapshot | undefined;
  const last = (
    untilDate === undefined
      ? db.prepare('SELECT * FROM phase_snapshots WHERE phase_id = ? ORDER BY date DESC LIMIT 1').get(phaseId)
      : db.prepare('SELECT * FROM phase_snapshots WHERE phase_id = ? AND date <= ? ORDER BY date DESC LIMIT 1').get(phaseId, untilDate)
  ) as PhaseSnapshot | undefined;
  if (!base || !last || base.date > last.date) return null;

  const scopeAbs = diff(base.scope, last.scope);
  const msAt = db.prepare(
    'SELECT milestone_date FROM milestone_snapshots WHERE milestone_id = ? AND date >= ? AND date <= ? ORDER BY date LIMIT 1',
  );
  const msLast = db.prepare(
    'SELECT milestone_date FROM milestone_snapshots WHERE milestone_id = ? AND date <= ? ORDER BY date DESC LIMIT 1',
  );
  const milestones = db.prepare('SELECT id, title FROM milestones WHERE phase_id = ? ORDER BY date, created_at, rowid').all(phaseId) as {
    id: string;
    title: string;
  }[];
  const milestoneMoves: Deltas['milestoneMoves'] = [];
  for (const m of milestones) {
    const a = msAt.get(m.id, base.date, last.date) as { milestone_date: string } | undefined;
    const b = msLast.get(m.id, last.date) as { milestone_date: string } | undefined;
    if (!a || !b || a.milestone_date === b.milestone_date) continue;
    milestoneMoves.push({ id: m.id, title: m.title, fromDate: a.milestone_date, toDate: b.milestone_date, days: daysBetween(a.milestone_date, b.milestone_date)! });
  }

  return {
    phase_id: phaseId,
    from: base.date,
    to: last.date,
    slipDays: { p85: daysBetween(base.p85, last.p85), target: daysBetween(base.target_date, last.target_date) },
    scopeChange: {
      abs: scopeAbs,
      pct: scopeAbs === null || !base.scope ? null : Math.round((scopeAbs / base.scope) * 10_000) / 100,
    },
    budgetChange: diff(base.budget_usd, last.budget_usd),
    spendChange: diff(base.spend_usd, last.spend_usd),
    riskScoreChange: diff(base.open_risk_score, last.open_risk_score),
    milestoneMoves,
  };
}
