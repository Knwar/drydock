// Shared helpers for kankan hooks. Hooks are best-effort: daemon down
// or fields missing must never break the session — degrade to exit 0.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const DAEMON = process.env.DAEMON_URL ?? 'http://localhost:7890';

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
 * orchestrator / `kankan init` do.
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
 * Resolve { projectId, cardId } for a cwd, mapping a kankan worktree back to
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

/** Sum billable tokens (total + output) across a transcript's assistant messages. */
export function sumTokens(file) {
  try {
    let tokens = 0;
    let out = 0;
    for (const line of readFileSync(expand(file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let u;
      try {
        u = JSON.parse(line)?.message?.usage;
      } catch {
        continue;
      }
      if (!u) continue;
      tokens +=
        (u.input_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.output_tokens || 0);
      out += u.output_tokens || 0;
    }
    return { tokens, tokens_out: out };
  } catch {
    return { tokens: 0, tokens_out: 0 };
  }
}
