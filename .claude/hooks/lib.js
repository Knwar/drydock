// Shared helpers for the board hooks. Hooks are best-effort: daemon down
// or fields missing must never break the session — degrade to exit 0.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAEMON = process.env.DAEMON_URL ?? 'http://localhost:7900';

/** The daemon token: an agent run's own (DAEMON_TOKEN), else the user's local token file. */
function daemonToken() {
  if (process.env.DAEMON_TOKEN) return process.env.DAEMON_TOKEN;
  const home = process.env.BRAIN_HOME ?? (existsSync(join(homedir(), '.ai-brain')) && !existsSync(join(homedir(), '.drydock')) ? join(homedir(), '.ai-brain') : join(homedir(), '.drydock'));
  try {
    return readFileSync(join(home, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function api(method, path, body) {
  try {
    const res = await fetch(`${DAEMON}${path}`, {
      method,
      headers: { authorization: `Bearer ${daemonToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * The one project resolver for every hook → { id, name } or null.
 * A KANKAN_PROJECT_ID env binding wins when the daemon knows it (several
 * sessions can share one cwd); an unknown id or a down daemon falls back to
 * the cwd lookup. create=0: hooks must never create a project — only the
 * orchestrator / `brain init` do.
 */
export async function resolveProject(cwd) {
  const envId = process.env.KANKAN_PROJECT_ID;
  if (envId) {
    const view = await api('GET', `/workspace?project=${encodeURIComponent(envId)}`);
    const match = view && [view.workspace, ...(view.verticals ?? [])].find((p) => p?.id === envId);
    if (match) return { id: match.id, name: match.name };
  }
  const project = await api('GET', `/project?root=${encodeURIComponent(String(cwd ?? ''))}&create=0`);
  return project?.project_id ? { id: project.project_id, name: project.name } : null;
}

export async function projectIdFor(cwd) {
  return (await resolveProject(cwd))?.id ?? null;
}

/**
 * Resolve { projectId, cardId } for a cwd, mapping a brain worktree back to
 * its parent project. Inside .../.trees/<id>/... the card is <id> and (absent
 * an env binding) the project is the parent repo; otherwise the project owns
 * the cwd directly. Never creates a project — so builder activity surfaces on
 * the real board.
 */
export async function contextFor(cwd) {
  const m = String(cwd ?? '').match(/^(.*?)\/\.trees\/([^/]+)/);
  const root = m ? m[1] : String(cwd ?? '');
  const cardId = m ? m[2] : null;
  return { projectId: await projectIdFor(root), cardId };
}

/** Worktree path is the agent↔card correlation key: .trees/<id> → <id>. */
export function cardIdFrom(text) {
  const matches = String(text ?? '').match(/\.trees\/([A-Za-z0-9_-]+)/g);
  if (!matches) return null;
  return matches[matches.length - 1].slice('.trees/'.length); // most recent mention
}

function expand(p) {
  return p?.startsWith('~') ? homedir() + p.slice(1) : p;
}

function scanFile(path, fromEnd = 0) {
  try {
    const p = expand(path);
    if (!p || !existsSync(p)) return null;
    const text = readFileSync(p, 'utf8');
    return cardIdFrom(fromEnd ? text.slice(-fromEnd) : text);
  } catch {
    return null;
  }
}

/** Derive the card id from a Subagent{Start,Stop} event. */
export function cardIdFromEvent(data) {
  // 1) anywhere in the event payload itself
  const direct = cardIdFrom(JSON.stringify(data));
  if (direct) return direct;
  // 2) the subagent transcript — it contains the dispatch prompt
  const candidates = [data.agent_transcript_path];
  if (data.transcript_path && data.agent_id) {
    candidates.push(
      String(data.transcript_path).replace(/\.jsonl$/, `/subagents/agent-${data.agent_id}.jsonl`),
    );
  }
  for (const candidate of candidates) {
    const id = scanFile(candidate);
    if (id) return id;
  }
  // 3) tail of the main transcript (most recent dispatch wins)
  return scanFile(data.transcript_path, 64 * 1024);
}

/** Path to a subagent's own transcript, if resolvable. */
export function subagentTranscriptPath(data) {
  const candidates = [data.agent_transcript_path];
  if (data.transcript_path && data.agent_id) {
    candidates.push(String(data.transcript_path).replace(/\.jsonl$/, `/subagents/agent-${data.agent_id}.jsonl`));
  }
  for (const c of candidates) {
    const p = expand(c);
    if (p && existsSync(p)) return p;
  }
  return null;
}

/**
 * Per-model token breakdown of a transcript's assistant messages:
 * { "<model>": { input, output, cache_read, cache_creation } }.
 * A message is logged as several lines under one message.id (one per content
 * block), each repeating its usage: count each message once. Input and cache
 * counts are the same on every line; output_tokens is a streaming snapshot
 * unless the line carries a stop_reason, which has the final usage. So per
 * message: the stop_reason line's usage when there is one, else the max of
 * each field. Messages logged without a stop_reason line still UNDERCOUNT
 * output (the API reports this as a caveat). No final per-type figure exists
 * elsewhere: the SubagentStop payload carries no usage, and the completion
 * notification only has a single subagent_tokens total.
 * Models with no tokens at all (e.g. "<synthetic>") are dropped.
 */
export function usageByModel(file) {
  const byMessage = new Map();
  let anon = 0;
  for (const line of readFileSync(expand(file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line)?.message;
    } catch {
      continue;
    }
    if (!m?.usage) continue;
    const u = {
      input: m.usage.input_tokens || 0,
      output: m.usage.output_tokens || 0,
      cache_read: m.usage.cache_read_input_tokens || 0,
      cache_creation: m.usage.cache_creation_input_tokens || 0,
    };
    const key = m.id ?? `line-${anon++}`;
    const prev = byMessage.get(key);
    if (!prev || (!prev.final && m.stop_reason)) {
      byMessage.set(key, { model: m.model || 'unknown', u, final: !!m.stop_reason });
    } else if (!prev.final) {
      for (const k of Object.keys(u)) prev.u[k] = Math.max(prev.u[k], u[k]);
    }
  }
  const usage = {};
  for (const { model, u } of byMessage.values()) {
    const acc = (usage[model] ??= { input: 0, output: 0, cache_read: 0, cache_creation: 0 });
    for (const k of Object.keys(acc)) acc[k] += u[k];
  }
  for (const [model, u] of Object.entries(usage)) {
    if (!(u.input + u.output + u.cache_read + u.cache_creation)) delete usage[model];
  }
  return usage;
}

/** Billable tokens (total + output) and the per-model breakdown they sum from. */
export function sumTokens(file) {
  try {
    const usage = usageByModel(file);
    let tokens = 0;
    let out = 0;
    for (const u of Object.values(usage)) {
      tokens += u.input + u.output + u.cache_read + u.cache_creation;
      out += u.output;
    }
    return { tokens, tokens_out: out, usage };
  } catch {
    return { tokens: 0, tokens_out: 0, usage: {} };
  }
}
