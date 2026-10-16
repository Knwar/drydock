// Runs one agent turn: `claude -p` on the user's subscription (D3), resumed
// per (role, conversation) so each role keeps its own context. Output streams
// into the chat; tool calls that are not pre-allowed go to the in-app
// approvals flow through the brain MCP server's `approve` tool.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBus, isShuttingDown } from './bus.js';
import { addMissingColumns, defineSchema } from './schema.js';
import { getSetting } from './settings.js';
import { addMessage, getConversation, getSession, listMessages, members, saveSession, standingTools, type Message } from './chat.js';
import { getRole, listRoles, type Role } from './roles.js';
import { blockedServers, listServers, recordTools, toolPolicies } from './integrations.js';
import { activeLearnings, memoryDigest, projectMembers } from './teamwork.js';
import { onRateLimit } from './usage.js';
import { currentWorkspace } from './workspace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, 'mcp.ts');
const KANKAN_MCP = join(HERE, '..', 'mcp', 'server.ts');
const BRAIN_CLI = join(HERE, '..', '..', 'bin', 'brain.js');
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx/esm');
const CLAUDE_BIN = process.env.BRAIN_CLAUDE_BIN ?? 'claude';

/** Tools every role may use without asking: reading, searching, and AI Brain's own tools. */
export const ALWAYS_ALLOWED = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'mcp__brain'];
/** Project roles also run the board, its subagents and per-card worktrees without asking. */
export const PROJECT_ALLOWED = ['mcp__kankan', 'Task', 'Bash(brain worktree:*)', 'Bash(brain security-scan:*)'];
/** Secrets are reached only through the brain secret tools (approval + Touch ID), never the managers' CLIs or the Keychain directly. */
export const ALWAYS_DENIED = ['Bash(op:*)', 'Bash(bw:*)', 'Bash(bws:*)', 'Bash(security find-generic-password:*)', 'Bash(security find-internet-password:*)', 'Bash(security dump-keychain:*)'];

const running = new Map<string, { child: ChildProcess; roleId: string }>();
const queues = new Map<string, Promise<void>>();

export function activeRuns(): { conversation: string; role: string }[] {
  return [...running.entries()].map(([conversation, r]) => ({ conversation, role: r.roleId }));
}

export function stopRun(conversationId: string): boolean {
  const r = running.get(conversationId);
  if (!r) return false;
  r.child.kill('SIGTERM');
  return true;
}

function emitStatus(conversationId: string, roleId: string | null, status: 'working' | 'idle') {
  getBus().emit({ type: 'chat_status', conversation: conversationId, role: roleId, status });
}

function emitMessage(m: Message) {
  getBus().emit({ type: 'chat', conversation: m.conversation_id, message: m });
}

const roleName = (id: string, roles: Role[]) => (id === 'user' ? 'User' : roles.find((r) => r.id === id)?.name ?? id);

function systemPrompt(role: Role, conversationId: string): string {
  const db = getBus().db();
  const conv = getConversation(db, conversationId)!;
  const roles = listRoles(db);
  const ws = currentWorkspace();
  const profile = getSetting<{ name: string | null }>(db, 'brain.profile', { name: null });
  const lines = [
    role.persona,
    '',
    '## Context',
    `- Now: ${new Date().toString()}`,
    `- User: ${profile.name ?? 'the user'}`,
    `- Workspace folder: ${ws?.root ?? '(not set)'}; vault at vault/, projects at projects/`,
    `- Team: ${roles.map((r) => `${r.name} (${r.scope})`).join(', ')}`,
    conv.kind === 'dm'
      ? `- This is your direct chat with the user.`
      : `- This is the #${conv.name} channel. Members: ${members(db, conversationId).map((m) => roleName(m, roles)).join(', ')} and the user. Other members reply in turn after you; keep to your role.`,
  ];
  if (role.skill) lines.push(`- Use the ${role.skill} skill when it fits the task.`);
  lines.push(
    '',
    '## Secrets',
    "Never write a password, API key or token into a file, a message, a commit or a command line. Keys live in the user's password manager; you only ever handle their names (UPPER_SNAKE env var names).",
    '- Found one (in a file, an error, a paste)? Move it with save_secret (from_file for .env files) and refer to it by name from then on.',
    '- Need a new random secret (DB password, signing key)? save_secret with generate: you never see the value.',
    '- Need a key from another service? request_secret: the user pastes it into a card.',
    '- Need to use one? run_with_secrets runs your command with them as env vars, after the user approves and confirms on the Mac. Commit `.env.example` with names only, never `.env`.',
    '',
    '## Running the app on this Mac',
    "Every runnable project needs a run recipe (save_run_recipe) so the user can start it from the project overview: services listen on $PORT at 127.0.0.1, databases come from needs (list_local_services shows the user's servers), keys from secrets. Once started it restarts by itself on each merge. Use live_status and live_logs to test the running app and to debug a crash.",
  );
  // what this member has learned from repeated mistakes (capped, strongest first)
  const learned = activeLearnings(db, role.id);
  if (learned.length) lines.push('', '## Your learnings', 'You made these mistakes more than once before. Follow these rules:', ...learned.map((l) => `- ${l.rule}`));
  // a project conversation carries the project's team and its compact memory
  if (conv.project_id) {
    const team = projectMembers(db, conv.project_id);
    if (team.length) lines.push('', `## Project team`, ...team.map((m) => `- ${m.name} (${m.kind}${m.skill ? `, skill ${m.skill}` : ''})`));
    lines.push('', memoryDigest(db, conv.project_id));
  }
  return lines.join('\n');
}

/** What this role has not yet seen in the conversation, as a prompt. */
function pendingPrompt(role: Role, conversationId: string, seen: number): { prompt: string; lastId: number } | null {
  const db = getBus().db();
  const conv = getConversation(db, conversationId)!;
  const roles = listRoles(db);
  const fresh = listMessages(db, conversationId, 100).filter((m) => m.id > seen && m.author !== role.id && m.kind === 'text');
  if (!fresh.length) return null;
  const lastId = fresh[fresh.length - 1].id;
  if (conv.kind === 'dm') return { prompt: fresh.map((m) => m.body).join('\n\n'), lastId };
  const transcript = fresh.map((m) => `${roleName(m.author, roles)}: ${m.body}`).join('\n\n');
  return {
    prompt: `New messages in #${conv.name}:\n\n${transcript}\n\nReply as ${role.name} if you have something useful to add from your role. If not, reply with exactly PASS.`,
    lastId,
  };
}

function mcpConfig(roleId: string, conversationId: string, dataDir: string, withBoard: boolean): string {
  const dir = join(dataDir, 'runs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${roleId}__${conversationId.replace(/[^a-z0-9-]/gi, '_')}.mcp.json`);
  const servers: Record<string, unknown> = {
    brain: {
      command: process.execPath,
      args: ['--import', TSX_LOADER, MCP_SERVER],
      env: { BRAIN_DAEMON_URL: getBus().daemonUrl, BRAIN_ROLE: roleId, BRAIN_CONVERSATION: conversationId },
    },
  };
  // project roles drive the kankanban board (phases, cards, worktrees)
  if (withBoard) servers.kankan = { command: process.execPath, args: ['--import', TSX_LOADER, KANKAN_MCP], env: { DAEMON_URL: getBus().daemonUrl } };
  writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

/** A `brain` command on the agents' PATH (the kankan protocol runs `brain worktree …`). */
function shimDir(dataDir: string): string {
  const dir = join(dataDir, 'bin');
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'brain');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BRAIN_CLI}" "$@"\n`);
  chmodSync(shim, 0o755);
  return dir;
}

/** Run one turn for `roleId` in the conversation, if it has anything new to answer. */
/**
 * Runs one turn; resolves to the text the role posted (null if nothing).
 * Whatever goes wrong, the agent process is stopped, the conversation stops
 * showing "working", and the error is posted where the user can see it.
 */
async function runTurn(roleId: string, conversationId: string, modelOverride?: string, resumeNote?: string): Promise<string | null> {
  try {
    return await runTurnInner(roleId, conversationId, modelOverride, resumeNote);
  } catch (err) {
    const r = running.get(conversationId);
    if (r?.roleId === roleId) {
      r.child.kill('SIGTERM');
      running.delete(conversationId);
    }
    try {
      clearRun(conversationId);
      emitMessage(addMessage(getBus().db(), conversationId, roleId, `Something went wrong running this agent: ${(err as Error).message}`, 'error'));
    } catch {
      /* the DB itself failed: the log line below is all we can do */
    }
    console.error(`agent turn failed in ${conversationId}: ${(err as Error).message}`);
    getBus().emit({ type: 'chat_delta', conversation: conversationId, role: roleId, text: '' });
    emitStatus(conversationId, roleId, 'idle');
    return null;
  }
}

async function runTurnInner(roleId: string, conversationId: string, modelOverride?: string, resumeNote?: string): Promise<string | null> {
  const db = getBus().db();
  const role = getRole(db, roleId);
  const ws = currentWorkspace();
  if (!role) return null;
  if (!ws) {
    emitMessage(addMessage(db, conversationId, roleId, 'Set up a workspace folder first: agents only run inside it.', 'error'));
    return null;
  }
  const session = getSession(db, roleId, conversationId);
  // a resumed run continues its own session with a nudge instead of new messages
  const pending = resumeNote
    ? { prompt: resumeNote, lastId: session?.seen_message_id ?? 0 }
    : pendingPrompt(role, conversationId, session?.seen_message_id ?? 0);
  if (!pending) return null;

  const conv = getConversation(db, conversationId)!;
  let cwd = ws.root;
  if (conv.project_id && role.scope === 'project') {
    const p = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(conv.project_id) as { root_path: string } | undefined;
    if (p) cwd = p.root_path;
  }
  const projectRole = Boolean(conv.project_id && role.scope === 'project');
  void listServers(); // refreshes in the background; role access uses the cached list
  const policies = toolPolicies(db);
  const globalAllow = Object.keys(policies).filter((t) => policies[t] === 'allow');
  const globalDeny = Object.keys(policies).filter((t) => policies[t] === 'deny');
  const allowed = [...ALWAYS_ALLOWED, ...(projectRole ? PROJECT_ALLOWED : []), ...globalAllow, ...standingTools(db, roleId, 'allow')];
  const denied = [...ALWAYS_DENIED, ...globalDeny, ...blockedServers(db, roleId), ...standingTools(db, roleId, 'deny')];
  const args = [
    '-p',
    pending.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', modelOverride ?? role.model,
    '--append-system-prompt', systemPrompt(role, conversationId),
    '--mcp-config', mcpConfig(roleId, conversationId, ws.data, projectRole),
    '--permission-prompt-tool', 'mcp__brain__approve',
    '--allowedTools', ...allowed,
  ];
  if (denied.length) args.push('--disallowedTools', ...denied);
  if (session) args.push('--resume', session.session_id);

  emitStatus(conversationId, roleId, 'working');
  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    env: {
      ...process.env,
      PATH: `${shimDir(ws.data)}:${process.env.PATH ?? ''}`,
      DAEMON_URL: getBus().daemonUrl,
      BRAIN_WORKSPACE: ws.root,
      MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(conversationId, { child, roleId });
  markRun(conversationId, roleId, session?.session_id ?? null, modelOverride ?? null, pending.lastId);

  let sessionId = session?.session_id ?? null;
  let streamed = '';
  let lastEmit = 0;
  let final: any = null;
  let stderr = '';
  let buf = '';

  const flushDelta = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    getBus().emit({ type: 'chat_delta', conversation: conversationId, role: roleId, text: streamed });
  };

  const onLine = (line: string) => {
    if (!line.trim()) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.session_id && ev.session_id !== sessionId) {
      const sid: string = ev.session_id;
      sessionId = sid;
      // remember the session at once, so a run cut off by a restart can resume it
      saveSession(getBus().db(), roleId, conversationId, sid, session?.seen_message_id ?? 0);
      markRun(conversationId, roleId, sid, modelOverride ?? null, pending.lastId);
    }
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.tools)) recordTools(getBus().db(), ev.tools);
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
      streamed += ev.event.delta.text;
      flushDelta();
    } else if (ev.type === 'stream_event' && ev.event?.type === 'message_start') {
      streamed = '';
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'tool_use') recordTools(getBus().db(), [c.name]);
        if (c.type === 'tool_use' && c.name !== 'mcp__brain__approve' && !String(c.name).startsWith('mcp__brain__log_')) {
          const summary = toolSummary(c.name, c.input);
          emitMessage(addMessage(getBus().db(), conversationId, roleId, summary, 'tool', { name: c.name, input: truncate(c.input) }));
        }
      }
    } else if (ev.type === 'rate_limit_event') {
      onRateLimit(getBus().db(), ev);
    } else if (ev.type === 'result') {
      final = ev;
    }
  };

  child.stdout!.setEncoding('utf8').on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d).length > 8000 && (stderr = stderr.slice(-8000)));

  const code: number | null = await new Promise((res) => {
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      res(-1);
    });
    child.on('close', (c) => res(c));
  });
  if (buf) onLine(buf);
  running.delete(conversationId);
  // cut off by a shutdown: keep the run recorded (it resumes on the next start) and post nothing
  if (isShuttingDown()) return null;
  clearRun(conversationId);

  const db2 = getBus().db();
  if (sessionId) saveSession(db2, roleId, conversationId, sessionId, pending.lastId);
  const text: string = typeof final?.result === 'string' ? final.result.trim() : streamed.trim();
  const meta = final ? { cost_usd: final.total_cost_usd ?? null, duration_ms: final.duration_ms ?? null, turns: final.num_turns ?? null, usage: final.usage ?? null } : null;
  if (final && !final.is_error && text && text !== 'PASS') {
    emitMessage(addMessage(db2, conversationId, roleId, text, 'text', meta));
  } else if (!final || final.is_error) {
    const reason = code === null || code === 143 ? 'Stopped.' : (final?.result || stderr.trim().split('\n').slice(-3).join('\n') || `claude exited with code ${code}`);
    emitMessage(addMessage(db2, conversationId, roleId, String(reason).slice(0, 2000), 'error', meta));
  }
  getBus().emit({ type: 'chat_delta', conversation: conversationId, role: roleId, text: '' });
  emitStatus(conversationId, roleId, 'idle');
  return final && !final.is_error && text && text !== 'PASS' ? text : null;
}

/** Channel members @mentioned in `text` (by name or id), in member order. */
function mentionedMembers(conversationId: string, text: string, exclude: string[] = []): string[] {
  const db = getBus().db();
  const roles = listRoles(db);
  return members(db, conversationId).filter((id) => {
    if (exclude.includes(id)) return false;
    const r = roles.find((x) => x.id === id);
    return r && new RegExp(`@(${escape(r.name)}|${escape(r.id)})\\b`, 'i').test(text);
  });
}

const truncate = (v: unknown) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 1500 ? JSON.parse(JSON.stringify({ truncated: s.slice(0, 1500) })) : v;
};

export function toolSummary(name: string, input: any): string {
  const short = (s: unknown, n = 90) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  if (name === 'Bash') return `Ran: ${short(input?.command)}`;
  if (name === 'Read') return `Read ${short(input?.file_path)}`;
  if (name === 'Write') return `Wrote ${short(input?.file_path)}`;
  if (name === 'Edit' || name === 'MultiEdit') return `Edited ${short(input?.file_path)}`;
  if (name === 'Glob' || name === 'Grep') return `Searched ${short(input?.pattern)}`;
  if (name === 'WebSearch') return `Searched the web: ${short(input?.query)}`;
  if (name === 'WebFetch') return `Opened ${short(input?.url)}`;
  if (name === 'run_with_secrets') return `Run a command with ${short((input?.secrets ?? []).join(', '), 60)}`;
  if (name === 'rotate_secret') return `Replace ${short(input?.name)} with a new random value`;
  if (name.startsWith('mcp__')) return `Used ${name.replace(/^mcp__/, '').replace(/__/, ' › ')}`;
  return `Used ${name}`;
}

/**
 * Queue the conversation's members to answer: a DM's role, or each channel
 * member in turn (only those @mentioned, when anyone is).
 */
export function respond(conversationId: string, mentionText = '', opts: { model?: string; onDone?: () => void } = {}): void {
  const db = getBus().db();
  const conv = getConversation(db, conversationId);
  if (!conv) return;
  let who = conv.kind === 'dm' ? [conv.role_id!] : members(db, conversationId);
  if (conv.kind === 'channel') {
    const mentioned = mentionedMembers(conversationId, mentionText);
    if (mentioned.length) who = mentioned;
  }
  const prev = queues.get(conversationId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      // In a channel, a reply that @mentions a teammate hands over to them,
      // up to MAX_HANDOFFS extra turns per user message (no endless ping-pong).
      const queue = [...who];
      let handoffs = 0;
      while (queue.length) {
        const roleId = queue.shift()!;
        const posted = await runTurn(roleId, conversationId, opts.model);
        if (conv.kind !== 'channel' || !posted) continue;
        for (const next of mentionedMembers(conversationId, posted, [roleId, ...queue])) {
          if (handoffs >= MAX_HANDOFFS) break;
          queue.push(next);
          handoffs++;
        }
      }
    })
    .catch((err) => console.error(`agent turn failed in ${conversationId}: ${(err as Error).message}`))
    .finally(() => opts.onDone?.());
  queues.set(conversationId, next);
}

const MAX_HANDOFFS = 4;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


// ── runs survive restarts ────────────────────────────────────────

defineSchema(
  `
CREATE TABLE IF NOT EXISTS agent_runs (
  conversation_id TEXT PRIMARY KEY,
  role_id         TEXT NOT NULL,
  session_id      TEXT,
  model           TEXT,
  seen_upto       INTEGER NOT NULL DEFAULT 0, -- the last message this run was answering
  started_at      INTEGER NOT NULL
);
`,
  (db) => addMissingColumns(db, 'agent_runs', { seen_upto: 'INTEGER NOT NULL DEFAULT 0' }),
);

function markRun(conversationId: string, roleId: string, sessionId: string | null, model: string | null, seenUpto = 0): void {
  getBus()
    .db()
    .prepare(
      `INSERT INTO agent_runs (conversation_id, role_id, session_id, model, seen_upto, started_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET role_id = excluded.role_id, session_id = COALESCE(excluded.session_id, agent_runs.session_id),
         model = excluded.model, seen_upto = MAX(agent_runs.seen_upto, excluded.seen_upto)`,
    )
    .run(conversationId, roleId, sessionId, model, seenUpto, Date.now());
}

function clearRun(conversationId: string): void {
  getBus().db().prepare('DELETE FROM agent_runs WHERE conversation_id = ?').run(conversationId);
}

/**
 * On startup: runs still recorded were cut off by a restart. Say so in the
 * thread and resume each agent in its own session, so it keeps its work.
 */
const PROCESS_STARTED = Date.now();

export function resumeInterruptedRuns(): number {
  const db = getBus().db();
  // only runs left over from a previous process, never one running now
  const rows = (db.prepare('SELECT conversation_id, role_id, session_id, model, seen_upto, started_at FROM agent_runs WHERE started_at < ?').all(PROCESS_STARTED) as any[]).filter((r) => !running.has(r.conversation_id)) as { conversation_id: string; role_id: string; session_id: string | null; model: string | null; seen_upto: number }[];
  for (const r of rows) {
    clearRun(r.conversation_id);
    if (!getConversation(db, r.conversation_id) || !getRole(db, r.role_id)) continue;
    const name = getRole(db, r.role_id)!.name;
    emitMessage(addMessage(db, r.conversation_id, r.role_id, `${name} was interrupted when AI Brain restarted. Resuming where they left off…`, 'error', { interrupted: true }));
    // the interrupted run had taken in everything up to seen_upto: mark it seen so it is not answered twice
    if (r.session_id) saveSession(db, r.role_id, r.conversation_id, r.session_id, r.seen_upto);
    const note = r.session_id
      ? 'You were interrupted by an app restart. Continue exactly where you left off: finish your task, then post your reply (summary, hand-offs) as you intended.'
      : undefined;
    const prev = queues.get(r.conversation_id) ?? Promise.resolve();
    queues.set(
      r.conversation_id,
      prev.then(async () => {
        const posted = note ? await runTurn(r.role_id, r.conversation_id, r.model ?? undefined, note) : await runTurn(r.role_id, r.conversation_id, r.model ?? undefined);
        // continue any hand-off the resumed reply makes, as a normal turn would
        if (posted) respond(r.conversation_id, posted);
      }).catch((err) => console.error(`resume failed in ${r.conversation_id}: ${(err as Error).message}`)),
    );
  }
  return rows.length;
}
