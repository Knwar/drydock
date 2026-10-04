/**
 * Schedule status: is a phase going to hit its target date?
 *
 * `scheduleStatus` is pure: it compares the phase's target day with the
 * Monte Carlo forecast (forecast.ts) of its remaining cards.
 *
 * `schedule` answers for every phase of a project (a workspace includes its
 * verticals'). A phase's answer never depends on who asks — the same phase
 * gets the same status from its vertical's board and from the workspace:
 *  - History: the phase's OWN board (a vertical alone; a workspace or a
 *    standalone project with its verticals, if any). A vertical with too little
 *    history falls back to its workspace's, and the reason says so.
 *  - Sequencing: phases on a board run one after another, so a phase finishes
 *    only after the unfinished work of the not-done phases before it (lower
 *    position) on the same board. Its forecast simulates that cumulative
 *    remaining count (earlier phases' remaining + its own).
 *  - Cost: only phases with a target, not done and with open cards are
 *    forecast ("targeted"). They are ranked across the whole workspace
 *    (workspace board first, then verticals by name, then position); the first
 *    MAX_FORECAST_PHASES get a forecast, the rest are 'unknown' ("too many
 *    phases"). SCHEDULE_RUNS simulated runs are split evenly over the
 *    workspace's forecast phases (at least MIN_SCHEDULE_RUNS each), so one
 *    request costs about SCHEDULE_RUNS runs (at most twice that when every
 *    vertical falls back to the workspace history). The split is workspace-wide,
 *    not per request, so the runs (and the answer) don't depend on the viewer.
 */
import type { DB } from './db.js';
import type { PhaseStatus } from './types.js';
import { dayKey, deriveCards, loadCardHistories } from './metrics.js';
import { computeForecast } from './forecast.js';
import { listMilestones, type Milestone } from './milestones.js';
import { workspaceOf, type Listed } from './decisions.js';

export type ScheduleStatus = 'on_track' | 'at_risk' | 'late' | 'complete' | 'done' | 'unknown';

export interface ScheduleInput {
  target_date: string | null; // YYYY-MM-DD
  phase_status: PhaseStatus;
  total: number; // cards in the phase
  remaining: number; // not-done cards in the phase
  /** The forecast's p50/p85 days (+ a note on its history), or null (no forecast). */
  forecast: { p50: string; p85: string; note?: string } | null;
  /** Why there is no forecast (default: not enough history). */
  no_forecast_reason?: string;
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
 * In order: done (the phase is done); unknown (no cards yet); complete (every
 * card done, phase not advanced); unknown (no target); late (target before today
 * with work remaining); unknown (no forecast); on_track (p85 <= target);
 * at_risk (p50 <= target < p85); late (p50 > target).
 */
export function scheduleStatus(input: ScheduleInput): ScheduleResult {
  const { target_date: target, forecast: f, today } = input;
  const base = { target_date: target, p50: f?.p50 ?? null, p85: f?.p85 ?? null };
  const out = (status: ScheduleStatus, reason: string): ScheduleResult => ({ status, reason, ...base });
  const note = f?.note ? `; ${f.note}` : '';
  if (input.phase_status === 'done') return out('done', 'the phase is done');
  if (input.total === 0) return out('unknown', 'No cards yet');
  if (input.remaining === 0) return out('complete', 'All cards done: advance the phase to close it');
  if (target === null) return out('unknown', 'no target date');
  if (target < today)
    return out('late', `target ${target} has passed with ${input.remaining} card${input.remaining === 1 ? '' : 's'} left${note}`);
  if (!f) return out('unknown', input.no_forecast_reason ?? 'not enough history to forecast');
  if (f.p85 <= target) return out('on_track', `85% likely by ${f.p85}, target ${target}${note}`);
  if (f.p50 <= target) return out('at_risk', `50% likely by ${f.p50} but 85% only by ${f.p85}, target ${target}${note}`);
  return out('late', `50% likely only by ${f.p50}, after target ${target}${note}`);
}

export interface SchedulePhase extends ScheduleResult {
  id: string;
  project_id: string;
  title: string;
  phase_status: PhaseStatus;
  position: number;
  total: number;
  remaining: number;
  /** Cards the forecast simulated: this phase's remaining + earlier unfinished phases' on its board. 0 when not forecast. */
  queued: number;
  /** Whose throughput the forecast used: the phase's board, its workspace (fallback), or null (no forecast). */
  history: 'board' | 'workspace' | null;
  /** 95% forecast finish day (YYYY-MM-DD); null/absent = no forecast. */
  p95?: string | null;
  /** The day (YYYY-MM-DD, in the tz) a done phase was last marked done (its latest phase_done event); null otherwise. */
  done_date: string | null;
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

export const SCHEDULE_RUNS = 20_000;
export const MIN_SCHEDULE_RUNS = 500;
export const MAX_FORECAST_PHASES = 40;
/** A stable default seed: the pills don't flicker between refreshes. */
export const DEFAULT_SCHEDULE_SEED = 1;

interface PhaseRow {
  id: string;
  project_id: string;
  board_name: string;
  title: string;
  status: PhaseStatus;
  position: number;
  target_date: string | null;
}

/** Every phase of `projectId` (+ its verticals when a workspace) with its schedule status, and the milestones in scope. */
export function schedule(db: DB, projectId: string, opts: { tz: string; now: number; seed?: number }): ScheduleView {
  const today = dayKey(opts.now, opts.tz);
  const ws = workspaceOf(db, projectId);
  // the whole workspace's phases, in a viewer-independent order (workspace board first, verticals by name, position)
  const all = db
    .prepare(
      `SELECT p.id, p.project_id, pr.name AS board_name, p.title, p.status, p.position, p.target_date
         FROM phases p JOIN projects pr ON pr.id = p.project_id
        WHERE p.project_id = ? OR pr.parent_id = ?
        ORDER BY p.project_id = ? DESC, pr.name, pr.id, p.position, p.rowid`,
    )
    .all(ws, ws, ws) as PhaseRow[];
  const counts = new Map(
    (
      db
        .prepare(
          `SELECT t.phase_id AS id, COUNT(*) AS total, SUM(t.lane != 'done') AS remaining
             FROM tasks t JOIN projects pr ON pr.id = t.project_id
            WHERE t.phase_id IS NOT NULL AND (t.project_id = ? OR pr.parent_id = ?)
            GROUP BY t.phase_id`,
        )
        .all(ws, ws) as { id: string; total: number; remaining: number }[]
    ).map((r) => [r.id, r]),
  );
  // a done phase's done day: its latest phase_done event (a reopened + re-closed phase counts its last close)
  const doneAt = new Map(
    (
      db
        .prepare(
          `SELECT json_extract(e.payload, '$.phase_id') AS phase_id, MAX(e.created_at) AS at
             FROM task_events e JOIN projects pr ON pr.id = e.project_id
            WHERE e.type = 'phase_done' AND (e.project_id = ? OR pr.parent_id = ?)
            GROUP BY phase_id`,
        )
        .all(ws, ws) as { phase_id: string | null; at: number }[]
    ).map((r) => [r.phase_id, r.at]),
  );
  const total = (id: string) => counts.get(id)?.total ?? 0;
  const left = (id: string) => counts.get(id)?.remaining ?? 0;

  // cumulative remaining: earlier (lower position) not-done phases on the same board go first
  const queued = new Map<string, number>();
  const ahead = new Map<string, number>(); // board → remaining so far
  for (const p of [...all].sort((a, b) => a.position - b.position)) {
    if (p.status === 'done') continue;
    const q = (ahead.get(p.project_id) ?? 0) + left(p.id);
    ahead.set(p.project_id, q);
    queued.set(p.id, q);
  }

  const targeted = all.filter((p) => p.target_date !== null && p.status !== 'done' && left(p.id) > 0);
  const forecastable = new Set(targeted.slice(0, MAX_FORECAST_PHASES).map((p) => p.id));
  const overCap = new Set(targeted.slice(MAX_FORECAST_PHASES).map((p) => p.id));
  const runs = Math.max(MIN_SCHEDULE_RUNS, Math.floor(SCHEDULE_RUNS / Math.max(1, forecastable.size)));
  const seed = opts.seed ?? DEFAULT_SCHEDULE_SEED;

  // history per scope, loaded lazily: a board id (loadCardHistories adds a workspace's verticals)
  const histories = new Map<string, { doneAts: number[]; firstAt: number | null }>();
  const history = (scope: string) => {
    let h = histories.get(scope);
    if (!h) {
      const cards = deriveCards(loadCardHistories(db, { projectIds: [scope] }), opts.now).map((d) => d.m);
      h = {
        doneAts: cards.flatMap((c) => (c.doneAt === null ? [] : [c.doneAt])),
        firstAt: cards.reduce<number | null>((m, c) => (m === null || c.createdAt < m ? c.createdAt : m), null),
      };
      histories.set(scope, h);
    }
    return h;
  };
  const run = (scope: string, n: number) => {
    const h = history(scope);
    return computeForecast(h.doneAts, h.firstAt, n, { tz: opts.tz, now: opts.now, runs, seed });
  };

  const inView = ws === projectId ? all : all.filter((p) => p.project_id === projectId);
  const milestones = listMilestones(db, projectId);
  return {
    project_id: projectId,
    today,
    tz: opts.tz,
    phases: inView.map((p) => {
      let forecast: ScheduleInput['forecast'] = null;
      let used: SchedulePhase['history'] = null;
      let p95: string | null = null; // read off the same simulation as p50/p85
      const n = forecastable.has(p.id) ? queued.get(p.id)! : 0;
      if (n > 0) {
        let f = run(p.project_id, n);
        used = 'board';
        if (f.status !== 'ok' && p.project_id !== ws) {
          f = run(ws, n);
          used = 'workspace';
          if (f.status === 'ok')
            forecast = { p50: f.p50.date, p85: f.p85.date, note: `forecast uses workspace history; ${p.board_name} has too little` };
        } else if (f.status === 'ok') forecast = { p50: f.p50.date, p85: f.p85.date };
        if (forecast && f.status === 'ok') p95 = f.p95.date;
        if (!forecast) used = null;
      }
      const result = scheduleStatus({
        target_date: p.target_date,
        phase_status: p.status,
        total: total(p.id),
        remaining: left(p.id),
        forecast,
        no_forecast_reason: overCap.has(p.id) ? 'too many phases' : undefined,
        today,
      });
      return {
        id: p.id,
        project_id: p.project_id,
        title: p.title,
        phase_status: p.status,
        position: p.position,
        total: total(p.id),
        remaining: left(p.id),
        queued: n,
        history: used,
        ...result,
        p95,
        done_date: p.status === 'done' && doneAt.has(p.id) ? dayKey(doneAt.get(p.id)!, opts.tz) : null,
        milestones: milestones.filter((m) => m.phase_id === p.id),
      };
    }),
    milestones,
  };
}
