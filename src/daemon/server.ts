import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import * as board from '../core/board.js';
import * as subscriptions from '../core/subscriptions.js';
import { openDb } from '../core/db.js';
import type { Project, Task } from '../core/types.js';
import { Broadcaster } from './broadcast.js';
import { Dispatcher } from './dispatcher.js';
import { sessionCwd, sessionEnv } from './pty-env.js';
import { SessionStates } from './session-state.js';

const PORT = Number(process.env.PORT ?? 7890);
// Bind loopback by DEFAULT so the daemon (incl. the unauthenticated overlay
// routes) is not reachable from the LAN. Exposing it is an explicit opt-in:
// set HOST=0.0.0.0 (all interfaces) or a specific IP.
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), 'data', 'board.db');
const OVERLAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'overlay');
const INIT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'init-project.sh');

const db = openDb(DB_PATH);
const broadcaster = new Broadcaster();
// live agent session state per project: memory only, never persisted
const states = new SessionStates();

// ── embedded terminal (opt-in via KANKAN_TERMINAL=1) ────────────────
// node-pty is an OPTIONAL native dep: the board runs fine without it, and a
// failed compile just leaves the terminal off. A per-start token (handed only
// to same-origin overlay loads via /config) gates every /pty connection.
type PtySpawn = (file: string, args: string[], opts: Record<string, unknown>) => any;
let ptySpawn: PtySpawn | null = null;
let terminalToken: string | null = null;
if (process.env.KANKAN_TERMINAL === '1') {
  try {
    const mod: any = await import('node-pty');
    ptySpawn = (mod.spawn ?? mod.default?.spawn) as PtySpawn;
    terminalToken = randomBytes(24).toString('hex');
  } catch (err) {
    console.warn(`KANKAN_TERMINAL set but node-pty is unavailable — terminal disabled (${(err as Error).message})`);
  }
}
const terminalReady = (): boolean => ptySpawn !== null && terminalToken !== null;

interface PtySession { proc: any; buffer: string; clients: Set<WebSocket>; agentLaunch?: Promise<unknown> }
const PTY_BUFFER_CAP = 200_000; // scrollback replayed to (re)attaching clients
const ptySessions = new Map<string, PtySession>();

/** One persistent shell per project, cwd'd at its git toplevel with
 *  KANKAN_PROJECT_ID bound; survives page reloads. */
function getPtySession(projectId: string, root: string): PtySession {
  const existing = ptySessions.get(projectId);
  if (existing) return existing;
  const shell = process.env.SHELL ?? '/bin/bash';
  const proc = ptySpawn!(shell, [], {
    name: 'xterm-256color',
    cwd: sessionCwd(root),
    env: sessionEnv(process.env, projectId, `http://localhost:${PORT}`),
    cols: 80,
    rows: 24,
  });
  const session: PtySession = { proc, buffer: '', clients: new Set() };
  ptySessions.set(projectId, session);
  proc.onData((data: string) => {
    session.buffer = (session.buffer + data).slice(-PTY_BUFFER_CAP);
    const frame = JSON.stringify({ t: 'o', d: data });
    for (const ws of session.clients) ws.send(frame);
  });
  proc.onExit(() => {
    for (const ws of session.clients) ws.send(JSON.stringify({ t: 'x' }));
    ptySessions.delete(projectId);
  });
  return session;
}

/** The terminal's foreground process group (0 before the shell has taken the
 *  tty, -1 if unknown). The shell is idle iff this is its own pid. */
async function foregroundPgid(session: PtySession): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'tpgid=', '-p', String(session.proc.pid)]);
    return Number(stdout.trim());
  } catch {
    return -1;
  }
}

/** Type `claude` if the shell is idle, then wait (≤3s) until the typed command
 *  holds the foreground, so a follow-up request sees it as busy instead of
 *  typing it twice. `fresh` = the caller just spawned this shell → idle. */
async function launchAgent(session: PtySession, fresh: boolean) {
  const pid = session.proc.pid;
  if (!fresh && (await foregroundPgid(session)) !== pid) {
    return { started: false, reason: 'busy', foreground: session.proc.process };
  }
  // Ctrl-U first: kill any half-typed input at the prompt, else it would be
  // glued onto the command ("rm -rf build" + "claude" → "rm -rf buildclaude").
  session.proc.write('\x15claude\r');
  for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
    const fg = await foregroundPgid(session);
    if (fg > 0 && fg !== pid) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { started: true };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The addresses Node reports for a connection arriving over the loopback
 *  interface: IPv4, IPv6, and the IPv4-mapped-IPv6 form. */
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True when the request arrived on the loopback interface (same machine). */
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  return addr != null && LOOPBACK_ADDRS.has(addr);
}

/** /pty gate: valid per-start token + a same-machine Origin (or none, for CLIs). */
function authTerminal(req: IncomingMessage, url: URL): boolean {
  if (!terminalReady() || url.searchParams.get('token') !== terminalToken) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Gate for the outbound-webhook routes (/subscriptions*, /deliveries): allow if
 *  the request is loopback (same machine — how the MCP tools + hooks reach the
 *  daemon, over localhost with no token) OR it presents the daemon's per-start
 *  token (the SAME token the terminal uses, served via /config). Anything else
 *  is a non-loopback caller without a valid token → denied. */
function authDaemonRoute(req: IncomingMessage, url: URL): boolean {
  if (isLoopback(req)) return true;
  const token = url.searchParams.get('token') ?? req.headers['x-kankan-token'];
  return terminalToken !== null && token === terminalToken;
}

// ── broadcast plumbing ──────────────────────────────────────────────
// board.ts appends events on every write; the daemon flushes anything
// newer than the last broadcast id out to subscribers after each write.
let lastEventId =
  (db.prepare('SELECT MAX(id) AS max FROM task_events').get() as { max: number | null }).max ?? 0;

function flushEvents(): void {
  const events = db
    .prepare('SELECT * FROM task_events WHERE id > ? ORDER BY id')
    .all(lastEventId) as { id: number; project_id: string }[];
  for (const event of events) {
    broadcaster.send(event.project_id, { type: 'event', event });
    lastEventId = event.id;
  }
}

function toCard(task: Task) {
  return {
    id: task.id,
    title: task.title,
    lane: task.lane,
    tag: task.tag,
    skill: task.skill,
    agent: task.assigned_agent,
    rounds: task.review_rounds,
    updated_at: task.updated_at,
    phase_id: task.phase_id,
    blocked: !!task.blocked_at,
    blocked_reason: task.blocked_reason,
    subs: board.progressOf(task.subtasks),
  };
}

const STARTED_AT = Date.now();

interface LimitWindow { used_percentage: number; resets_at: number }
let usage: { five_hour: LimitWindow | null; seven_day: LimitWindow | null } | null = null;

function projectStats(projectId: string) {
  const rows = db
    .prepare(
      `SELECT r.verdict, COUNT(*) AS n FROM reviews r
       JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ? GROUP BY r.verdict`,
    )
    .all(projectId) as { verdict: string; n: number }[];
  const reviews = { pass: 0, fail: 0 };
  for (const row of rows) reviews[row.verdict as 'pass' | 'fail'] = row.n;
  return { started_at: STARTED_AT, reviews };
}

/** Broadcast a card upsert + any events the write produced. */
function announce(task: Task): void {
  broadcaster.send(task.project_id, { type: 'card', project_id: task.project_id, card: toCard(task) });
  flushEvents();
}

/** Broadcast the phase roadmap after a phase write. */
function announcePhases(projectId: string): void {
  broadcaster.send(projectId, { type: 'phases', project_id: projectId, phases: board.getPhases(db, projectId) });
  flushEvents();
}

function announceVerticals(workspaceId: string): void {
  broadcaster.send(workspaceId, {
    type: 'verticals',
    project_id: workspaceId,
    verticals: board.listVerticals(db, workspaceId),
  });
  flushEvents();
}

// ── git (for the overlay's commit modal) ────────────────────────────
const execFileAsync = promisify(execFile);

function projectRoot(projectId: string): string | null {
  const row = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

/** Run the kit installer (`kankan init`) on a folder, registering it with THIS
 *  daemon (DAEMON_URL from our own PORT). Shared by /project/new and /vertical. */
function runInit(root: string) {
  return execFileAsync('sh', [INIT_SCRIPT, root], { env: { ...process.env, DAEMON_URL: `http://localhost:${PORT}` } });
}

/** Canonical path for comparisons: git reports toplevels with symlinks resolved
 *  (e.g. macOS /var → /private/var), so compare realpaths when they exist. */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Where a new vertical's kit comes from: 'shared' (monorepo — it lives at the
 *  workspace/repo root), 'install' (the folder is its own repo, or in no repo),
 *  or 'skip' (a subfolder of some other repo — init there would register a stray
 *  project at that repo's root). */
function classifyVertical(root: string, wsRoot: string): { kind: 'shared' | 'install' } | { kind: 'skip'; top: string } {
  const r = realOrResolved(root);
  const w = realOrResolved(wsRoot);
  if (r === w || r.startsWith(w + '/')) return { kind: 'shared' };
  const top = realOrResolved(sessionCwd(root));
  if (top === realOrResolved(sessionCwd(wsRoot))) return { kind: 'shared' };
  if (top === r) return { kind: 'install' }; // own git toplevel, or not in any repo
  return { kind: 'skip', top };
}

// ── skills: scan .claude/skills for SKILL.md name+description frontmatter ──
function parseSkill(file: string): { name: string; description: string } | null {
  try {
    const fm = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    if (!name) return null;
    const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    return { name, description };
  } catch {
    return null;
  }
}

function scanSkillDir(dir: string, source: string): { name: string; description: string; source: string }[] {
  if (!existsSync(dir)) return [];
  const out: { name: string; description: string; source: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = parseSkill(join(dir, entry.name, 'SKILL.md'));
    if (skill) out.push({ ...skill, source });
  }
  return out;
}

/** Installed skills: user (~/.claude/skills) + the project's own. Project wins on name clash. */
function listSkills(root?: string | null) {
  const byName = new Map<string, { name: string; description: string; source: string }>();
  for (const s of scanSkillDir(join(homedir(), '.claude', 'skills'), 'user')) byName.set(s.name, s);
  if (root) for (const s of scanSkillDir(join(root, '.claude', 'skills'), 'project')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function skillRoots(root?: string | null): { dir: string; source: string }[] {
  return [
    { dir: join(homedir(), '.claude', 'skills'), source: 'user' },
    ...(root ? [{ dir: join(root, '.claude', 'skills'), source: 'project' }] : []),
  ];
}

/** Full skill: frontmatter name/description + the markdown body. */
function readSkill(file: string) {
  const txt = readFileSync(file, 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = m ? m[1] : '';
  const body = (m ? m[2] : txt).trim();
  return {
    name: fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '',
    description: fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '',
    body,
  };
}

function findSkillFile(name: string, root?: string | null): { file: string; source: string } | null {
  for (const { dir, source } of skillRoots(root)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, 'SKILL.md');
      if (existsSync(file) && (entry.name === name || readSkill(file).name === name)) return { file, source };
    }
  }
  return null;
}

function writeSkill(file: string, s: { name: string; description: string; body: string }): void {
  const desc = (s.description ?? '').replace(/\r?\n/g, ' ').trim();
  writeFileSync(file, `---\nname: ${s.name}\ndescription: ${desc}\n---\n\n${(s.body ?? '').trim()}\n`, 'utf8');
}

async function git(root: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args]);
    return stdout;
  } catch (err) {
    // git writes some failures to stdout (e.g. "nothing to commit")
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error((e.stderr || e.stdout || e.message).trim());
  }
}

/** Lines added/removed on a card branch vs main (best-effort; 0 if the branch is gone). */
async function gitNumstat(root: string, branch: string): Promise<{ added: number; removed: number }> {
  try {
    const out = await git(root, 'diff', '--numstat', `main...${branch}`);
    let added = 0;
    let removed = 0;
    for (const line of out.trim().split('\n')) {
      if (!line) continue;
      const [a, d] = line.split('\t');
      added += Number(a) || 0;
      removed += Number(d) || 0;
    }
    return { added, removed };
  } catch {
    return { added: 0, removed: 0 };
  }
}

async function gitStatus(root: string) {
  const branch = (await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const porcelain = await git(root, 'status', '--porcelain');
  const files = porcelain
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3);
      return {
        status: line.slice(0, 2).trim(),
        path: path.includes(' -> ') ? path.split(' -> ')[1] : path, // renames
      };
    });
  let remote: string | null = null;
  try {
    remote = (await git(root, 'remote', 'get-url', 'origin')).trim() || null;
  } catch {
    /* no origin remote */
  }
  return { branch, files, remote };
}

/** Attach a GitHub repo to a folder, smartly by folder state: clone into an empty
 *  folder, else git init (if needed) + set origin. Never clobbers an existing remote. */
async function attachRepo(root: string, url: string): Promise<{ ok: boolean; action?: string; error?: string }> {
  try {
    const empty = !existsSync(root) || readdirSync(root).length === 0;
    if (empty) {
      mkdirSync(root, { recursive: true });
      await execFileAsync('git', ['clone', url, root]);
      return { ok: true, action: 'cloned' };
    }
    if (!existsSync(join(root, '.git'))) await execFileAsync('git', ['-C', root, 'init']);
    try {
      await execFileAsync('git', ['-C', root, 'remote', 'get-url', 'origin']);
      return { ok: false, error: 'this project already has an origin remote' };
    } catch {
      /* no remote yet — good */
    }
    await execFileAsync('git', ['-C', root, 'remote', 'add', 'origin', url]);
    return { ok: true, action: 'connected' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function gitDiff(root: string, file: string): Promise<string> {
  const tracked = await git(root, 'diff', 'HEAD', '--', file);
  if (tracked) return tracked;
  // untracked file → whole content as additions (no-index exits 1 on diff)
  try {
    return await execFileAsync('git', ['-C', root, 'diff', '--no-index', '--', '/dev/null', file])
      .then((r) => r.stdout);
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? '';
  }
}

// ── http helpers ────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Cap the accumulated request body so a huge (or unbounded) POST can't be
// buffered into memory → OOM. Normal small JSON bodies stay well under this.
const MAX_BODY_BYTES = 1_000_000; // ~1MB

/** Thrown when a request body exceeds MAX_BODY_BYTES; mapped to 413 by route(). */
class PayloadTooLargeError extends Error {
  readonly status = 413;
  constructor() {
    super('request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) {
      // Stop buffering (breaking the loop halts consumption) and let route()'s
      // catch send the 413. We intentionally don't destroy the socket here so
      // the response still reaches the client.
      throw new PayloadTooLargeError();
    }
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (name.includes('..') || name.includes('/')) return json(res, 404, { error: 'not found' });
  try {
    const content = await readFile(join(OVERLAY_DIR, name));
    res.writeHead(200, { 'content-type': MIME[extname(name)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// ── routes ──────────────────────────────────────────────────────────
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/config') {
    // token is readable only same-origin (no CORS headers set) → stays out of
    // cross-origin pages; the /pty upgrade requires it.
    return json(res, 200, { terminal: terminalReady(), token: terminalToken });
  }

  if (method === 'GET' && pathname === '/project') {
    const root = url.searchParams.get('root');
    if (!root) return json(res, 400, { error: 'root required' });
    // create=0 → look up only (hooks use this so transient cwds, e.g. worktrees,
    // never spawn junk projects). Default creates, for `kankan init` / the MCP tool.
    if (url.searchParams.get('create') === '0') {
      const found = board.findProject(db, root);
      return json(res, 200, found ? { project_id: found.id, name: found.name } : { project_id: null });
    }
    const project = board.getOrCreateProject(db, root, url.searchParams.get('name') ?? undefined);
    return json(res, 200, { project_id: project.id, name: project.name });
  }

  if (method === 'GET' && pathname === '/projects') {
    // Show projects that are deliberately set up: they have cards OR a .mcp.json
    // at their root (what `kankan init` writes). Stray cwds (neither) stay hidden.
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.root_path AS root, p.parent_id,
                EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id) AS has_cards
         FROM projects p ORDER BY p.created_at DESC`,
      )
      .all() as { id: string; name: string; root: string; parent_id: string | null; has_cards: number }[];
    const setUp = new Set(rows.filter((r) => r.has_cards || existsSync(join(r.root, '.mcp.json'))).map((r) => r.id));
    // a vertical has no .mcp.json and may have no cards → shown whenever its workspace is
    const visible = rows
      .filter((r) => setUp.has(r.id) || (r.parent_id !== null && setUp.has(r.parent_id)))
      .map((r) => ({ id: r.id, name: r.name, parent_id: r.parent_id }));
    return json(res, 200, visible);
  }

  if (method === 'POST' && pathname === '/project/pick') {
    // Native macOS folder chooser (has a New Folder button). ENOENT → non-macOS.
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Select or create a project folder for kankanban")',
      ]);
      const path = stdout.trim();
      return json(res, 200, path ? { path } : { cancelled: true });
    } catch (err) {
      return json(res, 200, (err as { code?: string }).code === 'ENOENT' ? { needs_path: true } : { cancelled: true });
    }
  }

  if (method === 'POST' && pathname === '/project/new') {
    // Set up a project at a path, optionally attaching a GitHub repo (clone into
    // an empty folder; else connect a remote after the kit is laid down).
    const b = await readBody(req).catch(() => ({}));
    const root = typeof b.path === 'string' ? b.path.trim() : '';
    if (!root) return json(res, 400, { error: 'path required' });
    const repo = typeof b.repo === 'string' ? b.repo.trim() : '';
    const wasEmpty = !existsSync(root) || readdirSync(root).length === 0;
    if (repo && wasEmpty) {
      try {
        mkdirSync(root, { recursive: true });
        await execFileAsync('git', ['clone', repo, root]);
      } catch (err) {
        return json(res, 500, { error: `clone failed: ${(err as Error).message}` });
      }
    }
    try {
      await runInit(root);
    } catch (err) {
      return json(res, 500, { error: `setup failed: ${(err as Error).message}` });
    }
    if (repo && !wasEmpty) await attachRepo(root, repo); // content already there → connect a remote
    const project = board.getOrCreateProject(db, root);
    return json(res, 200, { project_id: project.id, name: project.name, path: root });
  }

  // ── workspaces / verticals ──────────────────────────────────────────
  if (method === 'POST' && pathname === '/vertical') {
    const b = await readBody(req);
    if (!b.workspace_id || !b.name || !b.root)
      return json(res, 400, { error: 'workspace_id, name and root required' });
    // Validate BEFORE any side effect (init writes into the folder): throws → 400.
    const { workspace, root } = board.validateVertical(db, b.workspace_id, b.root);
    let kit = 'shared';
    const c = classifyVertical(root, workspace.root_path);
    if (c.kind === 'skip') kit = `skipped: folder is inside another repo (${c.top})`;
    else if (c.kind === 'install') {
      // Separate repo → install the kit like `kankan init`. init registers the
      // folder as a top-level project, which createVertical then adopts. If it
      // fails partway it may leave that stray top-level project behind.
      try {
        await runInit(root);
      } catch (err) {
        const stderr = String((err as { stderr?: string }).stderr ?? (err as Error).message);
        return json(res, 500, { error: 'kit install failed', detail: stderr.slice(-500) });
      }
      kit = 'installed';
    }
    const v = board.createVertical(db, b.workspace_id, b.name, b.root);
    announceVerticals(b.workspace_id);
    return json(res, 200, { project_id: v.id, name: v.name, root_path: v.root_path, parent_id: v.parent_id, kit });
  }
  if (method === 'GET' && pathname === '/verticals') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    return json(res, 200, board.listVerticals(db, project));
  }
  if (method === 'GET' && pathname === '/workspace') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    // clean 404 (not the catch-all 400) so hooks can validate an env-provided id
    if (!projectRoot(project)) return json(res, 404, { error: 'unknown project' });
    return json(res, 200, board.getWorkspace(db, project));
  }
  if (method === 'GET' && pathname === '/workspace/summary') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    if (!projectRoot(project)) return json(res, 404, { error: 'unknown project' });
    const summary = board.getWorkspaceSummary(db, project);
    const now = Date.now();
    return json(res, 200, {
      ...summary,
      boards: summary.boards.map((b) => ({ ...b, session: states.view(b.project.id, now) })),
    });
  }

  const projMatch = pathname.match(/^\/project\/([^/]+)(?:\/(repo))?$/);
  if (projMatch && projMatch[1] !== 'new' && projMatch[1] !== 'pick') {
    const [, pid, action] = projMatch;
    if (method === 'DELETE' && !action) {
      const parent = db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(pid) as
        | { parent_id: string | null }
        | undefined;
      board.deleteProject(db, pid);
      states.forget(pid);
      broadcaster.send(pid, { type: 'project_removed', project_id: pid });
      if (parent?.parent_id) announceVerticals(parent.parent_id); // a vertical left its workspace
      return json(res, 200, { deleted: pid });
    }
    if (method === 'POST' && action === 'repo') {
      const b = await readBody(req);
      if (!b.url) return json(res, 400, { error: 'url required' });
      const root = projectRoot(pid);
      if (!root) return json(res, 404, { error: 'unknown project' });
      return json(res, 200, await attachRepo(root, String(b.url)));
    }
  }

  if (method === 'GET' && ['/board', '/active', '/next'].includes(pathname)) {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    if (pathname === '/board') return json(res, 200, board.getBoard(db, project));
    if (pathname === '/active') return json(res, 200, board.getActiveCards(db, project));
    const next = board.getNextCard(db, project);
    return json(res, 200, next && { ...toCard(next), requirements: next.requirements, depends_on: next.depends_on });
  }

  if (method === 'GET' && pathname === '/attention') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    return json(res, 200, board.getAttention(db, project));
  }

  if (method === 'POST' && pathname === '/pty/agent') {
    // launch `claude` in the project's shell — command execution, so gated
    // exactly like the /pty upgrade.
    if (!terminalReady()) return json(res, 409, { error: 'terminal disabled' });
    if (!authTerminal(req, url)) return json(res, 403, { error: 'forbidden' });
    const project = url.searchParams.get('project');
    const root = project ? projectRoot(project) : null;
    if (!project || !root) return json(res, 404, { error: 'unknown project' });
    const fresh = !ptySessions.has(project);
    const session = getPtySession(project, root);
    // Only type into an idle shell (foreground process group = the shell's pid;
    // name matching is unreliable — macOS /bin/sh reports as 'bash'). Launches
    // are serialized per session so a double-click can't type twice.
    const prev = session.agentLaunch ?? Promise.resolve();
    const launch = prev.then(() => launchAgent(session, fresh));
    session.agentLaunch = launch.catch(() => undefined);
    return json(res, 200, await launch);
  }

  if (method === 'POST' && pathname === '/pty/reset') {
    // kill the project's shared shell; onExit drops the session, so the next
    // /pty connect spawns a fresh one.
    if (!terminalReady()) return json(res, 409, { error: 'terminal disabled' });
    if (!authTerminal(req, url)) return json(res, 403, { error: 'forbidden' });
    const project = url.searchParams.get('project');
    const session = project ? ptySessions.get(project) : undefined;
    if (session) session.proc.kill();
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/stats') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    return json(res, 200, board.getStats(db, project));
  }

  if (method === 'GET' && pathname === '/skills') {
    const project = url.searchParams.get('project');
    return json(res, 200, listSkills(project ? projectRoot(project) : null));
  }
  if (method === 'POST' && pathname === '/skills') {
    const b = await readBody(req);
    if (!b.name) return json(res, 400, { error: 'name required' });
    const slug = String(b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return json(res, 400, { error: 'invalid name' });
    const dir = join(homedir(), '.claude', 'skills', slug);
    mkdirSync(dir, { recursive: true });
    writeSkill(join(dir, 'SKILL.md'), { name: b.name, description: b.description ?? '', body: b.body ?? '' });
    return json(res, 200, { name: b.name, slug });
  }
  const skillMatch = pathname.match(/^\/skills\/(.+)$/);
  if (skillMatch) {
    const name = decodeURIComponent(skillMatch[1]);
    const found = findSkillFile(name, url.searchParams.get('project') ? projectRoot(url.searchParams.get('project')!) : null);
    if (!found) return json(res, 404, { error: 'no such skill' });
    if (method === 'GET') return json(res, 200, { ...readSkill(found.file), source: found.source });
    if (method === 'PUT') {
      const b = await readBody(req);
      writeSkill(found.file, { name: b.name ?? name, description: b.description ?? '', body: b.body ?? '' });
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === '/team') {
    if (method === 'GET') return json(res, 200, board.listTeam(db));
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: 'name required' });
      return json(res, 200, board.createTeamMember(db, b.name, { skill: b.skill, color: b.color }));
    }
  }
  const teamMatch = pathname.match(/^\/team\/([^/]+)$/);
  if (teamMatch) {
    const id = teamMatch[1];
    if (method === 'DELETE') {
      board.deleteTeamMember(db, id);
      return json(res, 200, { deleted: id });
    }
    if (method === 'PATCH') {
      const b = await readBody(req);
      return json(res, 200, board.updateTeamMember(db, id, b));
    }
  }

  // ── outbound-webhook routes: gate the NEW /subscriptions* + /deliveries routes
  // (loopback OR daemon token) so a non-loopback LAN host can't register outbound
  // webhooks or read deliveries. Applies ONLY to these three; no pre-existing
  // board route is gated. Loopback stays open for the MCP tools + hooks.
  const isWebhookRoute =
    pathname === '/subscriptions' ||
    pathname === '/deliveries' ||
    /^\/subscriptions\/[^/]+$/.test(pathname);
  if (isWebhookRoute && !authDaemonRoute(req, url)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  // ── subscription registry (redacted views; board.ts owns secret redaction) ──
  if (pathname === '/subscriptions') {
    if (method === 'GET') {
      const projectId = url.searchParams.get('project_id');
      return json(res, 200, subscriptions.listSubscriptions(db, projectId ?? undefined));
    }
    if (method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, subscriptions.createSubscription(db, b));
    }
  }
  // ── deliveries: read-only observability (listing + DLQ via ?status=dead) ──
  if (method === 'GET' && pathname === '/deliveries') {
    const subscription_id = url.searchParams.get('subscription_id');
    const status = url.searchParams.get('status');
    const limitParam = url.searchParams.get('limit');
    return json(res, 200, subscriptions.listDeliveries(db, {
      subscription_id: subscription_id ?? undefined,
      status: status ?? undefined,
      limit: limitParam != null ? Number(limitParam) : undefined,
    }));
  }

  const subMatch = pathname.match(/^\/subscriptions\/([^/]+)$/);
  if (subMatch) {
    const id = subMatch[1];
    if (method === 'GET') {
      const sub = subscriptions.getSubscription(db, id);
      if (!sub) return json(res, 404, { error: 'no such subscription' });
      return json(res, 200, sub);
    }
    if (method === 'PATCH') {
      if (!subscriptions.getSubscription(db, id)) return json(res, 404, { error: 'no such subscription' });
      const b = await readBody(req);
      return json(res, 200, subscriptions.updateSubscription(db, id, { enabled: b.enabled }));
    }
    if (method === 'DELETE') {
      if (!subscriptions.deleteSubscription(db, id)) return json(res, 404, { error: 'no such subscription' });
      return json(res, 200, { deleted: id });
    }
  }

  if (method === 'POST' && pathname === '/task') {
    const b = await readBody(req);
    if (!b.project_id || !b.title) return json(res, 400, { error: 'project_id and title required' });
    const task = board.createTask(db, b.project_id, b.title, {
      tag: b.tag,
      requirements: b.requirements,
      depends_on: b.depends_on,
      phase_id: b.phase_id,
    });
    announce(task);
    return json(res, 200, { task_id: task.id });
  }

  // ── phases ────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/phases') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    return json(res, 200, board.getPhases(db, project));
  }
  if (method === 'GET' && pathname === '/phase/next') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    return json(res, 200, board.getNextPhase(db, project));
  }
  if (method === 'POST' && pathname === '/phase') {
    const b = await readBody(req);
    if (!b.project_id || !b.title) return json(res, 400, { error: 'project_id and title required' });
    const phase = board.createPhase(db, b.project_id, b.title, { goal: b.goal, plan: b.plan });
    announcePhases(b.project_id);
    return json(res, 200, { phase_id: phase.id });
  }
  if (method === 'POST' && pathname === '/phase/advance') {
    const b = await readBody(req);
    if (!b.project_id) return json(res, 400, { error: 'project_id required' });
    const phase = board.advancePhase(db, b.project_id);
    announcePhases(b.project_id);
    return json(res, 200, phase);
  }
  // after /phase/advance, so 'advance' is never taken as a phase id
  const phaseMatch = pathname.match(/^\/phase\/([^/]+)$/);
  if (method === 'POST' && phaseMatch) {
    const b = await readBody(req);
    if (b.position !== undefined && !(Number.isInteger(b.position) && b.position >= 1))
      return json(res, 400, { error: 'position must be an integer >= 1' });
    const phase = board.updatePhase(db, phaseMatch[1], { status: b.status, position: b.position });
    announcePhases(phase.project_id);
    return json(res, 200, phase);
  }

  const taskMatch = pathname.match(/^\/task\/([^/]+)(?:\/(move|review|check|redirect|activity|block|unblock))?$/);
  if (taskMatch) {
    const [, taskId, action] = taskMatch;
    if (method === 'GET' && !action) {
      // full detail for the overlay's card modal
      const task = board.getTask(db, taskId);
      return json(res, 200, {
        ...task,
        depends_on: task.depends_on ? JSON.parse(task.depends_on) : [],
        subtasks: task.subtasks ? JSON.parse(task.subtasks) : [],
        activity: board.cardTotals(db, taskId),
      });
    }
    if (method === 'DELETE' && !action) {
      const removed = board.deleteTask(db, taskId);
      broadcaster.send(removed.project_id, {
        type: 'card_removed',
        project_id: removed.project_id,
        card_id: removed.id,
      });
      flushEvents();
      for (const id of removed.unblocked) announce(board.getTask(db, id));
      return json(res, 200, { deleted: removed.id });
    }
    const b = await readBody(req);

    if (method === 'PATCH' && !action) {
      const rest = { ...b };
      delete rest.subtasks;
      delete rest.agent;
      let task;
      // assignment (agent + worktree + branch together) logs an assign event
      if (b.assigned_agent && b.worktree_path && b.branch) {
        task = board.assignCard(db, taskId, b.assigned_agent, b.worktree_path, b.branch, b.skill);
        delete rest.assigned_agent;
        delete rest.worktree_path;
        delete rest.branch;
        delete rest.skill;
      }
      if (Array.isArray(b.subtasks)) task = board.setSubtasks(db, taskId, b.subtasks, b.agent);
      if (!task || Object.keys(rest).length > 0) task = board.updateTask(db, taskId, rest);
      announce(task);
      return json(res, 200, { task_id: task.id });
    }
    if (method === 'POST' && action === 'check') {
      if (typeof b.index !== 'number') return json(res, 400, { error: 'index required' });
      const { task, moved } = board.checkSubtask(db, taskId, b.index, b.done ?? true, b.agent);
      announce(task);
      return json(res, 200, { task_id: task.id, lane: task.lane, subs: board.progressOf(task.subtasks), moved });
    }
    if (method === 'POST' && action === 'move') {
      if (!b.lane) return json(res, 400, { error: 'lane required' });
      const task = board.moveTask(db, taskId, b.lane, b.agent);
      announce(task);
      return json(res, 200, { task_id: task.id, lane: task.lane });
    }
    if (method === 'POST' && action === 'redirect') {
      const task = board.redirectTask(db, taskId, { requirements: b.requirements, note: b.note });
      announce(task);
      return json(res, 200, { task_id: task.id, lane: task.lane });
    }
    if (method === 'POST' && action === 'block') {
      if (!b.reason) return json(res, 400, { error: 'reason required' });
      const task = board.raiseBlocker(db, taskId, b.reason, b.agent);
      announce(task);
      return json(res, 200, { task_id: task.id, blocked: true });
    }
    if (method === 'POST' && action === 'unblock') {
      const task = board.resolveBlocker(db, taskId, b.note);
      announce(task);
      return json(res, 200, { task_id: task.id, blocked: false });
    }
    if (method === 'POST' && action === 'activity') {
      // tokens come from the build hook; the daemon adds line-churn + elapsed time.
      const task = board.getTask(db, taskId);
      const root = projectRoot(task.project_id);
      const lines = root && task.branch ? await gitNumstat(root, task.branch) : { added: 0, removed: 0 };
      const startEv = db
        .prepare(`SELECT created_at AS t FROM task_events WHERE task_id = ? AND type = 'build_start' ORDER BY id DESC LIMIT 1`)
        .get(taskId) as { t: number } | undefined;
      board.recordActivity(db, {
        project_id: task.project_id,
        task_id: taskId,
        agent: b.agent ?? task.assigned_agent,
        agent_id: b.agent_id,
        tokens: Number(b.tokens) || 0,
        tokens_out: Number(b.tokens_out) || 0,
        lines_added: lines.added,
        lines_removed: lines.removed,
        ms: startEv ? Date.now() - startEv.t : 0,
      });
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'review') {
      if (!b.verdict) return json(res, 400, { error: 'verdict required' });
      const review = board.recordReview(db, taskId, b.verdict, b.findings ?? []);
      flushEvents();
      return json(res, 200, review);
    }
  }

  if (method === 'GET' && (pathname === '/git/status' || pathname === '/git/diff')) {
    const project = url.searchParams.get('project');
    const root = project && projectRoot(project);
    if (!root) return json(res, 404, { error: 'unknown project' });
    if (pathname === '/git/status') return json(res, 200, await gitStatus(root));
    const file = url.searchParams.get('file');
    if (!file) return json(res, 400, { error: 'file required' });
    res.writeHead(200, { 'content-type': 'text/plain' });
    return void res.end(await gitDiff(root, file));
  }

  if (method === 'POST' && pathname === '/git/commit') {
    const b = await readBody(req);
    const root = b.project_id && projectRoot(b.project_id);
    if (!root) return json(res, 404, { error: 'unknown project' });
    if (!b.message) return json(res, 400, { error: 'message required' });
    await git(root, 'add', '-A');
    const args = ['commit', '-m', b.message];
    if (b.description) args.push('-m', b.description);
    await git(root, ...args); // throws "nothing to commit" etc. → 400
    let push_error = null;
    try {
      await git(root, 'push');
    } catch (err) {
      push_error = (err as Error).message;
    }
    return json(res, 200, { ok: true, pushed: !push_error, push_error });
  }

  if (method === 'POST' && pathname === '/usage') {
    // subscription limit usage pushed by the statusline script.
    // account-level + ephemeral: memory only, broadcast to every client.
    const b = await readBody(req);
    if (!b.five_hour && !b.seven_day) return json(res, 400, { error: 'five_hour or seven_day required' });
    usage = { five_hour: b.five_hour ?? usage?.five_hour ?? null, seven_day: b.seven_day ?? usage?.seven_day ?? null };
    broadcaster.sendAll({ type: 'usage', usage });
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/status') {
    // ephemeral: cached in memory (SessionStates), never stored in SQLite —
    // live "what is the agent doing"
    const b = await readBody(req);
    if (!b.project_id || !b.verb) return json(res, 400, { error: 'project_id and verb required' });
    const status = {
      agent: b.agent ?? 'agent',
      verb: b.verb,
      detail: b.detail ?? '',
      task_id: b.task_id ?? null,
    };
    const now = Date.now();
    states.record(b.project_id, { ...status, agent_id: b.agent_id ?? null, at: now });
    broadcaster.send(b.project_id, {
      type: 'status',
      project_id: b.project_id,
      status,
      session: states.view(b.project_id, now),
    });
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/session') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    return json(res, 200, states.view(project, Date.now()));
  }

  if (method === 'POST' && pathname === '/event') {
    const b = await readBody(req);
    if (!b.project_id || !b.type) return json(res, 400, { error: 'project_id and type required' });
    board.appendEvent(db, b);
    flushEvents();
    return json(res, 200, { ok: true });
  }

  if (method === 'GET') return serveStatic(res, pathname);
  return json(res, 404, { error: 'not found' });
}

// ── server ──────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  route(req, res).catch((err: Error) =>
    json(res, err instanceof PayloadTooLargeError ? err.status : 400, { error: err.message }),
  );
});

const wss = new WebSocketServer({ noServer: true });
const ptyWss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  // explicit ?project= filters; otherwise subscribe to everything and
  // seed the overlay with the most recently created project's board.
  const requested = url.searchParams.get('project');
  broadcaster.add(ws, requested);
  const project = requested
    ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(requested) as Project | undefined)
    : (db.prepare('SELECT * FROM projects ORDER BY created_at DESC LIMIT 1').get() as
        | Project
        | undefined);
  ws.send(
    JSON.stringify({
      type: 'init',
      project: project ? { id: project.id, name: project.name } : null,
      board: project ? board.getBoard(db, project.id) : [],
      phases: project ? board.getPhases(db, project.id) : [],
      events: project ? board.getRecentEvents(db, project.id, 10).reverse() : [],
      stats: project ? projectStats(project.id) : { started_at: STARTED_AT, reviews: { pass: 0, fail: 0 } },
      usage,
    }),
  );
});

// terminal: attach the socket to the project's persistent shell, replay scrollback.
ptyWss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const projectId = url.searchParams.get('project');
  const root = projectId ? projectRoot(projectId) : null;
  if (!projectId || !root) return ws.close();
  const session = getPtySession(projectId, root);
  session.clients.add(ws);
  if (session.buffer) ws.send(JSON.stringify({ t: 'o', d: session.buffer }));
  ws.on('message', (raw) => {
    let msg: { t?: string; d?: unknown; c?: unknown; r?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') session.proc.write(msg.d);
    else if (msg.t === 'r' && Number.isInteger(msg.c) && Number.isInteger(msg.r)) {
      try {
        session.proc.resize(msg.c, msg.r);
      } catch {
        /* pty may be mid-exit */
      }
    }
  });
  ws.on('close', () => session.clients.delete(ws));
});

// one HTTP server, two WS endpoints: /ws (board, open) and /pty (terminal, gated).
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (url.pathname === '/pty' && authTerminal(req, url)) {
    ptyWss.handleUpgrade(req, socket, head, (ws) => ptyWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// listen failures surface on both the http server and the ws wrapper
function onListenError(err: NodeJS.ErrnoException): void {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} already in use — is another board daemon running?`);
    process.exit(1);
  }
  throw err;
}
server.on('error', onListenError);
wss.on('error', onListenError);

const onListening = () =>
  console.log(
    `board daemon on http://${HOST}:${PORT}  (db: ${DB_PATH})${terminalReady() ? '  [terminal on]' : ''}`,
  );
server.listen(PORT, HOST, onListening);

// ── delivery worker ─────────────────────────────────────────────────
// Drains the outbox and delivers events to matching subscriptions. Runs by
// DEFAULT (so the webhook/Slack demo works out of the box); set KANKAN_DISPATCHER=0
// to disable it. A bad tick is swallowed so a delivery hiccup can't kill the
// daemon; runOnce is fire-and-forget so a slow send never blocks the interval.
if (process.env.KANKAN_DISPATCHER !== '0') {
  const dispatcher = new Dispatcher(db);
  setInterval(() => {
    dispatcher.runOnce().catch((err) => console.error(`dispatcher tick failed: ${(err as Error).message}`));
  }, 1000).unref();
}
