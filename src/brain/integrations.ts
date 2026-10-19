// Integrations (D13): MCP servers known to the Claude CLI, which roles may
// use each one, the tools agents have used so far, and a policy per tool.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DB } from '../core/db.js';
import { defineSchema } from './schema.js';
import { getSetting, putSetting } from './settings.js';

const execFileAsync = promisify(execFile);
const CLAUDE_BIN = process.env.BRAIN_CLAUDE_BIN ?? 'claude';

defineSchema(`
CREATE TABLE IF NOT EXISTS role_servers (
  role_id TEXT NOT NULL,
  server  TEXT NOT NULL,          -- tool prefix, e.g. mcp__claude_ai_Gmail
  allowed INTEGER NOT NULL,
  PRIMARY KEY (role_id, server)
);
CREATE TABLE IF NOT EXISTS tool_policies (
  tool   TEXT PRIMARY KEY,        -- full tool name or server prefix
  policy TEXT NOT NULL            -- allow|deny
);
`);

export interface Server {
  name: string;
  prefix: string;
  url: string;
  status: 'connected' | 'needs_auth' | 'failed' | 'not_configured' | 'built_in';
  detail: string;
  /** account: a claude.ai connector on the user's Claude account; plugin: ships with a Claude Code plugin; added: set up with `claude mcp add` */
  source: 'built_in' | 'account' | 'plugin' | 'added';
}

/** The tool-name prefix Claude Code gives a server's tools. */
export const prefixOf = (name: string) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;

const BUILT_IN: Server[] = [
  { name: 'brain', prefix: 'mcp__brain', url: 'built in', status: 'built_in', source: 'built_in', detail: 'Drydock itself: approvals, decisions, projects, requirements, design, personal data' },
  { name: 'kanban', prefix: 'mcp__kanban', url: 'built in', status: 'built_in', source: 'built_in', detail: 'The board: phases, cards, worktrees (project roles)' },
];

/** Which roles may use a server when nobody has said otherwise. */
const DEFAULT_ACCESS: Record<string, RegExp> = {
  main: /./,
  cfo: /Gmail|Drive/i,
  marketing: /Drive|Canva|Figma|HubSpot|Notion|Ahrefs|Similarweb|Klaviyo|Supermetrics|Amplitude/i,
  social: /Calendar|Canva|Drive/i,
  cto: /Drive|Figma|Notion/i,
  qc: /Drive/i,
};

let cache: { at: number; servers: Server[] } | null = null;
let inflight: Promise<Server[]> | null = null;

export function parseMcpList(out: string): Server[] {
  const servers: Server[] = [];
  for (const line of out.split('\n')) {
    const m = /^(.+?):\s(.*?)\s-\s(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, name, url, rest] = m;
    const status = /Connected/i.test(rest) ? 'connected' : /Needs authentication/i.test(rest) ? 'needs_auth' : /Not configured/i.test(rest) ? 'not_configured' : 'failed';
    const source = name.startsWith('claude.ai ') ? 'account' : name.startsWith('plugin:') ? 'plugin' : 'added';
    servers.push({ name, prefix: prefixOf(name), url: url.replace(/\s*\(HTTP\)$/, ''), status, detail: rest.replace(/^[✔✘!-]\s*/, ''), source });
  }
  return servers;
}

/** `claude mcp list` (slow: it health-checks every server), cached for 10 minutes. */
export async function listServers(force = false): Promise<Server[]> {
  if (!force && cache && Date.now() - cache.at < 600_000) return cache.servers;
  if (!inflight)
    inflight = execFileAsync(CLAUDE_BIN, ['mcp', 'list'], { timeout: 90_000, maxBuffer: 1_000_000 })
      .then(({ stdout }) => {
        // a project's own .mcp.json may list the board server too: it is still the built-in one
        cache = { at: Date.now(), servers: [...BUILT_IN, ...parseMcpList(stdout).filter((s) => !BUILT_IN.some((b) => b.prefix === s.prefix))] };
        return cache.servers;
      })
      .catch(() => cache?.servers ?? BUILT_IN)
      .finally(() => (inflight = null));
  return inflight;
}

// ── setting servers up from the app (each runs the claude CLI as the user would) ──

export const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** Add a server for every project (user scope): a web address, or a command that starts it. */
export async function addServer(input: { name: string; url?: string; command?: string }): Promise<void> {
  const name = input.name.trim();
  if (!SERVER_NAME_RE.test(name)) throw new Error('Use letters, numbers, - or _ for the name (up to 40)');
  if (cachedServers().some((s) => s.name === name)) throw new Error(`There is already a server called ${name}`);
  let args: string[];
  if (input.url) {
    const url = input.url.trim();
    if (!/^https?:\/\/\S+$/.test(url)) throw new Error('The address must start with https://');
    args = ['mcp', 'add', '--scope', 'user', '--transport', 'http', name, url];
  } else {
    const parts = (input.command ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) throw new Error('Enter an address or a command');
    args = ['mcp', 'add', '--scope', 'user', name, '--', ...parts];
  }
  await execFileAsync(CLAUDE_BIN, args, { timeout: 30_000 });
  cache = null;
}

/** Only servers added with `claude mcp add` can be removed here. */
export async function removeServer(name: string): Promise<void> {
  const s = cachedServers().find((x) => x.name === name);
  if (!s || s.source !== 'added') throw new Error('Only servers you added can be removed here');
  await execFileAsync(CLAUDE_BIN, ['mcp', 'remove', name], { timeout: 30_000 });
  cache = null;
}

/** Opens the server's sign-in page in the browser and waits (up to 5 minutes) for the user to finish. */
export async function signIn(name: string): Promise<void> {
  if (!cachedServers().some((x) => x.name === name && x.source !== 'built_in')) throw new Error('Unknown server');
  try {
    await execFileAsync(CLAUDE_BIN, ['mcp', 'login', name], { timeout: 300_000 });
  } finally {
    cache = null;
  }
}

export async function signOut(name: string): Promise<void> {
  if (!cachedServers().some((x) => x.name === name && x.source !== 'built_in')) throw new Error('Unknown server');
  await execFileAsync(CLAUDE_BIN, ['mcp', 'logout', name], { timeout: 30_000 });
  cache = null;
}

export const cachedServers = (): Server[] => cache?.servers ?? BUILT_IN;

export function serverAllowed(db: DB, roleId: string, server: Server): boolean {
  if (server.status === 'built_in') return true;
  const row = db.prepare('SELECT allowed FROM role_servers WHERE role_id = ? AND server = ?').get(roleId, server.prefix) as { allowed: number } | undefined;
  if (row) return Boolean(row.allowed);
  return DEFAULT_ACCESS[roleId]?.test(server.name) ?? false;
}

export function setServerAccess(db: DB, roleId: string, prefix: string, allowed: boolean): void {
  db.prepare('INSERT INTO role_servers (role_id, server, allowed) VALUES (?, ?, ?) ON CONFLICT(role_id, server) DO UPDATE SET allowed = excluded.allowed').run(roleId, prefix, allowed ? 1 : 0);
}

/** Server prefixes a role must not use (passed to claude as --disallowedTools). */
export function blockedServers(db: DB, roleId: string): string[] {
  return cachedServers()
    .filter((s) => s.status !== 'built_in' && !serverAllowed(db, roleId, s))
    .map((s) => s.prefix);
}

// ── tools seen and per-tool policies ──

export function recordTools(db: DB, names: string[]): void {
  const seen = getSetting<Record<string, string[]>>(db, 'brain.tools_seen', {});
  let changed = false;
  for (const n of names) {
    if (!n.startsWith('mcp__') || n.startsWith('mcp__brain__') || n.startsWith('mcp__kanban__')) continue;
    const prefix = n.split('__').slice(0, 2).join('__');
    const list = (seen[prefix] ??= []);
    if (!list.includes(n)) {
      list.push(n);
      changed = true;
    }
  }
  if (changed) putSetting(db, 'brain.tools_seen', seen);
}

export const toolsSeen = (db: DB) => getSetting<Record<string, string[]>>(db, 'brain.tools_seen', {});

export function toolPolicies(db: DB): Record<string, 'allow' | 'deny'> {
  return Object.fromEntries((db.prepare('SELECT tool, policy FROM tool_policies').all() as { tool: string; policy: 'allow' | 'deny' }[]).map((r) => [r.tool, r.policy]));
}

export function setToolPolicy(db: DB, tool: string, policy: 'allow' | 'deny' | 'ask'): void {
  if (policy === 'ask') db.prepare('DELETE FROM tool_policies WHERE tool = ?').run(tool);
  else db.prepare('INSERT INTO tool_policies (tool, policy) VALUES (?, ?) ON CONFLICT(tool) DO UPDATE SET policy = excluded.policy').run(tool, policy);
}
