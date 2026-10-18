// Stale-project check-ins (stale-bot pattern, in hours because agents work
// around the clock): no activity for `pm` hours → the Main agent asks the PM
// for status; `members` hours → everyone with open cards; `user` hours → the
// user decides to pause or close. Any activity resets the clock. Projects that
// are paused, closed, in close-out, or waiting on the user are left alone.
import type { DB } from '../core/db.js';
import { getBus } from './bus.js';
import { addMessage, getConversation } from './chat.js';
import { projectRef } from './pipeline.js';
import { respond } from './runner.js';
import { getSetting } from './settings.js';
import { notify } from './usage.js';

export interface CheckinSettings {
  pm: number; // hours
  members: number;
  user: number;
}
export const checkinSettings = (db: DB): CheckinSettings => ({ pm: 2, members: 6, user: 24, ...getSetting<Partial<CheckinSettings>>(db, 'brain.checkins', {}) });

const HOUR = 3_600_000;

/** Latest real activity on a project: board events, card updates, and messages in its threads (check-ins excluded). */
export function lastActivity(db: DB, projectId: string): number {
  const ids = [projectId, ...(db.prepare('SELECT id FROM projects WHERE parent_id = ?').all(projectId) as { id: string }[]).map((r) => r.id)];
  const q = ids.map(() => '?').join(',');
  const events = (db.prepare(`SELECT MAX(created_at) AS t FROM task_events WHERE project_id IN (${q})`).get(...ids) as { t: number | null }).t ?? 0;
  const cards = (db.prepare(`SELECT MAX(updated_at) AS t FROM tasks WHERE project_id IN (${q})`).get(...ids) as { t: number | null }).t ?? 0;
  const msgs =
    (
      db
        .prepare(
          `SELECT MAX(m.created_at) AS t FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.project_id = ? AND (m.meta IS NULL OR json_extract(m.meta, '$.checkin') IS NULL)`,
        )
        .get(projectId) as { t: number | null }
    ).t ?? 0;
  const created = (db.prepare('SELECT updated_at AS t FROM brain_projects WHERE project_id = ?').get(projectId) as { t: number } | undefined)?.t ?? 0;
  return Math.max(events, cards, msgs, created);
}

/** Waiting on the user: an approval or team proposal pending in one of the project's threads. */
export function waitingOnUser(db: DB, projectId: string): boolean {
  const approvals = db.prepare(`SELECT 1 FROM approvals a JOIN conversations c ON c.id = a.conversation_id WHERE c.project_id = ? AND a.status = 'pending' LIMIT 1`).get(projectId);
  const proposals = db.prepare(`SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.project_id = ? AND m.kind IN ('proposal', 'secret_request') AND json_extract(m.meta, '$.status') = 'pending' LIMIT 1`).get(projectId);
  return Boolean(approvals || proposals);
}

const post = (db: DB, conversation: string, author: string, text: string, tier: number) => {
  const m = addMessage(db, conversation, author, text, 'text', { checkin: tier });
  getBus().emit({ type: 'chat', conversation, message: m });
  return m;
};

/** One pass over all projects; returns what it did (for tests and logs). */
export function runCheckins(db: DB, at = Date.now()): { project: string; tier: number }[] {
  const s = checkinSettings(db);
  const done: { project: string; tier: number }[] = [];
  const rows = db.prepare(`SELECT project_id, checkin_tier, checkin_at FROM brain_projects WHERE stage = 'build' AND status = 'active'`).all() as { project_id: string; checkin_tier: number; checkin_at: number | null }[];
  for (const r of rows) {
    if (waitingOnUser(db, r.project_id)) continue;
    let tier = r.checkin_tier;
    const last = lastActivity(db, r.project_id);
    if (r.checkin_at && last > r.checkin_at) tier = 0; // something happened since the last check-in
    const idle = (at - last) / HOUR;
    const next = idle >= s.user ? 3 : idle >= s.members ? 2 : idle >= s.pm ? 1 : 0;
    if (next <= tier) {
      if (tier !== r.checkin_tier) db.prepare('UPDATE brain_projects SET checkin_tier = ? WHERE project_id = ?').run(tier, r.project_id);
      continue;
    }
    let ref;
    try {
      ref = projectRef(db, r.project_id);
    } catch {
      continue;
    }
    const build = `ch:${ref.slug}-build`;
    const hours = Math.floor(idle);
    if (next === 3) {
      post(db, 'dm:main', 'main', `**${ref.name}** has had no activity for ${hours} hours, and the team did not get it moving. Do you want to **pause** it, **close** it, or have me dig in? (Pause and close are on the project page.)`, 3);
      notify('AI Brain', `${ref.name}: no activity for ${hours} hours. Pause or close?`);
    } else if (getConversation(db, build)) {
      if (next === 2) {
        const ids = [r.project_id, ...(db.prepare('SELECT id FROM projects WHERE parent_id = ?').all(r.project_id) as { id: string }[]).map((x) => x.id)];
        const owners = (db.prepare(`SELECT DISTINCT assigned_agent AS a FROM tasks WHERE project_id IN (${ids.map(() => '?').join(',')}) AND lane IN ('in_progress', 'in_review', 'queued') AND assigned_agent IS NOT NULL`).all(...ids) as { a: string }[]).map((x) => x.a);
        const text = `@PM ${owners.length ? `and the owners of open cards (${owners.join(', ')}) ` : ''}there has been no activity on ${ref.name} for ${hours} hours. For each open card: status (green/amber/red), the blocker if any, and the next step. If something is stuck, say what you need from the user.`;
        post(db, build, 'main', text, 2);
        respond(build, text);
      } else {
        const text = `@PM status check on ${ref.name}: nothing has moved for ${hours} hours. Reply with the overall status (green/amber/red), the main blocker if any, and the next step, and call report_status. If the work is actually finished, call report_work_complete.`;
        post(db, build, 'main', text, 1);
        respond(build, text);
      }
    }
    db.prepare('UPDATE brain_projects SET checkin_tier = ?, checkin_at = ? WHERE project_id = ?').run(next, at, r.project_id);
    done.push({ project: r.project_id, tier: next });
  }
  return done;
}

export function startCheckins(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      runCheckins(getBus().db());
    } catch (err) {
      console.error(`check-ins: ${(err as Error).message}`);
    }
  }, 5 * 60_000);
}
