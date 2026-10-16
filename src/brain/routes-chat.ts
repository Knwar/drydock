// /api routes for the team: roles, conversations, messages, approvals,
// standing permissions and decisions.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  addMessage,
  createApproval,
  createChannel,
  decideApproval,
  ensureDms,
  getApproval,
  getConversation,
  getMessage,
  linkApprovalMessage,
  listConversations,
  listDecisions,
  listMessages,
  listPendingApprovals,
  listStanding,
  markRead,
  recordDecision,
  setStanding,
  standingTools,
  updateMessageMeta,
} from './chat.js';
import { deleteRole, getRole, listRoles, saveRole } from './roles.js';
import { HttpError, on, type ApiCtx } from './router.js';
import { activeRuns, respond, stopRun, toolSummary } from './runner.js';
import { currentWorkspace } from './workspace.js';

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new HttpError(404, `unknown ${what}`);
  return v;
};

// ── roles ─────────────────────────────────────────────────────────

on('GET', '/api/roles', (_q, res, _u, ctx) => ctx.json(res, 200, listRoles(ctx.db())));

on('POST', '/api/roles', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.name) throw new HttpError(400, 'name required');
  const role = saveRole(ctx.db(), b);
  ensureDms(ctx.db());
  ctx.broadcast({ type: 'roles' });
  ctx.broadcast({ type: 'conversations' });
  ctx.json(res, 200, role);
});

on('DELETE', '/api/roles/:id', (_q, res, _u, ctx, p) => {
  try {
    deleteRole(ctx.db(), p.id);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  ctx.broadcast({ type: 'roles' });
  ctx.json(res, 200, { ok: true });
});

// ── conversations and messages ───────────────────────────────────

on('GET', '/api/conversations', (_q, res, _u, ctx) => {
  const working = new Map(activeRuns().map((r) => [r.conversation, r.role]));
  ctx.json(res, 200, listConversations(ctx.db()).map((c) => ({ ...c, working: working.get(c.id) ?? null })));
});

on('POST', '/api/channels', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const ids = Array.isArray(b?.members) ? b.members.filter((m: string) => getRole(ctx.db(), m)) : [];
  let conv;
  try {
    conv = createChannel(ctx.db(), String(b?.name ?? ''), ids, b?.project_id ?? null);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  ctx.broadcast({ type: 'conversations' });
  ctx.json(res, 200, conv);
});

on('GET', '/api/conversations/:id/messages', (_q, res, _u, ctx, p) => {
  need(getConversation(ctx.db(), p.id), 'conversation');
  const run = activeRuns().find((r) => r.conversation === p.id);
  ctx.json(res, 200, { messages: listMessages(ctx.db(), p.id), working: run?.role ?? null });
});

on('POST', '/api/conversations/:id/messages', async (req, res, _u, ctx, p) => {
  need(getConversation(ctx.db(), p.id), 'conversation');
  const b = await ctx.readBody(req);
  const text = typeof b?.text === 'string' ? b.text.trim() : '';
  if (!text) throw new HttpError(400, 'text required');
  const m = addMessage(ctx.db(), p.id, 'user', text);
  markRead(ctx.db(), p.id);
  ctx.broadcast({ type: 'chat', conversation: p.id, message: m });
  respond(p.id, text);
  ctx.json(res, 200, m);
});

on('POST', '/api/conversations/:id/read', (_q, res, _u, ctx, p) => {
  markRead(ctx.db(), p.id);
  ctx.broadcast({ type: 'conversations' });
  ctx.json(res, 200, { ok: true });
});

on('POST', '/api/conversations/:id/stop', (_q, res, _u, ctx, p) => ctx.json(res, 200, { stopped: stopRun(p.id) }));

// ── approvals ─────────────────────────────────────────────────────

const waiters = new Map<string, Set<() => void>>();
const wake = (id: string) => {
  for (const w of waiters.get(id) ?? []) w();
  waiters.delete(id);
};

/** From the brain MCP server: an agent wants to run a tool that is not pre-allowed. */
on('POST', '/api/approvals', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const db = ctx.db();
  const roleId = String(b?.role ?? '');
  const tool = String(b?.tool ?? '');
  if (!getRole(db, roleId) || !tool) throw new HttpError(400, 'role and tool required');
  const conversation = b?.conversation && getConversation(db, b.conversation) ? String(b.conversation) : null;
  // a standing decision answers without asking
  if (standingTools(db, roleId, 'allow').includes(tool)) return ctx.json(res, 200, { id: null, status: 'allowed' });
  if (standingTools(db, roleId, 'deny').includes(tool)) return ctx.json(res, 200, { id: null, status: 'denied', note: 'blocked by a standing rule in Settings' });

  const a = createApproval(db, roleId, conversation, tool, b?.input);
  if (conversation) {
    const m = addMessage(db, conversation, roleId, toolSummary(tool, b?.input), 'approval', { approval_id: a.id, tool, input: b?.input ?? null, status: 'pending' });
    linkApprovalMessage(db, a.id, m.id);
    ctx.broadcast({ type: 'chat', conversation, message: m });
  }
  ctx.broadcast({ type: 'approvals' });
  ctx.json(res, 200, { id: a.id, status: a.status });
});

/** Long poll (≤25 s) until the approval is decided; the MCP tool loops on it. */
on('GET', '/api/approvals/:id/wait', async (_q, res, _u, ctx, p) => {
  const a = need(getApproval(ctx.db(), p.id), 'approval');
  if (a.status === 'pending') {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.get(p.id)?.delete(done);
        resolve();
      }, 25_000);
      if (!waiters.has(p.id)) waiters.set(p.id, new Set());
      waiters.get(p.id)!.add(done);
    });
  }
  const now = getApproval(ctx.db(), p.id)!;
  ctx.json(res, 200, { id: now.id, status: now.status, note: now.note });
});

on('GET', '/api/approvals', (_q, res, _u, ctx) => ctx.json(res, 200, listPendingApprovals(ctx.db())));

/** The user's answer: allow (once), always (allow + standing rule for this role and tool), or deny. */
on('POST', '/api/approvals/:id', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  const a = need(getApproval(db, p.id), 'approval');
  const b = await ctx.readBody(req);
  const decision = String(b?.decision ?? '');
  if (!['allow', 'always', 'deny'].includes(decision)) throw new HttpError(400, 'decision must be allow, always or deny');
  if (a.status !== 'pending') throw new HttpError(409, `already ${a.status}`);
  if (decision === 'always') setStanding(db, a.role_id, a.tool, 'allow');
  const done = decideApproval(db, a.id, decision === 'deny' ? 'denied' : 'allowed', typeof b?.note === 'string' ? b.note : null);
  if (a.message_id) {
    const m = getMessage(db, a.message_id);
    if (m) {
      const updated = updateMessageMeta(db, m.id, { ...m.meta, status: done.status, always: decision === 'always' });
      ctx.broadcast({ type: 'chat_update', conversation: m.conversation_id, message: updated });
    }
  }
  wake(a.id);
  ctx.broadcast({ type: 'approvals' });
  ctx.json(res, 200, done);
});

// ── standing permissions ──────────────────────────────────────────

on('GET', '/api/permissions', (_q, res, _u, ctx) => ctx.json(res, 200, listStanding(ctx.db())));

on('POST', '/api/permissions', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const policy = b?.policy === 'allow' || b?.policy === 'deny' ? b.policy : null;
  if (!getRole(ctx.db(), String(b?.role ?? '')) || !b?.tool) throw new HttpError(400, 'role and tool required');
  setStanding(ctx.db(), b.role, String(b.tool), policy);
  ctx.broadcast({ type: 'permissions' });
  ctx.json(res, 200, listStanding(ctx.db()));
});

// ── decisions ─────────────────────────────────────────────────────

function appendDecisionToVault(ctx: ApiCtx, projectId: string | null, line: string): string | null {
  const ws = currentWorkspace();
  if (!ws) return null;
  let file = join(ws.vault, 'decisions.md');
  if (projectId) {
    const p = ctx.db().prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (p) file = join(ws.vault, 'projects', basename(p.root_path), 'decisions.md');
  }
  mkdirSync(join(file, '..'), { recursive: true });
  if (!existsSync(file)) appendFileSync(file, '# Decisions\n\nNewest last. Written by AI Brain when a decision is agreed in chat.\n');
  appendFileSync(file, line);
  return file;
}

on('POST', '/api/decisions', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const title = String(b?.title ?? '').trim();
  if (!title) throw new HttpError(400, 'title required');
  const projectId = b?.project_id && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(b.project_id) ? String(b.project_id) : null;
  const conversation = b?.conversation && getConversation(db, b.conversation) ? String(b.conversation) : null;
  const followUps: string[] = Array.isArray(b?.follow_ups) ? b.follow_ups.map(String) : [];
  const roleId = b?.role ? String(b.role) : null;
  const id = recordDecision(db, { conversationId: conversation, projectId, roleId, title, why: b?.why ?? null, followUps });
  const date = new Date().toISOString().slice(0, 10);
  const file = appendDecisionToVault(
    ctx,
    projectId,
    `\n## ${date} · ${title}\n\n${b?.why ?? ''}\n${followUps.length ? '\nFollow-ups:\n' + followUps.map((f) => `- ${f}`).join('\n') + '\n' : ''}` +
      `\n_Agreed with ${roleId ? getRole(db, roleId)?.name ?? roleId : 'the user'}${conversation ? ` in ${conversation}` : ''}._\n`,
  );
  if (conversation) {
    const m = addMessage(db, conversation, roleId ?? 'main', title, 'decision', { decision_id: id, why: b?.why ?? null, follow_ups: followUps, file });
    ctx.broadcast({ type: 'chat', conversation, message: m });
  }
  ctx.broadcast({ type: 'decisions' });
  ctx.json(res, 200, { id, file });
});

on('GET', '/api/decisions', (_q, res, url, ctx) => ctx.json(res, 200, listDecisions(ctx.db(), url.searchParams.get('project'))));
