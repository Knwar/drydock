// Auto mode: once the requirements are final the project runs without the
// user's input. The app takes the gates the user would (the recommended team,
// then the design or the planning); the Architect finalises the design and the
// PM commits its own roadmap (design_done, start_building); agents decide open
// questions and log them as decisions. Work inside the project folder runs
// without asking. Still the user's: secrets, anything outside the project,
// deleting, deploying, publishing, sending, spending, and the final sign-off.
// It pauses when usage reaches 80% and resumes when that window resets.
import { isAbsolute, resolve } from 'node:path';
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { addMessage, getConversation } from './chat.js';
import { lastActivity, waitingOnUser } from './checkins.js';
import { listRequirements, projectRef, startAfterTeam } from './pipeline.js';
import { activeRuns, respond, stopRun } from './runner.js';
import { addProjectMembers, getRecommendation, isAuto } from './teamwork.js';
import { getUsage, notify } from './usage.js';
import { isInside } from './workspace.js';

export const USAGE_PAUSE_PCT = 80;
/** A quiet auto project gets a nudge after this long, at most NUDGE_CAP times without progress. */
const QUIET_MS = 20 * 60_000;
const NUDGE_CAP = 3;

interface Row {
  project_id: string;
  stage: string;
  status: string;
  auto_mode: number;
  auto_paused_until: number | null;
  auto_nudged_at: number | null;
  auto_nudges: number;
}
const row = (db: DB, id: string) => db.prepare('SELECT project_id, stage, status, auto_mode, auto_paused_until, auto_nudged_at, auto_nudges FROM brain_projects WHERE project_id = ?').get(id) as Row | undefined;
const emit = (id: string) => getBus().emit({ type: 'brain_project', project_id: id });

export function autoState(db: DB, projectId: string): { on: boolean; paused_until: number | null; waiting: boolean } {
  const r = row(db, projectId);
  return { on: Boolean(r?.auto_mode), paused_until: r?.auto_paused_until ?? null, waiting: Boolean(r?.auto_mode) && waitingOnUser(db, projectId) };
}

export function setAuto(db: DB, projectId: string, on: boolean): void {
  projectRef(db, projectId);
  db.prepare('UPDATE brain_projects SET auto_mode = ?, auto_paused_until = NULL, auto_nudged_at = NULL, auto_nudges = 0 WHERE project_id = ?').run(on ? 1 : 0, projectId);
  emit(projectId);
  if (on) kick(db, projectId, 'Auto mode is now on for this project: carry on without waiting for my approval, as your auto mode rules say.');
}

/** A paused auto project was resumed: start counting quiet spells afresh and get its lead going again. */
export function autoResume(db: DB, projectId: string): void {
  if (!isAuto(db, projectId)) return;
  db.prepare('UPDATE brain_projects SET auto_nudged_at = NULL, auto_nudges = 0 WHERE project_id = ?').run(projectId);
  kick(db, projectId, 'The project is resumed and auto mode is still on: carry on where you left off, without waiting for my approval.');
}

/** Get an auto project moving now rather than at the next quiet-project check: its stage's lead, or the next gate. */
function kick(db: DB, projectId: string, text: string): void {
  const r = row(db, projectId)!;
  if (r.status !== 'active' || r.auto_paused_until) return;
  if (r.stage === 'requirements') void autoStep(db, projectId);
  else if (!busy(db, projectId).length) nudge(db, projectId, r.stage, text);
}

/** The project's conversations with an agent working in them now. */
// a feature idea being shaped is not the project's work in progress
const busy = (db: DB, projectId: string) => activeRuns().filter((r) => { const c = getConversation(db, r.conversation); return c?.project_id === projectId && !c.idea_id; });

/**
 * Take the next gate the user would: after the final requirements and the
 * Main agent's team recommendation, add the whole recommended team and start
 * the design (or the planning). Later gates are the agents' (design_done,
 * start_building). Safe to call any time; it does nothing when it is not due.
 */
export async function autoStep(db: DB, projectId: string): Promise<void> {
  const r = row(db, projectId);
  if (!r?.auto_mode || r.status !== 'active' || r.auto_paused_until) return;
  if (r.stage !== 'requirements' || !listRequirements(db, projectId)[0]?.final) return;
  const rec = getRecommendation(db, projectId);
  if (!rec || rec.status === 'done' || activeRuns().some((a) => a.conversation === `sys:team:${projectId}`)) return;
  try {
    addProjectMembers(db, projectId, rec.items.filter((i) => !i.added).map((i) => i.key));
    await startAfterTeam(db, projectId);
  } catch (err) {
    say(db, projectId, `Auto mode could not start the next stage: ${(err as Error).message}`);
  }
}

/** Tell the user (Main agent's chat and a notification): auto mode needs them or stopped. */
function say(db: DB, projectId: string, text: string): void {
  const name = projectRef(db, projectId).name;
  const m = addMessage(db, 'dm:main', 'system', `**${name}** (auto mode): ${text}`);
  getBus().emit({ type: 'chat', conversation: 'dm:main', message: m });
  notify(`Drydock: ${name}`, text);
}

/** An approval is waiting on the user in an auto project: say so, since nobody is watching. */
export function autoWaiting(db: DB, conversationId: string | null, summary: string): void {
  const c = conversationId ? getConversation(db, conversationId) : undefined;
  const projectId = c && !c.idea_id ? c.project_id : null;
  if (projectId && isAuto(db, projectId)) say(db, projectId, `waiting for you: ${summary}`);
}

// ── permissions: work inside the project folder runs without asking ──

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Commands that reach outside the project or can't be undone: these still ask. */
const RISKY = /(^|[\s;&|(`$])(sudo|rm\s+-\w*[rf]|git\s+push|git\s+reset\s+--hard|git\s+clean|(npm|pnpm|yarn|bun)\s+publish|curl|wget|ssh|scp|rsync|ftp|nc|docker\s+(push|login)|kubectl|terraform|vercel|netlify|flyctl|fly\s|heroku|firebase|gh\s|aws\s|gcloud|az\s|open\s|osascript|launchctl|crontab|chmod\s+-R|chown|mkfs|dd\s|kill|pkill|killall|shutdown|reboot|mail|sendmail|security\s|defaults\s+write)(?=$|[\s;&|)])/;

/** Whether auto mode lets this tool call run without asking: file edits and commands confined to the project folder. */
export function autoAllows(db: DB, conversationId: string | null, tool: string, input: any): boolean {
  const c = conversationId ? getConversation(db, conversationId) : undefined;
  // auto mode covers approved work only, never a feature idea being shaped
  const projectId = c && !c.idea_id ? c.project_id : null;
  const r = projectId ? row(db, projectId) : undefined;
  if (!r?.auto_mode || r.status !== 'active') return false;
  const root = projectRef(db, projectId!).root;
  if (FILE_TOOLS.has(tool)) {
    const file = String(input?.file_path ?? input?.notebook_path ?? '');
    return Boolean(file) && isInside(root, isAbsolute(file) ? file : resolve(root, file));
  }
  if (tool !== 'Bash') return false;
  const cmd = String(input?.command ?? '');
  if (!cmd.trim() || RISKY.test(cmd)) return false;
  // every path it names stays in the project (/dev/null aside)
  for (const t of cmd.split(/[\s=;&|<>()'"`]+/)) {
    if (t.startsWith('~')) return false;
    if (t.includes('..') && !isInside(root, resolve(root, t))) return false;
    if (t.startsWith('/') && t !== '/dev/null' && !isInside(root, t)) return false;
  }
  return true;
}

// ── usage: pause at 80%, resume when the window resets ──

/** After each usage report: pause every running auto project once a window reaches the limit. */
export function autoUsageCheck(db: DB): void {
  const u = getUsage(db);
  const high = [u.five_hour, u.seven_day].filter((w) => w && w.pct >= USAGE_PAUSE_PCT) as { pct: number; resets_at: number | null }[];
  if (!high.length) return;
  const until = Math.max(...high.map((w) => w.resets_at ?? Date.now() + 3_600_000));
  const rows = db.prepare(`SELECT project_id FROM brain_projects WHERE auto_mode = 1 AND status = 'active' AND auto_paused_until IS NULL`).all() as { project_id: string }[];
  for (const { project_id } of rows) {
    db.prepare('UPDATE brain_projects SET auto_paused_until = ? WHERE project_id = ?').run(until, project_id);
    for (const run of busy(db, project_id)) stopRun(run.conversation);
    say(db, project_id, `paused: usage reached ${Math.max(...high.map((w) => w.pct))}%. It carries on by itself at ${new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`);
    emit(project_id);
  }
}

/** The thread and lead where an auto project's work goes on at its stage. */
function stageLead(db: DB, projectId: string, stage: string): { channel: string; lead: string } | null {
  const slug = projectRef(db, projectId).slug;
  const pick = stage === 'design' ? { channel: `ch:${slug}-design`, lead: '@Architect' } : stage === 'plan' || stage === 'build' ? { channel: `ch:${slug}-build`, lead: '@PM' } : null;
  return pick && getConversation(db, pick.channel) ? pick : null;
}

function nudge(db: DB, projectId: string, stage: string, text: string): boolean {
  const at = stageLead(db, projectId, stage);
  if (!at) return false;
  const m = addMessage(db, at.channel, 'user', `${at.lead} ${text}`, 'text', { checkin: 'auto' });
  getBus().emit({ type: 'chat', conversation: at.channel, message: m });
  respond(at.channel, at.lead);
  return true;
}

/**
 * Every few minutes: resume projects whose usage pause is over, take due
 * gates, and nudge a quiet auto project's lead (at most NUDGE_CAP times
 * without progress, then tell the user it is stuck).
 */
export function runAuto(db: DB, at = Date.now()): void {
  const rows = db.prepare(`SELECT project_id, stage, status, auto_mode, auto_paused_until, auto_nudged_at, auto_nudges FROM brain_projects WHERE auto_mode = 1 AND status = 'active'`).all() as Row[];
  for (const r of rows) {
    try {
      if (r.auto_paused_until) {
        if (at < r.auto_paused_until) continue;
        db.prepare('UPDATE brain_projects SET auto_paused_until = NULL WHERE project_id = ?').run(r.project_id);
        emit(r.project_id);
        if (!nudge(db, r.project_id, r.stage, 'Auto mode resumes: usage is back under the limit. Carry on where you left off.')) void autoStep(db, r.project_id);
        continue;
      }
      if (r.stage === 'requirements') {
        void autoStep(db, r.project_id);
        continue;
      }
      if (busy(db, r.project_id).length || waitingOnUser(db, r.project_id)) continue;
      const last = lastActivity(db, r.project_id);
      if (at - last < QUIET_MS) continue;
      // board progress since the last nudge resets the count (a reply alone does not)
      const progressed = r.auto_nudged_at !== null && boardActivity(db, r.project_id) > r.auto_nudged_at;
      const count = progressed ? 0 : r.auto_nudges;
      if (count >= NUDGE_CAP) continue;
      if (count === NUDGE_CAP - 1) say(db, r.project_id, 'it has gone quiet several times without progress. Have a look at its threads: it may need a decision from you.');
      if (nudge(db, r.project_id, r.stage, 'Auto mode: this project has been quiet for a while. Carry on with the next step yourself; decide open questions, log them with log_decision, and keep going. If something only the user can do blocks you, say so in one line and continue with other work.'))
        db.prepare('UPDATE brain_projects SET auto_nudged_at = ?, auto_nudges = ? WHERE project_id = ?').run(at, count + 1, r.project_id);
    } catch (err) {
      console.error(`auto mode ${r.project_id}: ${(err as Error).message}`);
    }
  }
}

/** Latest card or board event on the project and its verticals. */
function boardActivity(db: DB, projectId: string): number {
  const ids = [projectId, ...(db.prepare('SELECT id FROM projects WHERE parent_id = ?').all(projectId) as { id: string }[]).map((r) => r.id)];
  const q = ids.map(() => '?').join(',');
  const events = (db.prepare(`SELECT MAX(created_at) AS t FROM task_events WHERE project_id IN (${q})`).get(...ids) as { t: number | null }).t ?? 0;
  const cards = (db.prepare(`SELECT MAX(updated_at) AS t FROM tasks WHERE project_id IN (${q})`).get(...ids) as { t: number | null }).t ?? 0;
  return Math.max(events, cards);
}

/** A stage moved on: quiet-project nudges start counting again. */
export const autoProgress = (db: DB, projectId: string) => db.prepare('UPDATE brain_projects SET auto_nudged_at = NULL, auto_nudges = 0 WHERE project_id = ?').run(projectId);

/** Runs the auto-mode pass every five minutes (with the other schedulers). */
export function startAuto(): NodeJS.Timeout {
  return setInterval(() => runAuto(getBus().db()), 5 * 60_000);
}
