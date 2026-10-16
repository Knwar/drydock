// /api routes for the personal page, the Daily, integrations and usage.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDecisions } from './chat.js';
import { DAILY_CONVERSATION, dailySettings, generateDaily, getEdition, isGenerating, listEditions, publishEdition, saveDailySettings } from './daily.js';
import { listServers, serverAllowed, setServerAccess, setToolPolicy, toolPolicies, toolsSeen } from './integrations.js';
import {
  addNote,
  addReminder,
  deleteReminder,
  getSpending,
  listBills,
  listEvents,
  listInbox,
  listNotes,
  listReminders,
  replaceEvents,
  setBillStatus,
  setInboxStatus,
  setReminderDone,
  setSpending,
  upsertBills,
  upsertInbox,
} from './personal.js';
import { listRoles } from './roles.js';
import { HttpError, on } from './router.js';
import { putSetting } from './settings.js';
import { getUsage, usageAlert } from './usage.js';
import { currentWorkspace } from './workspace.js';

const day = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const weekBounds = () => {
  const d = new Date();
  const mondayOffset = (d.getDay() + 6) % 7;
  return [day(-mondayOffset), day(6 - mondayOffset)];
};

on('GET', '/api/personal', (_q, res, _u, ctx) => {
  const db = ctx.db();
  const [from, to] = weekBounds();
  const month = day().slice(0, 7);
  ctx.json(res, 200, {
    today: day(),
    week: { from, to, events: listEvents(db, from, to) },
    reminders: listReminders(db),
    inbox: listInbox(db),
    bills: listBills(db),
    spending: { month, rows: getSpending(db, month) },
    notes: currentWorkspace() ? listNotes(12) : [],
    edition: getEdition(db),
    generating: isGenerating(),
  });
});

on('POST', '/api/reminders', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.text?.trim()) throw new HttpError(400, 'text required');
  const r = addReminder(ctx.db(), b.text, b.due ?? null, 'user');
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, r);
});
on('POST', '/api/reminders/:id', async (req, res, _u, ctx, p) => {
  const b = await ctx.readBody(req);
  setReminderDone(ctx.db(), Number(p.id), Boolean(b?.done));
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, { ok: true });
});
on('DELETE', '/api/reminders/:id', (_q, res, _u, ctx, p) => {
  deleteReminder(ctx.db(), Number(p.id));
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, { ok: true });
});

on('POST', '/api/notes', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.text?.trim()) throw new HttpError(400, 'text required');
  const n = addNote(b.text, b.title);
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, n);
});

on('POST', '/api/inbox/:id', async (req, res, _u, ctx, p) => {
  const b = await ctx.readBody(req);
  setInboxStatus(ctx.db(), p.id, b?.status === 'open' ? 'open' : b?.status === 'done' ? 'done' : 'dismissed');
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, { ok: true });
});

on('POST', '/api/bills/:id', async (req, res, _u, ctx, p) => {
  const b = await ctx.readBody(req);
  setBillStatus(ctx.db(), p.id, b?.status === 'paid' ? 'paid' : 'due');
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, { ok: true });
});

// ── written by the main agent (brain MCP tools) ──

on('POST', '/api/personal/inbox', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  upsertInbox(ctx.db(), Array.isArray(b?.items) ? b.items : []);
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, { ok: true });
});
on('POST', '/api/personal/calendar', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b?.from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(b?.to ?? '')) throw new HttpError(400, 'from and to as YYYY-MM-DD');
  replaceEvents(ctx.db(), b.from, b.to, Array.isArray(b?.events) ? b.events : []);
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, { ok: true });
});
on('POST', '/api/personal/money', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (Array.isArray(b?.bills)) upsertBills(ctx.db(), b.bills);
  if (b?.spending && /^\d{4}-\d{2}$/.test(b.spending.month ?? '') && Array.isArray(b.spending.rows)) setSpending(ctx.db(), b.spending.month, b.spending.rows);
  ctx.broadcast({ type: 'personal' });
  ctx.json(res, 200, { ok: true });
});

// ── the Daily ──

on('GET', '/api/daily', (_q, res, url, ctx) => {
  const db = ctx.db();
  ctx.json(res, 200, { edition: getEdition(db, url.searchParams.get('day') ?? undefined), editions: listEditions(db), settings: dailySettings(db), generating: isGenerating(), conversation: DAILY_CONVERSATION });
});
on('POST', '/api/daily/generate', (_q, res, _u, ctx) => {
  generateDaily(ctx.db());
  ctx.json(res, 200, { generating: true });
});
on('POST', '/api/daily/settings', async (req, res, _u, ctx) => {
  try {
    const s = saveDailySettings(ctx.db(), await ctx.readBody(req));
    ctx.broadcast({ type: 'daily' });
    ctx.json(res, 200, s);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});
on('POST', '/api/daily/publish', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.headline) throw new HttpError(400, 'headline required');
  ctx.json(res, 200, publishEdition(ctx.db(), b));
});
on('GET', '/api/daily/:day/audio', (_q, res, _u, ctx, p) => {
  const ws = currentWorkspace();
  const ed = getEdition(ctx.db(), p.day);
  if (!ws || !ed?.audio) throw new HttpError(404, 'no audio');
  const file = join(ws.vault, 'personal', 'daily', ed.audio);
  if (!existsSync(file)) throw new HttpError(404, 'no audio');
  res.writeHead(200, { 'content-type': ed.audio.endsWith('.m4a') ? 'audio/mp4' : 'audio/aiff' });
  res.end(readFileSync(file));
});

// ── integrations ──

on('GET', '/api/integrations', async (_q, res, url, ctx) => {
  const db = ctx.db();
  const servers = await listServers(url.searchParams.get('refresh') === '1');
  const roles = listRoles(db);
  const seen = toolsSeen(db);
  const policies = toolPolicies(db);
  ctx.json(res, 200, {
    servers: servers.map((s) => ({
      ...s,
      roles: roles.map((r) => ({ id: r.id, name: r.name, allowed: serverAllowed(db, r.id, s) })),
      tools: (seen[s.prefix] ?? []).map((t) => ({ name: t, policy: policies[t] ?? policies[s.prefix] ?? 'ask' })),
      policy: policies[s.prefix] ?? 'ask',
    })),
  });
});
on('POST', '/api/integrations/access', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.role || !b?.server) throw new HttpError(400, 'role and server required');
  setServerAccess(ctx.db(), b.role, b.server, Boolean(b.allowed));
  ctx.json(res, 200, { ok: true });
});
on('POST', '/api/integrations/policy', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.tool || !['allow', 'ask', 'deny'].includes(b?.policy)) throw new HttpError(400, 'tool and policy (allow|ask|deny) required');
  setToolPolicy(ctx.db(), b.tool, b.policy);
  ctx.json(res, 200, { ok: true });
});

// ── usage ──

on('GET', '/api/usage', (_q, res, _u, ctx) => ctx.json(res, 200, getUsage(ctx.db())));
on('POST', '/api/usage/alert', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const cur = usageAlert(ctx.db());
  const threshold = Math.min(99, Math.max(10, Number(b?.threshold ?? cur.threshold)));
  putSetting(ctx.db(), 'brain.usage_alert', { threshold, push: b?.push ?? cur.push });
  ctx.broadcast({ type: 'usage' });
  ctx.json(res, 200, getUsage(ctx.db()));
});

on('GET', '/api/decisions/recent', (_q, res, _u, ctx) => ctx.json(res, 200, listDecisions(ctx.db(), null, 20)));
