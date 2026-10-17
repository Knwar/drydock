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
import { addMessage, countTurn, getConversation, getSession, listMessages, members, saveSession, standingTools, type Message } from './chat.js';
import { effectiveEffort, getRole, listRoles, type Role } from './roles.js';
import { blockedServers, listServers, recordTools, toolPolicies } from './integrations.js';
import { activeLearnings, memoryDigest, projectMembers } from './teamwork.js';
import { disabledTools, projectPlugins, projectType } from './plugins.js';
import { contractFor, ideaChatRules } from './contracts.js';
import { getIdea, ideaDir } from './ideas.js';
import { PLUGIN, pluginDir, runSkills, skillById, subagentSkills } from './skills.js';
import { onRateLimit } from './usage.js';
import { currentWorkspace } from './workspace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, 'mcp.ts');
const KANKAN_MCP = join(HERE, '..', 'mcp', 'server.ts');
const BRAIN_CLI = join(HERE, '..', '..', 'bin', 'brain.js');
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx/esm');
const CLAUDE_BIN = process.env.BRAIN_CLAUDE_BIN ?? 'claude';

/** Tools every role may use without asking: reading, searching, and AI Brain's own tools. */
export const ALWAYS_ALLOWED = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill', 'mcp__brain'];
/** Project roles also run the board, its subagents and per-card worktrees without asking. */
export const PROJECT_ALLOWED = ['mcp__kanban', 'Task', 'Bash(brain worktree:*)', 'Bash(brain verify:*)', 'Bash(brain security-scan:*)'];
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
  // Order matters for the prompt cache: the same text must come first on every
  // run, so fixed parts lead and the parts that change (team, learnings, project
  // memory) come last. No clock here: each turn's message carries the time.
  // the contract (app-owned) leads; the user's persona and the skills follow and never override it
  const lines = [contractFor(role)];
  const idea = conv.idea_id ? getIdea(db, conv.idea_id) : undefined;
  if (idea) lines.push('', ideaChatRules(idea, members(db, conversationId)[0] === role.id, ideaDir(db, idea.id)));
  if (role.persona.trim()) lines.push('', '## About you (set by the user)', role.persona.trim());
  const sk = agentSkills(role, conv.project_id, conv.idea_id);
  if (sk.own.length || role.skill) {
    lines.push('', '## Your skills', 'Load the matching skill with the Skill tool before you do that kind of work. Where a skill disagrees with the rules above, the rules above win.');
    lines.push(...sk.own.map((id) => `- ${PLUGIN}:${id}: ${skillById(id)?.summary ?? ''}`));
    if (role.skill) lines.push(`- ${role.skill} (one of the user's own skills): use it when it fits.`);
  }
  if (sk.builder.length || sk.reviewer.length)
    lines.push('', 'When you dispatch subagents, name these skills in the brief so they load them:', ...(sk.builder.length ? [`- builder: ${sk.builder.map((id) => `${PLUGIN}:${id}`).join(', ')}`] : []), ...(sk.reviewer.length ? [`- reviewer: ${sk.reviewer.map((id) => `${PLUGIN}:${id}`).join(', ')}`] : []));
  lines.push(
    '',
    '## Secrets',
    "Never write a password, API key or token into a file, a message, a commit or a command line. Keys live in the user's password manager; you only ever handle their names (UPPER_SNAKE env var names).",
    '- Found one (in a file, an error, a paste)? Move it with save_secret (from_file for .env files) and refer to it by name from then on.',
    '- Need a new random secret (DB password, signing key)? save_secret with generate: you never see the value.',
    '- Need a key from another service? request_secret: the user pastes it into a card.',
    '- Need to use one? run_with_secrets runs your command with them as env vars, after the user approves and confirms on the Mac. Commit `.env.example` with names only, never `.env`.',
  );
  // only where the On this Mac plugin is on (or outside projects)
  if (!conv.project_id || projectPlugins(db, conv.project_id).includes('live')) lines.push(
    '',
    '## Running the app on this Mac',
    "Every runnable project needs a run recipe (save_run_recipe) so the user can start it from the project overview: services listen on $PORT at 127.0.0.1, databases come from needs (list_local_services shows the user's servers), keys from secrets, and verify is the check (tests, lint, typecheck) that must pass before a card merges. Once started it restarts by itself on each merge. After a merge, check the running app with live_check; use live_status and live_logs to debug a crash.",
  );
  lines.push(
    '',
    '## Working with tools and teammates',
    '- Ask tools for what you need, not everything: prefer filters, limits and the concise format; open details only when needed.',
    '- When you hand work to a teammate, write a short brief: the goal, what is known, what done looks like. Report back the result in a few lines, not the whole trace.',
    '',
    '## Context',
    `- User: ${profile.name ?? 'the user'}`,
    `- Workspace folder: ${ws?.root ?? '(not set)'}; vault at vault/, projects at projects/`,
    conv.kind === 'dm'
      ? `- This is your direct chat with the user.`
      : `- This is the #${conv.name} channel. Members: ${members(db, conversationId).map((m) => roleName(m, roles)).join(', ')} and the user. Only members @mentioned reply (when nobody is, ${roleName(members(db, conversationId)[0] ?? '', roles)} answers). @mention a teammate to bring them in; keep to your role.`,
    `- Team: ${roles.map((r) => `${r.name} (${r.scope})`).join(', ')}`,
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

/** The library skills a run gets: the role's own, plus (for the PM) those it hands its builders and reviewers. */
function agentSkills(role: Role, projectId: string | null, ideaId?: string | null): { own: string[]; builder: string[]; reviewer: string[] } {
  const db = getBus().db();
  const type = projectId ? projectType(db, projectId) : ideaId ? getIdea(db, ideaId)?.type ?? null : null;
  const pm = role.id === 'pm' && Boolean(projectId);
  return { own: runSkills(role, type), builder: pm ? subagentSkills('builder', type) : [], reviewer: pm ? subagentSkills('reviewer', type) : [] };
}

// ── sessions: fresh start with a handover after many turns ───────

export interface SessionLimits {
  maxTurns: number;
  /** tokens the latest model call read: the size of the context */
  maxContextTokens: number;
}
export const sessionLimits = (db: import('../core/db.js').DB): SessionLimits => ({ maxTurns: 60, maxContextTokens: 400_000, ...getSetting<Partial<SessionLimits>>(db, 'brain.sessions', {}) });

const HANDOVER =
  'Your session is being refreshed to keep your context lean; this message is the last one in it. Write a handover note for your next session, under 600 words: what this conversation is about, decisions made and why, the current state of the work, open questions and next steps, and facts you would otherwise have to rediscover (file paths, ids, commands, names). Plain text, no pleasantries, no tool calls.';

/** Ask the old session for its handover note, quietly (nothing is posted). Returns null if it fails. */
async function handoverNote(base: string[], cwd: string, env: NodeJS.ProcessEnv, roleId: string, conversationId: string): Promise<string | null> {
  const noTools = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite', 'mcp__brain', 'mcp__kanban'];
  const child = spawn(CLAUDE_BIN, ['-p', HANDOVER, ...base, '--disallowedTools', ...noTools], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(conversationId, { child, roleId });
  let out = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  await new Promise((res) => child.on('close', res).on('error', res));
  running.delete(conversationId);
  let final: any = null;
  for (const line of out.split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'result') final = ev;
    } catch {
      /* partial line */
    }
  }
  if (final) recordUsage(getBus().db(), { role: roleId, conversation: conversationId, model: 'handover', effort: null, usage: final.usage, cost: final.total_cost_usd, turns: final.num_turns });
  const text = typeof final?.result === 'string' ? final.result.trim() : '';
  return final && !final.is_error && text ? text.slice(0, 8000) : null;
}

// ── usage per run: tokens, cache reads, cost ─────────────────────

defineSchema(`
CREATE TABLE IF NOT EXISTS agent_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  model           TEXT,
  effort          TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,  -- read at full price
  cache_write     INTEGER NOT NULL DEFAULT 0,  -- written to the cache (a bit above full price)
  cache_read      INTEGER NOT NULL DEFAULT 0,  -- read from the cache (about a tenth of the price)
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL,
  turns           INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_usage_at ON agent_usage (created_at);
`);

export function recordUsage(db: import('../core/db.js').DB, r: { role: string; conversation: string; model: string; effort: string | null; usage: any; cost: number | null | undefined; turns: number | null | undefined }): void {
  const u = r.usage ?? {};
  db.prepare('INSERT INTO agent_usage (role_id, conversation_id, model, effort, input_tokens, cache_write, cache_read, output_tokens, cost_usd, turns, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    r.role, r.conversation, r.model, r.effort, u.input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.output_tokens ?? 0, r.cost ?? null, r.turns ?? null, Date.now(),
  );
}

/** Per role since `since`: runs, tokens read, how much of it came from the cache, output, cost. */
export function usageByRole(db: import('../core/db.js').DB, since: number) {
  return (
    db
      .prepare(
        `SELECT role_id, COUNT(*) AS runs, SUM(input_tokens) AS input, SUM(cache_write) AS cache_write, SUM(cache_read) AS cache_read, SUM(output_tokens) AS output, SUM(cost_usd) AS cost
         FROM agent_usage WHERE created_at >= ? GROUP BY role_id ORDER BY SUM(input_tokens + cache_write + cache_read) DESC`,
      )
      .all(since) as { role_id: string; runs: number; input: number; cache_write: number; cache_read: number; output: number; cost: number | null }[]
  ).map((r) => {
    const read = r.input + r.cache_write + r.cache_read;
    return { ...r, read, cacheHit: read ? Math.round((r.cache_read / read) * 100) : null };
  });
}

/** The time, for the top of each turn's message (kept out of the system prompt so it stays cacheable). */
const stamp = () => new Date().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

/** What this role has not yet seen in the conversation, as a prompt. */
function pendingPrompt(role: Role, conversationId: string, seen: number): { prompt: string; lastId: number } | null {
  const db = getBus().db();
  const conv = getConversation(db, conversationId)!;
  const roles = listRoles(db);
  const fresh = listMessages(db, conversationId, 100).filter((m) => m.id > seen && m.author !== role.id && m.kind === 'text');
  if (!fresh.length) return null;
  const lastId = fresh[fresh.length - 1].id;
  if (conv.kind === 'dm') return { prompt: `[${stamp()}]\n${fresh.map((m) => m.body).join('\n\n')}`, lastId };
  const transcript = fresh.map((m) => `${roleName(m.author, roles)}: ${m.body}`).join('\n\n');
  return {
    prompt: `[${stamp()}] New messages in #${conv.name}:\n\n${transcript}\n\nReply as ${role.name} if you have something useful to add from your role. If not, reply with exactly PASS.`,
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
      env: { BRAIN_DAEMON_URL: getBus().daemonUrl, BRAIN_ROLE: roleId, BRAIN_CONVERSATION: conversationId, BRAIN_DISABLED_TOOLS: disabledTools(getBus().db(), getConversation(getBus().db(), conversationId)?.project_id ?? null).join(',') },
    },
  };
  // project roles drive the kanban board (phases, cards, worktrees)
  if (withBoard) servers.kanban = { command: process.execPath, args: ['--import', TSX_LOADER, KANKAN_MCP], env: { DAEMON_URL: getBus().daemonUrl } };
  writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

/** A `brain` command on the agents' PATH (the board protocol runs `brain worktree …`). */
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
async function runTurn(roleId: string, conversationId: string, modelOverride?: string, resumeNote?: string, effortOverride?: string): Promise<string | null> {
  try {
    return await runTurnInner(roleId, conversationId, modelOverride, resumeNote, effortOverride);
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

async function runTurnInner(roleId: string, conversationId: string, modelOverride?: string, resumeNote?: string, effortOverride?: string): Promise<string | null> {
  const db = getBus().db();
  const role = getRole(db, roleId);
  const ws = currentWorkspace();
  if (!role) return null;
  if (!ws) {
    emitMessage(addMessage(db, conversationId, roleId, 'Set up a workspace folder first: agents only run inside it.', 'error'));
    return null;
  }
  let session = getSession(db, roleId, conversationId);
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
  const model = modelOverride ?? role.model;
  const effort = effortOverride ?? effectiveEffort(role);
  const base = [
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--append-system-prompt', systemPrompt(role, conversationId),
    '--mcp-config', mcpConfig(roleId, conversationId, ws.data, projectRole),
    '--permission-prompt-tool', 'mcp__brain__approve',
  ];
  const sk = agentSkills(role, conv.project_id, conv.idea_id);
  const plugin = pluginDir(ws.data, [...sk.own, ...sk.builder, ...sk.reviewer]);
  if (plugin) base.push('--plugin-dir', plugin);
  const env = {
    ...process.env,
    PATH: `${shimDir(ws.data)}:${process.env.PATH ?? ''}`,
    DAEMON_URL: getBus().daemonUrl,
    BRAIN_WORKSPACE: ws.root,
    MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000),
  };

  // A long session gets a fresh start: the old one writes a handover note,
  // which opens the new one. Limits are generous; today's windows are large.
  let prompt = pending.prompt;
  const limits = sessionLimits(db);
  if (session && !resumeNote && (session.turns >= limits.maxTurns || session.context_tokens >= limits.maxContextTokens)) {
    emitStatus(conversationId, roleId, 'working');
    const note = await handoverNote([...base, '--resume', session.session_id], cwd, env, roleId, conversationId);
    if (note) {
      prompt = `Handover from your previous session in this conversation (it had grown long, so you start fresh with this summary):\n\n${note}\n\n---\n\n${pending.prompt}`;
      emitMessage(addMessage(db, conversationId, roleId, `Started a fresh session after ${session.turns} turns, with a handover summary.`, 'tool', { name: 'session_refresh', input: { turns: session.turns, context_tokens: session.context_tokens } }));
      session = { ...session, session_id: '', fresh: true } as typeof session;
    }
  }

  // restarted by the user: a fresh session, opened with a short recap of what was said before
  if (session && !session.session_id && !resumeNote && !(session as { fresh?: boolean }).fresh) {
    const before = listMessages(db, conversationId, 60).filter((m) => m.kind === 'text' && m.id <= session!.seen_message_id).slice(-20);
    if (before.length) {
      const roles = listRoles(db);
      const recap = before.map((m) => `${m.author === 'user' ? 'User' : roleName(m.author, roles)}: ${m.body.length > 600 ? `${m.body.slice(0, 600)}…` : m.body}`).join('\n\n');
      prompt = `The user restarted your session in this conversation, so you start fresh. The recent conversation, for context (already answered):\n\n${recap}\n\n---\n\n${prompt}`;
    }
  }

  const args = ['-p', prompt, ...base, '--include-partial-messages', '--allowedTools', ...allowed];
  if (denied.length) args.push('--disallowedTools', ...denied);
  if (session?.session_id) args.push('--resume', session.session_id);

  emitStatus(conversationId, roleId, 'working');
  const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(conversationId, { child, roleId });
  markRun(conversationId, roleId, session?.session_id || null, modelOverride ?? null, pending.lastId);

  let sessionId = session?.session_id || null;
  let lastCall: any = null; // usage of the latest model call: how big the context is now
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
      if (ev.message?.usage) lastCall = ev.message.usage;
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
  if (sessionId) {
    saveSession(db2, roleId, conversationId, sessionId, pending.lastId);
    const ctx = lastCall ? (lastCall.input_tokens ?? 0) + (lastCall.cache_read_input_tokens ?? 0) + (lastCall.cache_creation_input_tokens ?? 0) : 0;
    countTurn(db2, roleId, conversationId, ctx);
  }
  if (final) recordUsage(db2, { role: roleId, conversation: conversationId, model, effort, usage: final.usage, cost: final.total_cost_usd, turns: final.num_turns });
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

/** Queue the conversation's members to answer (who answers: see below). */
export function respond(conversationId: string, mentionText = '', opts: { model?: string; effort?: string; onDone?: () => void } = {}): void {
  const db = getBus().db();
  const conv = getConversation(db, conversationId);
  if (!conv) return;
  // A DM's role answers. In a channel only @mentioned members answer; with no
  // mention, its first member (the lead) does and brings others in by @mention.
  // Everyone answering every message multiplied the tokens for little gain.
  let who: string[] = conv.kind === 'dm' ? [conv.role_id!] : [replyTarget(conversationId)].filter((x): x is string => Boolean(x));
  if (conv.kind === 'channel') {
    const mentioned = mentionedMembers(conversationId, mentionText);
    if (mentioned.length) who = mentioned;
  }
  const maxHandoffs = conv.idea_id ? 6 : MAX_HANDOFFS;
  const prev = queues.get(conversationId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      // In a channel, a reply that @mentions a teammate hands over to them,
      // up to MAX_HANDOFFS extra turns per user message (no endless ping-pong).
      const queue = [...who];
      let handoffs = 0;
      while (queue.length) {
        const roleId = queue.shift()!;
        const posted = await runTurn(roleId, conversationId, opts.model, undefined, opts.effort);
        if (conv.kind !== 'channel' || !posted) continue;
        for (const next of mentionedMembers(conversationId, posted, [roleId, ...queue])) {
          if (handoffs >= maxHandoffs) break;
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

/**
 * Who answers an un-mentioned message in a channel: the member whose latest
 * message asked the user a question (the user is answering them), else the
 * lead (the first member).
 */
export function replyTarget(conversationId: string): string | undefined {
  const db = getBus().db();
  const ids = members(db, conversationId);
  const recent = listMessages(db, conversationId, 30).filter((m) => m.kind === 'text');
  // the agent message just before the user's latest one(s)
  let i = recent.length - 1;
  while (i >= 0 && recent[i].author === 'user') i--;
  const last = recent[i];
  if (last && last.author !== ids[0] && ids.includes(last.author) && /\?\s*$/.test(last.body.trim().split('\n').filter(Boolean).pop() ?? '')) return last.author;
  return ids[0];
}
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
