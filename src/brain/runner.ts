// Runs one agent turn: `claude -p` on the user's subscription (D3), resumed
// per (role, conversation) so each role keeps its own context. Output streams
// into the chat; tool calls that are not pre-allowed go to the in-app
// approvals flow through the brain MCP server's `approve` tool.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBus } from './bus.js';
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
/** Runs one turn; resolves to the text the role posted (null if nothing). */
async function runTurn(roleId: string, conversationId: string, modelOverride?: string): Promise<string | null> {
  const db = getBus().db();
  const role = getRole(db, roleId);
  const ws = currentWorkspace();
  if (!role) return null;
  if (!ws) {
    emitMessage(addMessage(db, conversationId, roleId, 'Set up a workspace folder first: agents only run inside it.', 'error'));
    return null;
  }
  const session = getSession(db, roleId, conversationId);
  const pending = pendingPrompt(role, conversationId, session?.seen_message_id ?? 0);
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
  const denied = [...globalDeny, ...blockedServers(db, roleId), ...standingTools(db, roleId, 'deny')];
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
    if (ev.session_id) sessionId = ev.session_id;
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

