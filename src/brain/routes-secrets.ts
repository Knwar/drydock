// /api routes for secrets. No route ever returns a secret value: values go in
// (saved to the password manager) and are injected into approved commands.
// Agent actions that use or replace a secret go through a one-time ticket:
// the approval card shows exactly what runs, and only that runs.
import { randomUUID } from 'node:crypto';
import type { DB } from '../core/db.js';
import { addMessage, getApproval, getConversation, getMessage, updateMessageMeta } from './chat.js';
import { openApproval } from './routes-chat.js';
import { getRole } from './roles.js';
import { HttpError, on, type ApiCtx } from './router.js';
import { respond } from './runner.js';
import {
  clearBwsToken,
  deleteSecret,
  generateValue,
  getSecret,
  installProvider,
  listSecrets,
  lockBitwarden,
  moveFromFile,
  providerStatus,
  rotateSecret,
  runWithSecrets,
  saveSecretSettings,
  SecretError,
  secretSettings,
  setBitwardenServer,
  setBwsToken,
  PROVIDER_NAME,
  storeSecret,
  unlockBitwarden,
  type SecretRow,
} from './secrets.js';
import { currentWorkspace } from './workspace.js';

const STATUS: Record<SecretError['code'], number> = { not_configured: 409, locked: 423, not_found: 404, denied: 403, invalid: 400, cli: 502 };

/** SecretError → HTTP error with its code, so agents and the app can tell "locked" from "denied". */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SecretError) throw new HttpError(STATUS[e.code], e.message, { code: e.code });
    throw e;
  }
}

const view = (r: SecretRow) => ({ name: r.name, project_id: r.project_id, provider: r.provider, kind: r.kind, note: r.note, created_at: r.created_at, rotated_at: r.rotated_at, used_at: r.used_at });

// ── app: provider setup ───────────────────────────────────────────

on('GET', '/api/secrets', async (_q, res, _u, ctx) => {
  const db = ctx.db();
  ctx.json(res, 200, { ...(await providerStatus(db)), secrets: listSecrets(db).map(view) });
});

on('POST', '/api/secrets/settings', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const patch: any = {};
  if (b?.provider !== undefined) {
    if (![null, '1password', 'bitwarden', 'bws'].includes(b.provider)) throw new HttpError(400, 'provider must be 1password, bitwarden, bws or null');
    patch.provider = b.provider;
  }
  if (b?.confirmOnMac !== undefined) patch.confirmOnMac = Boolean(b.confirmOnMac);
  if (b?.bws) {
    const url = b.bws.serverUrl ? String(b.bws.serverUrl).trim() : null;
    if (url && !/^https:\/\//.test(url)) throw new HttpError(400, 'The Secrets Manager server must be an https:// address');
    patch.bws = { serverUrl: url || null, projectId: b.bws.projectId ? String(b.bws.projectId) : null };
  }
  if (b?.onepassword) patch.onepassword = { vault: String(b.onepassword.vault ?? 'AI Brain').trim() || 'AI Brain', account: b.onepassword.account ? String(b.onepassword.account) : null, askEveryTime: Boolean(b.onepassword.askEveryTime) };
  if (b?.bitwarden) patch.bitwarden = { ...secretSettings(ctx.db()).bitwarden, folder: String(b.bitwarden.folder ?? 'AI Brain').trim() || 'AI Brain', unlockMinutes: Math.min(240, Math.max(1, Number(b.bitwarden.unlockMinutes) || 15)) };
  saveSecretSettings(ctx.db(), patch);
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, await providerStatus(ctx.db()));
});

on('POST', '/api/secrets/install', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!['1password', 'bitwarden', 'bws'].includes(b?.provider)) throw new HttpError(400, 'provider must be 1password, bitwarden or bws');
  await guard(() => installProvider(b.provider));
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, await providerStatus(ctx.db()));
});

on('POST', '/api/secrets/bitwarden/server', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  await guard(() => setBitwardenServer(ctx.db(), String(b?.server ?? '')).catch((e) => { throw e instanceof TypeError ? new SecretError('That is not a valid address.', 'invalid') : e; }));
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, await providerStatus(ctx.db()));
});

on('POST', '/api/secrets/bitwarden/unlock', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const until = await guard(() => unlockBitwarden(ctx.db(), String(b?.password ?? '')));
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, { unlockedUntil: until });
});

on('POST', '/api/secrets/bws/token', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (b?.token === null) await clearBwsToken();
  else await guard(() => setBwsToken(String(b?.token ?? '').trim()));
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, await providerStatus(ctx.db()));
});

on('POST', '/api/secrets/bitwarden/lock', (_q, res, _u, ctx) => {
  lockBitwarden();
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, { locked: true });
});

// ── saving: from the app (a pasted key) or an agent (save_secret) ─

/** Body: name + one of value | generate {bytes} | from_file {path, key}; optional project_id, note, request (a secret_request message id). */
on('POST', '/api/secrets', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const name = String(b?.name ?? '');
  const projectId = b?.project_id ? String(b.project_id) : null;
  const note = b?.note ? String(b.note).slice(0, 300) : null;
  const row = await guard(async () => {
    if (b?.from_file) return moveFromFile(db, String(b.from_file.path ?? ''), String(b.from_file.key ?? ''), name, projectId, note);
    if (b?.generate) return storeSecret(db, { name, value: generateValue(Number(b.generate.bytes) || 32), kind: 'generated', projectId, note });
    return storeSecret(db, { name, value: String(b?.value ?? ''), kind: 'provided', projectId, note });
  });
  // answer a request card
  const reqMsg = b?.request ? getMessage(db, Number(b.request)) : null;
  if (reqMsg?.kind === 'secret_request') {
    const updated = updateMessageMeta(db, reqMsg.id, { ...reqMsg.meta, status: 'saved', saved_at: Date.now() });
    ctx.broadcast({ type: 'chat_update', conversation: reqMsg.conversation_id, message: updated });
    const m = addMessage(db, reqMsg.conversation_id, 'user', `Saved ${row.name} to ${PROVIDER_NAME[row.provider]}. Use it by name with run_with_secrets.`);
    ctx.broadcast({ type: 'chat', conversation: reqMsg.conversation_id, message: m });
    respond(reqMsg.conversation_id); // the agent that asked carries on
  }
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, view(row));
});

/** The app's delete (behind a confirmation): archived in 1Password / trashed in Bitwarden. */
on('DELETE', '/api/secrets/:name', async (_q, res, _u, ctx, p) => {
  await guard(() => deleteSecret(ctx.db(), p.name));
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, { deleted: p.name });
});

/** The app's rotate (behind a confirmation). */
on('POST', '/api/secrets/:name/rotate', async (_q, res, _u, ctx, p) => {
  const row = await guard(() => rotateSecret(ctx.db(), p.name));
  ctx.broadcast({ type: 'secrets' });
  ctx.json(res, 200, view(row));
});

// ── agents: list, request, and ticketed use ───────────────────────

on('GET', '/api/secrets/names', (_q, res, url, ctx) => {
  ctx.json(res, 200, listSecrets(ctx.db(), url.searchParams.get('project')).map(view));
});

/** request_secret: a card where the user pastes a key from another service. */
on('POST', '/api/secrets/request', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const conversation = String(b?.conversation ?? '');
  if (!getConversation(db, conversation)) throw new HttpError(400, 'conversation required');
  const name = String(b?.name ?? '');
  await guard(() => {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new SecretError('Secret names are UPPER_SNAKE_CASE env var names, e.g. STRIPE_API_KEY', 'invalid');
  });
  const url = typeof b?.url === 'string' && /^https:\/\//.test(b.url) ? b.url : null;
  const m = addMessage(db, conversation, String(b?.role ?? 'main'), `Needs ${name}`, 'secret_request', {
    name,
    purpose: String(b?.purpose ?? '').slice(0, 300),
    url,
    project_id: b?.project_id ?? null,
    exists: Boolean(getSecret(db, name)),
    status: 'pending',
  });
  ctx.broadcast({ type: 'chat', conversation, message: m });
  ctx.json(res, 200, { message: m.id });
});

interface Ticket {
  kind: 'run' | 'rotate';
  role: string;
  conversation: string | null;
  approval: string | null;
  input: { command?: string; secrets?: string[]; cwd?: string; name?: string };
  used: boolean;
  at: number;
}
const tickets = new Map<string, Ticket>();
const TICKET_TTL = 30 * 60_000;

/** Where an agent's command runs: its project's folder, or the workspace root. */
function defaultCwd(db: DB, conversation: string | null): string {
  const ws = currentWorkspace();
  if (!ws) throw new HttpError(400, 'no workspace');
  const c = conversation ? getConversation(db, conversation) : null;
  const p = c?.project_id ? (db.prepare('SELECT root_path FROM projects WHERE id = ?').get(c.project_id) as { root_path: string } | undefined) : undefined;
  return p?.root_path ?? ws.root;
}

function openTicket(ctx: ApiCtx, kind: Ticket['kind'], role: string, conversation: string | null, input: Ticket['input'], tool: string) {
  for (const [id, t] of tickets) if (Date.now() - t.at > TICKET_TTL) tickets.delete(id);
  const a = openApproval(ctx, role, conversation, tool, input);
  const id = randomUUID();
  tickets.set(id, { kind, role, conversation, approval: a.id, input, used: false, at: Date.now() });
  if (a.status === 'denied') tickets.get(id)!.used = true;
  return { ticket: id, approval: a.id, status: a.status, note: a.note };
}

/** run_with_secrets, step 1: validate and ask. The agent then waits on the approval and calls execute. */
on('POST', '/api/secrets/run', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const role = String(b?.role ?? '');
  if (!getRole(db, role)) throw new HttpError(400, 'role required');
  const command = String(b?.command ?? '').trim();
  const names = Array.isArray(b?.secrets) ? b.secrets.map(String) : [];
  if (!command || !names.length) throw new HttpError(400, 'command and secrets required');
  const missing = names.filter((n: string) => !getSecret(db, n));
  if (missing.length) throw new HttpError(404, `No secret named ${missing.join(', ')}. list_secrets shows what exists; request_secret asks the user for a new one.`);
  const conversation = b?.conversation ? String(b.conversation) : null;
  const cwd = b?.cwd ? String(b.cwd) : defaultCwd(db, conversation);
  ctx.json(res, 200, openTicket(ctx, 'run', role, conversation, { command, secrets: names, cwd }, 'run_with_secrets'));
});

/** rotate_secret from an agent: same ticket flow (a rotation can break whatever uses the old value). */
on('POST', '/api/secrets/rotate-request', async (req, res, _u, ctx) => {
  const db = ctx.db();
  const b = await ctx.readBody(req);
  const role = String(b?.role ?? '');
  if (!getRole(db, role)) throw new HttpError(400, 'role required');
  const name = String(b?.name ?? '');
  const row = getSecret(db, name);
  if (!row) throw new HttpError(404, `No secret named ${name}`);
  if (row.kind !== 'generated') throw new HttpError(400, `${name} was issued by another service; ask the user to create a new key there and save it with request_secret.`);
  ctx.json(res, 200, openTicket(ctx, 'rotate', role, b?.conversation ? String(b.conversation) : null, { name }, 'rotate_secret'));
});

/** Step 2: run exactly what was approved, once. */
on('POST', '/api/secrets/tickets/:id/execute', async (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const t = tickets.get(p.id);
  if (!t || Date.now() - t.at > TICKET_TTL) throw new HttpError(404, 'unknown or expired ticket');
  if (t.used) throw new HttpError(409, 'this ticket was already used or denied');
  if (t.approval) {
    const a = getApproval(db, t.approval);
    if (a?.status === 'pending') throw new HttpError(409, 'still waiting for the user');
    if (a?.status !== 'allowed') {
      t.used = true;
      throw new HttpError(403, a?.note ? `The user denied this: ${a.note}` : 'The user denied this.');
    }
  }
  t.used = true;
  const who = getRole(db, t.role)?.name ?? t.role;
  if (t.kind === 'rotate') {
    const row = await guard(() => rotateSecret(db, t.input.name!));
    ctx.broadcast({ type: 'secrets' });
    return ctx.json(res, 200, { rotated: row.name });
  }
  const out = await guard(() => runWithSecrets(db, { command: t.input.command!, secrets: t.input.secrets!, cwd: t.input.cwd!, reason: `${who} wants to use ${t.input.secrets!.join(', ')}` }));
  ctx.json(res, 200, out);
});
