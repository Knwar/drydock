/**
 * Schedule status: is a phase going to hit its target date?
 *
 * `scheduleStatus` is pure: it compares the phase's target day with the
 * Monte Carlo forecast (forecast.ts) of its remaining cards. `schedule` loads a
 * project (incl. its verticals) once and runs a forecast only for phases that
 * have a target and are not done, with the runs split across them so the whole
 * request costs about one forecast.
 */
import type { DB } from './db.js';
import type { PhaseStatus } from './types.js';
import { dayKey, deriveCards, loadCardHistories } from './metrics.js';
import { computeForecast, DEFAULT_RUNS } from './forecast.js';
import { listMilestones, type Milestone } from './milestones.js';
import type { Listed } from './decisions.js';

export type ScheduleStatus = 'on_track' | 'at_risk' | 'late' | 'done' | 'unknown';

export interface ScheduleInput {
  target_date: string | null; // YYYY-MM-DD
  phase_status: PhaseStatus;
  remaining: number; // not-done cards in the phase
  /** The forecast's p50/p85 days, or null (no forecast / insufficient history). */
  forecast: { p50: string; p85: string } | null;
  today: string; // YYYY-MM-DD in the tz
}

export interface ScheduleResult {
  status: ScheduleStatus;
  reason: string;
  target_date: string | null;
  p50: string | null;
  p85: string | null;
}

/**
 * done: the phase is done. unknown: no target. late: the target is before today
 * with work remaining, or p50 > target. unknown: no forecast. on_track: p85 <=
 * target. at_risk: p50 <= target < p85.
 */
export function scheduleStatus(input: ScheduleInput): ScheduleResult {
  const { target_date: target, forecast: f, today } = input;
  const base = { target_date: target, p50: f?.p50 ?? null, p85: f?.p85 ?? null };
  const out = (status: ScheduleStatus, reason: string): ScheduleResult => ({ status, reason, ...base });
  if (input.phase_status === 'done') return out('done', 'the phase is done');
  if (target === null) return out('unknown', 'no target date');
  if (target < today && input.remaining > 0)
    return out('late', `target ${target} has passed with ${input.remaining} card${input.remaining === 1 ? '' : 's'} left`);
  if (!f) return out('unknown', 'not enough history to forecast');
  if (f.p85 <= target) return out('on_track', `85% likely by ${f.p85}, target ${target}`);
  if (f.p50 <= target) return out('at_risk', `50% likely by ${f.p50} but 85% only by ${f.p85}, target ${target}`);
  return out('late', `50% likely only by ${f.p50}, after target ${target}`);
}

export interface SchedulePhase extends ScheduleResult {
  id: string;
  project_id: string;
  title: string;
  phase_status: PhaseStatus;
  position: number;
  remaining: number;
  milestones: Listed<Milestone>[];
}

export interface ScheduleView {
  project_id: string;
  today: string;
  tz: string;
  phases: SchedulePhase[];
  /** Every milestone in scope (the ones with a phase also appear under it). */
  milestones: Listed<Milestone>[];
}

/** Total simulated runs shared by the forecasts of one request (each gets at least forecast.ts's minimum). */
const SCHEDULE_RUNS = DEFAULT_RUNS * 2;
const MIN_SCHEDULE_RUNS = 1_000;
/** A stable default seed: the pills don't flicker between refreshes. */
export const DEFAULT_SCHEDULE_SEED = 1;

/** Every phase of `projectId` and its verticals with its schedule status, and the milestones in scope. */
export function schedule(db: DB, projectId: string, opts: { tz: string; now: number; seed?: number }): ScheduleView {
  const today = dayKey(opts.now, opts.tz);
  const phases = db
    .prepare(
      `SELECT p.id, p.project_id, p.title, p.status, p.position, p.target_date
         FROM phases p JOIN projects pr ON pr.id = p.project_id
        WHERE p.project_id = ? OR pr.parent_id = ?
        ORDER BY p.project_id = ? DESC, pr.name, p.position`,
    )
    .all(projectId, projectId, projectId) as {
    id: string;
    project_id: string;
    title: string;
    status: PhaseStatus;
    position: number;
    target_date: string | null;
  }[];
  const milestones = listMilestones(db, projectId);
  const needForecast = new Set(phases.filter((p) => p.target_date !== null && p.status !== 'done').map((p) => p.id));

  // one load for the whole scope: history (same as /metrics/forecast?project=) + per-phase remaining counts
  const remaining = new Map<string, number>();
  const doneAts: number[] = [];
  let firstAt: number | null = null;
  const counts = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE phase_id = ? AND lane != 'done'`);
  if (needForecast.size) {
    const cards = deriveCards(loadCardHistories(db, { projectIds: [projectId] }), opts.now).map((d) => d.m);
    for (const c of cards) {
      if (c.lane !== 'done' && c.phase_id) remaining.set(c.phase_id, (remaining.get(c.phase_id) ?? 0) + 1);
      if (c.doneAt !== null) doneAts.push(c.doneAt);
      if (firstAt === null || c.createdAt < firstAt) firstAt = c.createdAt;
    }
  }
  const runs = Math.max(MIN_SCHEDULE_RUNS, Math.floor(SCHEDULE_RUNS / Math.max(1, needForecast.size)));
  const seed = opts.seed ?? DEFAULT_SCHEDULE_SEED;

  return {
    project_id: projectId,
    today,
    tz: opts.tz,
    phases: phases.map((p) => {
      const forecasted = needForecast.has(p.id);
      const left = forecasted ? (remaining.get(p.id) ?? 0) : (counts.get(p.id) as { n: number }).n;
      let forecast: ScheduleInput['forecast'] = null;
      if (forecasted) {
        const f = computeForecast(doneAts, firstAt, left, { tz: opts.tz, now: opts.now, runs, seed });
        if (f.status === 'ok') forecast = { p50: f.p50.date, p85: f.p85.date };
      }
      const result = scheduleStatus({ target_date: p.target_date, phase_status: p.status, remaining: left, forecast, today });
      return {
        id: p.id,
        project_id: p.project_id,
        title: p.title,
        phase_status: p.status,
        position: p.position,
        remaining: left,
        ...result,
        milestones: milestones.filter((m) => m.phase_id === p.id),
      };
    }),
    milestones,
  };
}
