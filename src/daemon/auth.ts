// Who is calling, and what each caller may do. Every request passes the
// request gate first (request-gate.ts); this decides the rest.
//
// Callers:
// - user:  the web app, by an HttpOnly SameSite=Strict session cookie it gets
//          from /api/session (only a same-origin browser request is handed one);
// - local: the CLI, hooks and the user's own Claude Code sessions, by the token
//          in <brain home>/token (readable by the user only; agents are denied it);
// - agent: one agent run, by a token minted for that run and given only to its
//          processes. It carries the role, conversation and project, so an agent
//          can't speak as the user or as another member;
// - none:  everything else (an app an agent built, any other local program).
//
// Route levels: public (the app's pages, the handshake), hook (what the board
// hooks report; old project kits send no token yet), agent (exactly what the
// agents' tool servers use), user (everything else: deciding approvals,
// permissions, integrations, secret settings, the workspace, roles, skills…).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

export type Principal =
  | { kind: 'user' }
  | { kind: 'local' }
  | { kind: 'agent'; role: string; conversation: string | null; project: string | null }
  | { kind: 'none' };

export type Level = 'public' | 'hook' | 'agent' | 'user';

export const SESSION_COOKIE = 'drydock_session';

/** A secret kept in a file only the user can read; made once and reused (several daemons may share a home). */
function secretFile(path: string): string {
  if (existsSync(path)) {
    const v = readFileSync(path, 'utf8').trim();
    if (v.length >= 32) return v;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  const v = randomBytes(32).toString('base64url');
  writeFileSync(path, v + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return v;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Auth {
  readonly localToken: string;
  readonly sessionKey: string;
  private agents = new Map<string, { role: string; conversation: string | null; project: string | null }>();

  /** `home` is the brain home (~/.drydock). DRYDOCK_TOKEN overrides the local token (tests). */
  constructor(home: string, env: NodeJS.ProcessEnv = process.env) {
    this.localToken = env.DRYDOCK_TOKEN || secretFile(join(home, 'token'));
    this.sessionKey = env.DRYDOCK_TOKEN ? `${env.DRYDOCK_TOKEN}-session` : secretFile(join(home, 'session.key'));
  }

  /** A token for one agent run; revoke it when the run ends. */
  mintAgent(info: { role: string; conversation: string | null; project: string | null }): string {
    const t = `agt_${randomBytes(24).toString('base64url')}`;
    this.agents.set(t, info);
    return t;
  }

  revoke(token: string): void {
    this.agents.delete(token);
  }

  resolve(req: IncomingMessage): Principal {
    const header = String(req.headers.authorization ?? '');
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (bearer) {
      const a = this.agents.get(bearer);
      if (a) return { kind: 'agent', ...a };
      if (same(bearer, this.localToken)) return { kind: 'local' };
      return { kind: 'none' };
    }
    const cookie = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (cookie && same(cookie, this.sessionKey)) return { kind: 'user' };
    return { kind: 'none' };
  }

  /** The cookie the web app gets from /api/session. */
  sessionCookie(): string {
    return `${SESSION_COOKIE}=${this.sessionKey}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  }
}

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** May this caller use a route at this level? `loopback`: the connection comes from this machine. */
export function allowed(level: Level, p: Principal, loopback = true): boolean {
  if (level === 'public') return true;
  // old project kits send no token yet; these routes only report activity, and only from this machine
  if (level === 'hook') return p.kind !== 'none' || loopback;
  if (level === 'agent') return p.kind !== 'none';
  return p.kind === 'user' || p.kind === 'local';
}

// ── the route table ──────────────────────────────────────────────────
// ":x" matches one path segment, a trailing "*" anything below.

/** What the agents' tool servers (src/brain/mcp.ts, src/mcp/server.ts) and the `brain` shim call. */
const AGENT_ROUTES = `
GET /api/approvals/:x/wait
POST /api/approvals
GET /api/brands
POST /api/change-requests
POST /api/daily/publish
GET /api/decisions/recent
POST /api/decisions
POST /api/delegate
GET /api/ideas
POST /api/ideas
GET /api/ideas/:x
POST /api/ideas/:x/brand
POST /api/ideas/:x/brand/use
POST /api/ideas/:x/features
DELETE /api/ideas/:x/features/:x
POST /api/ideas/:x/offers
POST /api/ideas/:x/questions
POST /api/ideas/:x/questions/:x/answer
POST /api/ideas/:x/screens
DELETE /api/ideas/:x/screens/:x
POST /api/ideas/:x/sections
GET /api/learnings
GET /api/local-services/names
POST /api/notes
GET /api/personal
POST /api/personal/calendar
POST /api/personal/inbox
POST /api/personal/money
GET /api/projects
POST /api/projects
POST /api/projects/:x/auto/build
POST /api/projects/:x/complete
GET /api/projects/:x/design
POST /api/projects/:x/design/done
POST /api/projects/:x/design/elements
POST /api/projects/:x/design/relations
DELETE /api/projects/:x/design/:x
POST /api/projects/:x/enhancements
POST /api/projects/:x/ideas
POST /api/projects/:x/lessons
GET /api/projects/:x/live
POST /api/projects/:x/live/check
GET /api/projects/:x/live/logs
POST /api/projects/:x/live/recipe
POST /api/projects/:x/live/start
POST /api/projects/:x/rag
GET /api/projects/:x/requirements
POST /api/projects/:x/requirements
POST /api/projects/:x/team/recommendation
POST /api/projects/:x/threat-model
POST /api/reminders
POST /api/role-proposals
GET /api/role-templates
GET /api/roles
POST /api/secrets
GET /api/secrets/names
POST /api/secrets/request
POST /api/secrets/rotate-request
POST /api/secrets/run
POST /api/secrets/tickets/:x/execute
GET /api/threads/:x
GET /api/workspace
DELETE /subscriptions/:x
GET /subscriptions/:x
PATCH /subscriptions/:x
POST /subscriptions
DELETE /task/:x
PATCH /task/:x
POST /task
POST /task/:x/block
POST /task/:x/check
POST /task/:x/redirect
POST /task/:x/review
POST /task/:x/unblock
GET /team
GET /next
GET /phase/next
GET /phases
POST /phase
POST /phase/advance
POST /phase/:x
PUT /phase/:x/target
GET /decisions
POST /decisions
POST /decisions/:x/supersede
GET /metrics/agentic-cost
GET /metrics/agentic
GET /metrics/cost
GET /metrics/forecast
GET /metrics/schedule
GET /metrics/summary
GET /metrics/wait
GET /plan-drafts
POST /plan-drafts
GET /plan-drafts/:x
PATCH /plan-drafts/:x
GET /plan-drafts/:x/diff
POST /plan-drafts/:x/commit
POST /plan-drafts/:x/run
GET /project
GET /project/:x/vertical-suggestions
POST /project/:x/autopilot
POST /project/:x/split
POST /project/:x/split-preview
GET /report
GET /report.md
GET /risks
POST /risks
PATCH /risks/:x
GET /stats
GET /verticals
POST /vertical
POST /verticals/merge
GET /workspace/summary
`;

/** What the board hooks report (.claude/hooks); also reachable with no token for old project kits. */
const HOOK_ROUTES = `
POST /event
POST /status
POST /task/:x/activity
POST /task/:x/move
GET /active
GET /board
GET /workspace
`;

/** No caller needed: the app's own pages and the session handshake. */
const PUBLIC_ROUTES = `
GET /api/session
GET /app
GET /app/*
GET /
GET /favicon.ico
`;

type Rule = { method: string; re: RegExp };
const compile = (table: string): Rule[] =>
  table
    .trim()
    .split('\n')
    .map((l) => {
      const [method, path] = l.trim().split(/\s+/);
      const body = path.replace(/[.]/g, '\\.').replace(/\/\*$/, '(?:/.*)?').replace(/:x/g, '[^/]+');
      return { method, re: new RegExp(`^${body}$`) };
    });
const AGENT = compile(AGENT_ROUTES);
const HOOK = compile(HOOK_ROUTES);
const PUBLIC = compile(PUBLIC_ROUTES);
const hit = (rules: Rule[], method: string, path: string) => rules.some((r) => (r.method === method || (r.method === 'GET' && method === 'HEAD')) && r.re.test(path));

/** The level a request needs. Anything not listed is the user's. */
export function levelOf(method: string, path: string, search: URLSearchParams): Level {
  if (method === 'OPTIONS') return 'public';
  if (hit(PUBLIC, method, path)) return 'public';
  // the board overlay's own files (served from the top level)
  if ((method === 'GET' || method === 'HEAD') && /^\/[\w.-]+\.(?:js|css|html|svg|png|ico|woff2|map)$/.test(path)) return 'public';
  // the hooks look a project up by folder and must never create one
  if (method === 'GET' && path === '/project' && search.get('create') === '0') return 'hook';
  if (hit(HOOK, method, path)) return 'hook';
  if (hit(AGENT, method, path)) return 'agent';
  return 'user';
}

/** An agent's request speaks only as itself: who it is comes from its token, never from the body. */
export function asAgent(body: any, p: Extract<Principal, { kind: 'agent' }>): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const b = { ...body };
  for (const k of ['role', 'author', 'from']) if (k in b) b[k] = p.role;
  if ('by' in b) b.by = 'agent';
  if (p.conversation && 'conversation' in b) b.conversation = p.conversation;
  return b;
}
