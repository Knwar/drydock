// A project's Overview: what needs the user (blocked cards, with the command
// to run when there is one), what is being worked on right now, its verticals
// (the separately deployable parts) and this week's usage. "Done, carry on"
// clears a blocker the user resolved and tells the project's lead to resume.
import * as board from '../core/board.js';
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { addMessage, getConversation } from './chat.js';
import { leadThread } from './feature-ideas.js';
import { HttpError, on } from './router.js';
import { activeRuns, respond } from './runner.js';
import { listRoles } from './roles.js';
import { getUsage } from './usage.js';

const DAY = 86_400_000;

/** The project and its verticals (separately deployable parts, each with its own board). */
function family(db: DB, projectId: string): { id: string; name: string; parent: boolean }[] {
  const p = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
  if (!p) throw new HttpError(404, 'unknown project');
  const kids = db.prepare('SELECT id, name FROM projects WHERE parent_id = ? ORDER BY name').all(projectId) as { id: string; name: string }[];
  return [{ ...p, parent: true }, ...kids.map((k) => ({ ...k, parent: false }))];
}

/** A command the user can run, when the blocker names one ("…(brew install ffmpeg)", "`uv sync`"). */
export function commandIn(reason: string | null): string | null {
  if (!reason) return null;
  const tick = /`([^`\n]{2,120})`/.exec(reason);
  if (tick) return tick[1].trim();
  const brew = /\b((?:brew|npm|pnpm|pip|pipx|uv|cargo|gem|xcode-select)\s+[^\s()][^()\n]*?)(?=[).;\n]|$)/.exec(reason);
  return brew ? brew[1].trim() : null;
}

on('GET', '/api/projects/:id/overview', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const fam = family(db, p.id);
  const ids = fam.map((f) => f.id);
  const marks = ids.map(() => '?').join(',');
  const nameOf = (id: string) => (fam.find((f) => f.id === id && !f.parent)?.name ?? 'Shared');

  const needs = (db.prepare(`SELECT id, project_id, title, blocked_reason, blocked_at FROM tasks WHERE project_id IN (${marks}) AND blocked_at IS NOT NULL AND lane != 'done' ORDER BY blocked_at`).all(...ids) as any[]).map((t) => ({
    card: t.id,
    project_id: t.project_id,
    title: t.title,
    reason: t.blocked_reason ?? '',
    command: commandIn(t.blocked_reason),
    vertical: nameOf(t.project_id),
    since: t.blocked_at,
  }));

  // cards in hand, and agents running in the project's chats (a PM planning, an Architect designing)
  const cards = (db.prepare(`SELECT id, project_id, title, lane, assigned_agent, updated_at FROM tasks WHERE project_id IN (${marks}) AND lane IN ('in_progress', 'in_review') AND blocked_at IS NULL ORDER BY updated_at DESC`).all(...ids) as any[]).map((t) => ({
    card: t.id,
    title: t.title,
    step: t.lane === 'in_review' ? 'In review' : 'Building',
    agent: t.assigned_agent ?? (t.lane === 'in_review' ? 'Reviewer' : 'Builder'),
    vertical: nameOf(t.project_id),
    since: t.updated_at,
  }));
  const roles = listRoles(db);
  const chats = activeRuns()
    .map((r) => ({ r, c: getConversation(db, r.conversation) }))
    .filter((x) => x.c && ids.includes(x.c.project_id ?? '') && !x.c.idea_id)
    .map((x) => ({ conversation: x.c!.id, agent: roles.find((ro) => ro.id === x.r.role)?.name ?? x.r.role, where: `#${x.c!.name}` }));

  // each vertical: its progress, its stack (from the design container of the same name) and who works on it
  const verticals = fam
    .filter((f) => !f.parent)
    .map((v) => {
      const c = db.prepare(`SELECT COUNT(*) AS total, SUM(lane = 'done') AS done, SUM(blocked_at IS NOT NULL AND lane != 'done') AS blocked FROM tasks WHERE project_id = ?`).get(v.id) as { total: number; done: number | null; blocked: number | null };
      const el = db.prepare(`SELECT technology, description FROM design_elements WHERE project_id = ? AND kind = 'container' AND (lower(name) = lower(?) OR lower(?) LIKE lower(name) || '%')`).get(p.id, v.name, v.name) as { technology: string | null; description: string | null } | undefined;
      const who = (db.prepare(`SELECT assigned_agent AS a, COUNT(*) AS n FROM tasks WHERE project_id = ? AND assigned_agent IS NOT NULL GROUP BY assigned_agent ORDER BY n DESC LIMIT 2`).all(v.id) as { a: string }[]).map((x) => x.a);
      return { id: v.id, name: v.name, done: c.done ?? 0, total: c.total, blocked: c.blocked ?? 0, technology: el?.technology ?? null, description: el?.description ?? null, who };
    });

  // this week's usage: what the project's agents cost per day (API-equivalent), and builder time
  const since = Date.now() - 7 * DAY;
  const days = db
    .prepare(
      `SELECT date(u.created_at / 1000, 'unixepoch', 'localtime') AS day, SUM(u.cost_usd) AS cost FROM agent_usage u JOIN conversations c ON c.id = u.conversation_id
       WHERE c.project_id IN (${marks}) AND u.created_at > ? GROUP BY day`,
    )
    .all(...ids, since) as { day: string; cost: number | null }[];
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * DAY).toLocaleDateString('en-CA');
    return { day: d, cost: Math.round((days.find((x) => x.day === d)?.cost ?? 0) * 100) / 100 };
  });
  const builds = db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(ms), 0) AS ms FROM card_activity WHERE project_id IN (${marks}) AND role = 'builder' AND created_at > ?`).get(...ids, since) as { runs: number; ms: number };
  const usage = { week, total: Math.round(week.reduce((n, d) => n + d.cost, 0) * 100) / 100, builderRuns: builds.runs, builderMs: builds.ms, planPct: getUsage(db).seven_day?.pct ?? null };

  ctx.json(res, 200, { needs, working: cards, chats, verticals, usage });
});

/** The user did what a card was waiting on: the blocker clears and the project's lead carries on with it. */
on('POST', '/api/projects/:id/cards/:card/unblock', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const ids = family(db, p.id).map((f) => f.id);
  const task = db.prepare('SELECT id, project_id, title, blocked_reason FROM tasks WHERE id = ?').get(p.card) as { id: string; project_id: string; title: string; blocked_reason: string | null } | undefined;
  if (!task || !ids.includes(task.project_id)) throw new HttpError(404, 'unknown card');
  if (!task.blocked_reason) throw new HttpError(400, 'this card is not waiting on anything');
  board.resolveBlocker(db, task.id, `Done by the user: ${task.blocked_reason}`);
  getBus().emit({ type: 'card', project_id: task.project_id });
  const at = leadThread(db, p.id);
  if (at) {
    const m = addMessage(db, at.channel, 'user', `${at.lead} I've done what "${task.title}" (${task.id}) was waiting on: ${task.blocked_reason} Carry on with it.`);
    getBus().emit({ type: 'chat', conversation: at.channel, message: m });
    respond(at.channel, at.lead);
  }
  ctx.json(res, 200, { ok: true, thread: at?.channel ?? null });
});
