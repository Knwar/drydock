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
  members,
  recordDecision,
  setStanding,
  standingTools,
  updateMessageMeta,
} from './chat.js';
import { addFromTemplate, deleteRole, effectiveEffort, getRole, listRoles, ROLE_TEMPLATES, saveRole } from './roles.js';
import { HttpError, on, type ApiCtx } from './router.js';
import { activeRuns, respond, stopRun, toolSummary } from './runner.js';
import { currentWorkspace } from './workspace.js';
import { contractFor } from './contracts.js';
import { defaultSkills, roleSkills } from './skills.js';

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new HttpError(404, `unknown ${what}`);
  return v;
};

// ── roles ─────────────────────────────────────────────────────────

// each role with its app-owned contract (read-only in the app) and its resolved skills
on('GET', '/api/roles', (_q, res, _u, ctx) =>
  ctx.json(res, 200, listRoles(ctx.db()).map((r) => ({ ...r, default_effort: effectiveEffort({ id: r.id, effort: null }), contract: contractFor(r), skill_list: roleSkills(r), default_skills: defaultSkills(r.id) }))),
);

on('GET', '/api/role-templates', (_q, res, _u, ctx) => {
  const have = new Set(listRoles(ctx.db()).map((r) => r.id));
  ctx.json(res, 200, ROLE_TEMPLATES.map((t) => ({ ...t, added: have.has(t.id) })));
});

on('POST', '/api/roles', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.name && !b?.template) throw new HttpError(400, 'name or template required');
  let role;
  try {
    // skills: a list of library ids, or null for the role's defaults
    const skills = b.skills === undefined ? undefined : Array.isArray(b.skills) ? JSON.stringify(b.skills.map(String)) : null;
    role = b.template ? addFromTemplate(ctx.db(), String(b.template)) : saveRole(ctx.db(), { ...b, skills });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  ensureDms(ctx.db());
  ctx.broadcast({ type: 'roles' });
  ctx.broadcast({ type: 'conversations' });
  ctx.json(res, 200, role);
});

on('DELETE', '/api/roles/:id', (_q, res, _u, ctx, p) => {
  need(getRole(ctx.db(), p.id), 'role');
  // stop anything they are doing first
  for (const r of activeRuns()) if (r.role === p.id) stopRun(r.conversation);
  try {
    deleteRole(ctx.db(), p.id);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  ctx.broadcast({ type: 'roles' });
  ctx.broadcast({ type: 'conversations' });
  ctx.json(res, 200, { ok: true });
});

// ── conversations and messages ───────────────────────────────────

on('GET', '/api/conversations', (_q, res, _u, ctx) => {
  const working = new Map(activeRuns().map((r) => [r.conversation, r.role]));
  ctx.json(res, 200, listConversations(ctx.db()).map((c) => ({ ...c, working: working.get(c.id) ?? null })));
});

/** Start a thread with one or more members, optionally in a project, optionally with a first message. */
on('POST', '/api/channels', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const ids = Array.isArray(b?.members) ? b.members.filter((m: string) => getRole(db, m)) : [];
  let projectId: string | null = null;
  let scope: string | null = null;
  if (b?.project_id) {
    const p = db.prepare('SELECT id, root_path FROM projects WHERE id = ?').get(b.project_id) as { id: string; root_path: string } | undefined;
    if (!p) throw new HttpError(404, 'unknown project');
    projectId = p.id;
    scope = basename(p.root_path);
  }
  let conv;
  try {
    conv = createChannel(db, String(b?.name ?? ''), ids, projectId, scope);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  ctx.broadcast({ type: 'conversations' });
  const first = typeof b?.message === 'string' ? b.message.trim() : '';
  if (first) {
    const m = addMessage(db, conv.id, 'user', first);
    ctx.broadcast({ type: 'chat', conversation: conv.id, message: m });
    respond(conv.id, first);
  }
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
/** Ask the user to allow something: an approval card in the conversation (or only in "Needs you"). Standing rules answer at once. */
export function openApproval(ctx: ApiCtx, roleId: string, conversationId: string | null, tool: string, input: unknown): { id: string | null; status: string; note?: string } {
  const db = ctx.db();
  const conversation = conversationId && getConversation(db, conversationId) ? conversationId : null;
  // a standing decision answers without asking
  if (standingTools(db, roleId, 'allow').includes(tool)) return { id: null, status: 'allowed' };
  if (standingTools(db, roleId, 'deny').includes(tool)) return { id: null, status: 'denied', note: 'blocked by a standing rule in Settings' };
  const a = createApproval(db, roleId, conversation, tool, input);
  if (conversation) {
    const m = addMessage(db, conversation, roleId, toolSummary(tool, input), 'approval', { approval_id: a.id, tool, input: input ?? null, status: 'pending' });
    linkApprovalMessage(db, a.id, m.id);
    ctx.broadcast({ type: 'chat', conversation, message: m });
  }
  ctx.broadcast({ type: 'approvals' });
  return { id: a.id, status: a.status };
}

on('POST', '/api/approvals', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const roleId = String(b?.role ?? '');
  const tool = String(b?.tool ?? '');
  if (!getRole(ctx.db(), roleId) || !tool) throw new HttpError(400, 'role and tool required');
  ctx.json(res, 200, openApproval(ctx, roleId, b?.conversation ? String(b.conversation) : null, tool, b?.input));
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

// ── team proposals: the Main agent suggests, the user decides ─────

on('POST', '/api/role-proposals', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const conversation = b?.conversation && getConversation(db, b.conversation) ? String(b.conversation) : null;
  const template = b?.template ? ROLE_TEMPLATES.find((t) => t.id === b.template) : undefined;
  if (b?.template && !template) throw new HttpError(400, `unknown template ${b.template}; templates: ${ROLE_TEMPLATES.map((t) => t.id).join(', ')}`);
  const name = template?.name ?? String(b?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'name or template required');
  if (!conversation) throw new HttpError(400, 'conversation required');
  // join: also bring them into this chat (the user decides on the same card)
  const join = b?.join && getConversation(db, conversation)?.kind === 'channel' ? conversation : null;
  const existing = getRole(db, template?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  if (existing) {
    if (!join || members(db, conversation).includes(existing.id)) return ctx.json(res, 200, { status: 'exists' });
    const m = addMessage(db, conversation, String(b?.role ?? 'main'), `Add ${existing.name} to this chat?`, 'proposal', { status: 'pending', existing: true, role_id: existing.id, name: existing.name, join, reason: b?.reason ?? null, skills: roleSkills(existing) });
    ctx.broadcast({ type: 'chat', conversation, message: m });
    return ctx.json(res, 200, { status: 'proposed', message_id: m.id });
  }
  const meta = {
    join,
    skills: template ? defaultSkills(template.id) : [],
    status: 'pending',
    template: template?.id ?? null,
    name,
    skill: b?.skill ?? template?.skill ?? null,
    scope: b?.scope ?? template?.scope ?? 'shared',
    model: b?.model ?? template?.model ?? 'sonnet',
    persona: b?.persona ?? null,
    reason: b?.reason ?? null,
  };
  const m = addMessage(db, conversation, String(b?.role ?? 'main'), join ? `Add ${name} to your team and this chat?` : `Add ${name} to your team?`, 'proposal', meta);
  ctx.broadcast({ type: 'chat', conversation, message: m });
  ctx.json(res, 200, { status: 'proposed', message_id: m.id });
});

on('POST', '/api/role-proposals/:id', async (req, res, _u, ctx, p) => {
  const db = ctx.db();
  const m = need(getMessage(db, Number(p.id)), 'proposal');
  if (m.kind !== 'proposal') throw new HttpError(400, 'not a proposal');
  if (m.meta?.status !== 'pending') throw new HttpError(409, `already ${m.meta?.status}`);
  const b = await ctx.readBody(req);
  let role = null;
  if (b?.accept) {
    const mt = m.meta;
    role = mt.existing
      ? getRole(db, mt.role_id) ?? null
      : mt.template
        ? addFromTemplate(db, mt.template)
        : saveRole(db, { name: mt.name, skill: mt.skill, scope: mt.scope, model: mt.model, ...(mt.persona ? { persona: mt.persona } : {}) });
    ensureDms(db);
    if (role && mt.join && getConversation(db, mt.join)) {
      db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, role_id) VALUES (?, ?)').run(mt.join, role.id);
      const lead = members(db, mt.join)[0];
      const leadName = getRole(db, lead)?.name ?? 'Main agent';
      const note = addMessage(db, mt.join, 'system', `${role.name} joined this chat. @${leadName}: brief them on what you need from them.`);
      ctx.broadcast({ type: 'chat', conversation: mt.join, message: note });
      respond(mt.join, `@${leadName}`);
    }
  }
  const updated = updateMessageMeta(db, m.id, { ...m.meta, status: b?.accept ? 'added' : 'declined', role_id: role?.id ?? null });
  ctx.broadcast({ type: 'chat_update', conversation: m.conversation_id, message: updated });
  ctx.broadcast({ type: 'roles' });
  ctx.broadcast({ type: 'conversations' });
  ctx.json(res, 200, { status: updated.meta.status, role });
});

/** Everything waiting on the user, across conversations: approvals and team proposals. */
on('GET', '/api/needs-you', (_q, res, _u, ctx) => {
  const db = ctx.db();
  const approvals = listPendingApprovals(db).map((a) => ({
    id: a.id,
    role: a.role_id,
    tool: a.tool,
    summary: toolSummary(a.tool, a.input),
    conversation: a.conversation_id,
    created_at: a.created_at,
  }));
  const proposals = (
    db.prepare(`SELECT id, conversation_id, body, meta, created_at FROM messages WHERE kind = 'proposal' AND json_extract(meta, '$.status') = 'pending' ORDER BY id`).all() as any[]
  ).map((m) => ({ message_id: m.id, conversation: m.conversation_id, title: m.body, reason: JSON.parse(m.meta).reason ?? null, created_at: m.created_at }));
  const secrets = (
    db.prepare(`SELECT id, conversation_id, meta, created_at FROM messages WHERE kind = 'secret_request' AND json_extract(meta, '$.status') = 'pending' ORDER BY id`).all() as any[]
  ).map((m) => ({ message_id: m.id, conversation: m.conversation_id, name: JSON.parse(m.meta).name, created_at: m.created_at }));
  ctx.json(res, 200, { approvals, proposals, secrets });
});
