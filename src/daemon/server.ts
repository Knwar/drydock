import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import * as board from '../core/board.js';
import * as subscriptions from '../core/subscriptions.js';
import * as drafts from '../core/plan-drafts.js';
import * as metrics from '../core/metrics.js';
import * as forecast from '../core/forecast.js';
import { layoutColumns, longestChain, validatePlan } from '../core/plan-graph.js';
import { openDb } from '../core/db.js';
import { cardLines } from '../core/lines.js';
import { cachedCodeVersion, readCodeVersion } from './code-version.js';
import type { PlanDraft, Project, Task } from '../core/types.js';
import { looksLikeClaude, NUDGE_PROMPT, resetsAtMs, shouldNudge, type NudgeInput } from './autopilot.js';
import { Broadcaster } from './broadcast.js';
import { Dispatcher } from './dispatcher.js';
import { sessionCwd, sessionEnv } from './pty-env.js';
import { ptyGroups, shellInfo, stillOurs, ttyGroups, type ShellInfo } from './pty-groups.js';
import { SessionStates, type SessionView, type StatusEntry } from './session-state.js';
import { suggestVerticals } from './vertical-suggest.js';

const PORT = Number(process.env.PORT ?? 7890);
// Bind loopback by DEFAULT so the daemon (incl. the unauthenticated overlay
// routes) is not reachable from the LAN. Exposing it is an explicit opt-in:
// set HOST=0.0.0.0 (all interfaces) or a specific IP.
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), 'data', 'board.db');
const OVERLAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'overlay');
const INIT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'init-project.sh');

// fingerprint of the daemon code it runs (recorded at startup) vs on disk now (GET /version)
const CODE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNING_VERSION = await readCodeVersion(CODE_ROOT);
const diskVersion = cachedCodeVersion(CODE_ROOT);

const db = openDb(DB_PATH);
const broadcaster = new Broadcaster();
// live agent session state per project: memory only, never persisted
const states = new SessionStates();

// ── embedded terminal (on by default; KANKAN_TERMINAL=0 disables) ───
// node-pty is an OPTIONAL native dep: the board runs fine without it, and a
// failed compile just leaves the terminal off. It is strictly LOCAL: every
// /pty connection must arrive over loopback AND carry a per-start token
// (handed out by /config to loopback callers only).
type PtySpawn = (file: string, args: string[], opts: Record<string, unknown>) => any;
let ptySpawn: PtySpawn | null = null;
let terminalToken: string | null = null;
if (process.env.KANKAN_TERMINAL !== '0') {
  try {
    const mod: any = await import('node-pty');
    ptySpawn = (mod.spawn ?? mod.default?.spawn) as PtySpawn;
    terminalToken = randomBytes(24).toString('hex');
  } catch (err) {
    console.warn(`terminal disabled: node-pty unavailable (${(err as Error).message})`);
  }
}
const terminalReady = (): boolean => ptySpawn !== null && terminalToken !== null;
/** A loopback bind address: localhost, ::1 / [::1], or anything in 127.0.0.0/8. */
const isLoopbackHost = (h: string): boolean =>
  h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
if (terminalReady() && !isLoopbackHost(HOST)) {
  console.warn(`note: daemon bound to ${HOST}; the embedded terminal only accepts connections from this machine`);
}

interface PtySession {
  proc: any;
  buffer: string;
  clients: Set<WebSocket>;
  agentLaunch?: Promise<unknown>;
  /** Tail of the per-session chain that serializes typing into Claude
   *  (autopilot nudges + /pty/send), so two writes never interleave. */
  typing?: Promise<unknown>;
}
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

// a hung `ps` must not stall the typing lock; a timeout counts as "unknown"
const PS_TIMEOUT_MS = 3000;

/** The terminal's foreground process group (0 before the shell has taken the
 *  tty, -1 if unknown). The shell is idle iff this is its own pid. */
async function foregroundPgid(session: PtySession): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'tpgid=', '-p', String(session.proc.pid)], { timeout: PS_TIMEOUT_MS });
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

/** True iff the pty's foreground process group leader looks like Claude Code
 *  (not the shell, vim, a dev server, a nested shell…). */
async function claudeIsForeground(session: PtySession): Promise<boolean> {
  const fg = await foregroundPgid(session);
  if (fg <= 0 || fg === session.proc.pid) return false;
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-o', 'command=', '-p', String(fg)], { timeout: PS_TIMEOUT_MS });
    return looksLikeClaude(stdout);
  } catch {
    return false; // process gone / ps timed out → not in foreground
  }
}

/** Type `text` into Claude Code's input (not a shell → no Ctrl-U line-kill),
 *  then Enter. The short gap keeps the Enter from being read as part of a paste. */
async function typeIntoClaude(session: PtySession, text: string): Promise<void> {
  session.proc.write(text);
  await new Promise((r) => setTimeout(r, 100));
  session.proc.write('\r');
}

/** Run `fn` after any earlier typing into this session has finished. */
function withTypingLock<T>(session: PtySession, fn: () => Promise<T>): Promise<T> {
  const run = (session.typing ?? Promise.resolve()).then(fn);
  session.typing = run.catch(() => undefined);
  return run;
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

/** /pty gate: a loopback connection + valid per-start token + a same-machine
 *  Origin (or none, for CLIs). */
function authTerminal(req: IncomingMessage, url: URL): boolean {
  if (!terminalReady() || !isLoopback(req) || url.searchParams.get('token') !== terminalToken) return false;
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
 *  token (the SAME token the terminal uses; /config serves it to loopback
 *  callers only, so a remote caller must be handed it out of band). Anything else
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
    lane_since: board.laneSince(db, task.id),
  };
}

const STARTED_AT = Date.now();

interface LimitWindow { used_percentage: number; resets_at: number }
let usage: { five_hour: LimitWindow | null; seven_day: LimitWindow | null } | null = null;

// ── autopilot: prompt an idle session that has queued cards ─────────
// Engine on by default; KANKAN_AUTOPILOT=0 disables it (the test helper does).
// Per-project opt-in is projects.autopilot. Memory-only bookkeeping.
const AUTOPILOT_ENGINE = process.env.KANKAN_AUTOPILOT !== '0';
const AUTOPILOT_INTERVAL_MS = 30_000;
const lastNudgedIdleAt = new Map<string, number>(); // project → the idle period (its start) we nudged
// project → when the main session's current idle period began. Consecutive idle
// pings (Stop, then the idle_prompt notification) extend one period, so they
// don't re-nudge; a non-idle ping in between starts a new one.
const mainIdleStart = new Map<string, number>();
const autopilotInFlight = new Set<string>();

async function evaluateAutopilot(projectId: string): Promise<void> {
  if (autopilotInFlight.has(projectId)) return;
  autopilotInFlight.add(projectId);
  try {
    const row = db.prepare('SELECT autopilot FROM projects WHERE id = ?').get(projectId) as
      | { autopilot: number }
      | undefined;
    if (!row) return;
    const now = Date.now();
    const view = states.view(projectId, now);
    const idleSince = (v: typeof view) =>
      v.main?.verb === 'idle' ? (mainIdleStart.get(projectId) ?? v.main.at) : null;
    const { n: queued } = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND lane = 'queued'`)
      .get(projectId) as { n: number };
    const five = usage?.five_hour;
    const input: NudgeInput = {
      autopilot: row.autopilot === 1,
      sessionState: view.state,
      mainIdleSince: idleSince(view),
      lastNudgedIdleAt: lastNudgedIdleAt.get(projectId) ?? null,
      queued,
      claudeForeground: true, // pre-check: cheap conditions first, ps only if they pass
      fivePct: typeof five?.used_percentage === 'number' ? five.used_percentage : null,
      fiveResetsAt: resetsAtMs(five?.resets_at),
      now,
    };
    const session = ptySessions.get(projectId);
    if (!shouldNudge(input).nudge || !session) return;
    // Only type into Claude Code itself (serialized with /pty/send typing).
    const typed = await withTypingLock(session, async () => {
      const claudeForeground = await claudeIsForeground(session);
      if (!shouldNudge({ ...input, claudeForeground }).nudge) return false;
      // the async checks took time: re-confirm the same idle period is still current
      const fresh = states.view(projectId, Date.now());
      if (fresh.state !== 'idle' || fresh.main === null || idleSince(fresh) !== input.mainIdleSince) return false;
      if (ptySessions.get(projectId) !== session) return false;
      lastNudgedIdleAt.set(projectId, input.mainIdleSince!);
      await typeIntoClaude(session, NUDGE_PROMPT);
      return true;
    });
    if (!typed) return;
    broadcaster.send(projectId, { type: 'autopilot_nudge', project_id: projectId, at: now });
    board.appendEvent(db, { project_id: projectId, type: 'autopilot', payload: { nudged: true } });
    flushEvents();
  } catch (err) {
    console.error(`autopilot evaluation failed: ${(err as Error).message}`);
  } finally {
    autopilotInFlight.delete(projectId);
  }
}

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

/** Tell a draft's workspace subscribers it changed (or is gone), so an open canvas can refresh. */
function announceDraft(draft: Pick<PlanDraft, 'id' | 'workspace_id' | 'version'>, removed = false): void {
  broadcaster.send(
    draft.workspace_id,
    removed
      ? { type: 'plan_draft_removed', id: draft.id, workspace_id: draft.workspace_id }
      : { type: 'plan_draft', id: draft.id, workspace_id: draft.workspace_id, version: draft.version },
  );
}

/** The canvas read: a draft + its layout, validation, target boards and dirty flag. */
function draftView(draft: PlanDraft) {
  const { nodes, edges } = draft.data;
  const ctx = drafts.draftContext(db, draft.workspace_id);
  const columns = layoutColumns(nodes, edges);
  return {
    draft,
    layout: columns ? { columns, longestChain: longestChain(nodes, edges) } : null,
    validation: validatePlan(draft.data, ctx),
    boards: ctx.boards,
    dirty: draft.version !== draft.committed_version,
  };
}

/** A project id (workspace or vertical) → its workspace id, or null when unknown. */
function draftWorkspace(projectId: string): string | null {
  const row = db.prepare('SELECT id, parent_id FROM projects WHERE id = ?').get(projectId) as
    | { id: string; parent_id: string | null }
    | undefined;
  return row ? (row.parent_id ?? row.id) : null;
}

/** DraftConflict → 409 {error, code, errors?, version?}; DraftError → 404 (not_found) or 400 {error, code}; anything else rethrows. */
function draftError(res: ServerResponse, err: unknown): void {
  if (err instanceof drafts.DraftConflict)
    return json(res, 409, { error: err.message, code: err.code, errors: err.errors, version: err.version });
  if (!(err instanceof drafts.DraftError)) throw err;
  json(res, err.code === 'not_found' ? 404 : 400, { error: err.message, code: err.code });
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

/** `a` is `b` or one of its ancestors (segment-aware). */
const isAncestorOrSelf = (a: string, b: string): boolean => a === b || b.startsWith(a.endsWith('/') ? a : a + '/');

/** Canonical spelling of an incoming root, matching how stored projects spell
 *  it, so the board's plain string comparisons (workspace root, collisions) hold
 *  for any alias (/var ↔ /private/var, symlinks): a stored root_path that
 *  resolves to the same realpath is used as-is; else a path under a stored root
 *  keeps that root's spelling (the deepest one); else the realpath. */
function canonicalRoot(p: string): string {
  const real = realOrResolved(p);
  const rows = db.prepare('SELECT root_path FROM projects').all() as { root_path: string }[];
  let best: { stored: string; real: string } | null = null;
  for (const { root_path } of rows) {
    const r = realOrResolved(root_path);
    if (r === real) return root_path;
    if (isAncestorOrSelf(r, real) && (!best || r.length > best.real.length)) best = { stored: root_path, real: r };
  }
  return best ? join(best.stored, relative(best.real, real)) : real;
}

interface SplitTarget {
  name: string;
  root: string;
  folder: string;
  kit: 'shared' | 'install' | `skipped: ${string}`;
}

/** Resolve + validate split targets for `source`, side-effect free (throws → 400).
 *  `folder` (or `root`): relative → under the source's git toplevel; absolute → as-is. */
function resolveSplitTargets(source: Project, raw: unknown): SplitTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('targets required (a non-empty array)');
  const workspaceId = source.parent_id ?? source.id;
  const wsRoot = projectRoot(workspaceId)!;
  const realSource = realOrResolved(source.root_path);
  const top = realOrResolved(sessionCwd(source.root_path));
  const seen = new Set<string>();
  return raw.map((t: { name?: unknown; folder?: unknown; root?: unknown }) => {
    const name = typeof t?.name === 'string' ? t.name.trim() : '';
    const given = typeof t?.folder === 'string' ? t.folder.trim() : typeof t?.root === 'string' ? t.root.trim() : '';
    if (!name || !given) throw new Error('each target needs a name and a folder');
    const root = canonicalRoot(isAbsolute(given) ? given : join(top, given));
    const real = realOrResolved(root);
    if (real === realSource) throw new Error(`target "${name}": folder must differ from the source's own root`);
    if (seen.has(real)) throw new Error(`duplicate target folder: ${root}`);
    seen.add(real);
    try {
      board.validateVertical(db, workspaceId, root); // existing dir, not the workspace root, no collision
    } catch (err) {
      throw new Error(`target "${name}": ${(err as Error).message}`);
    }
    const c = classifyVertical(root, wsRoot);
    const kit = c.kind === 'skip' ? (`skipped: folder is inside another repo (${c.top})` as const) : c.kind;
    const rel = relative(top, real);
    const folder = rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? root : rel;
    return { name, root, folder, kit };
  });
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

/** Replace a card's line counts with its git-derived change (merge commit, else
 *  branch vs its base), then announce the card. Best-effort: leaves them as-is
 *  when git has nothing. Called AFTER the response is sent (git can be slow);
 *  errors are logged, never thrown. Serialized per card, so a slow earlier
 *  recount (an activity post) can't land after, and overwrite, the done one. */
const recounts = new Map<string, Promise<void>>(); // per-card chain: recounts run (and land) in call order
function recountCard(task: Task): void {
  const next = (recounts.get(task.id) ?? Promise.resolve())
    .then(async () => {
      const root = projectRoot(task.project_id);
      const lines = root ? await cardLines(root, task.id) : null;
      if (!lines) return;
      board.setCardLines(db, task.id, lines.added, lines.removed);
      announce(board.getTask(db, task.id));
    })
    .catch((err) => console.error(`line recount for ${task.id} failed: ${(err as Error).message}`));
  recounts.set(task.id, next);
  void next.then(() => {
    if (recounts.get(task.id) === next) recounts.delete(task.id);
  });
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

/** Raw request bytes, capped at `max` (PayloadTooLargeError → 413, like readBody). */
async function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > max) throw new PayloadTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ── agent avatars: uploaded images stored beside the DB ─────────────
const AVATAR_DIR = join(dirname(DB_PATH), 'avatars');
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
const AVATAR_NAME = /^[A-Za-z0-9_-]+\.(png|jpg|webp)$/;
const AVATAR_TYPES: Record<string, { ext: string; matches: (b: Buffer) => boolean }> = {
  'image/png': {
    ext: 'png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/jpeg': { ext: 'jpg', matches: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  'image/webp': {
    ext: 'webp',
    matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};
const AVATAR_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Delete an avatar file by stored name (ignores missing / malformed names). */
function removeAvatarFile(name: string | null | undefined): void {
  if (name && AVATAR_NAME.test(name)) rmSync(join(AVATAR_DIR, name), { force: true });
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
    // token goes to loopback callers only (a LAN host could otherwise curl it),
    // and same-origin only (no CORS headers) → stays out of cross-origin pages.
    return json(res, 200, {
      terminal: terminalReady(),
      token: isLoopback(req) ? terminalToken : null,
      version: isLoopback(req) ? RUNNING_VERSION : null,
    });
  }
  if (method === 'GET' && pathname === '/version') {
    // loopback-only: the code version on disk now (cached a few seconds), to compare with /config's
    if (!isLoopback(req)) return json(res, 403, { error: 'loopback only' });
    return json(res, 200, await diskVersion());
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
    if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' }); // may install the kit into a folder
    const b = await readBody(req);
    if (!b.workspace_id || !b.name || typeof b.root !== 'string' || !b.root)
      return json(res, 400, { error: 'workspace_id, name and root required' });
    b.root = canonicalRoot(b.root);
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
  if (method === 'GET' && pathname === '/home') {
    const project = url.searchParams.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    if (!projectRoot(project)) return json(res, 404, { error: 'unknown project' });
    const now = Date.now();
    // one read transaction: every /home query sees the same consistent snapshot
    const body = db.transaction(() => {
      const view = board.getWorkspace(db, project);
      const self = view.workspace.id === project ? view.workspace : view.verticals.find((v) => v.id === project)!;
      const standalone = self.parent_id === null && view.verticals.length === 0;
      const scope = board.homeScope(db, project);
      const sessions = new Map(scope.map((p) => [p.id, states.view(p.id, now)]));
      const activity = (e: StatusEntry | null | undefined) => (e ? `${e.verb} ${e.detail}`.trim() : null);
      const latest = (entries: StatusEntry[]): StatusEntry | undefined => [...entries].sort((a, b) => b.at - a.at)[0];
      // Status pings name the agent TYPE (e.g. 'builder') while cards store the team
      // member name, so task_id (derived by the hook from the .trees/<id> cwd) is the
      // primary join key; the label match is the fallback.
      const entriesOf = (s: SessionView) => (s.main ? [s.main, ...s.agents] : s.agents);
      const allEntries = [...sessions.values()].flatMap(entriesOf);
      // one GROUP BY for lane counts: covers every board in scope (in_progress
      // counts below) and, for a workspace, every board the verticals list shows
      const boards = standalone ? scope : [view.workspace, ...view.verticals];
      const lanes = board.laneCounts(db, boards.map((p) => p.id));
      const nowBuilding = board.getNowBuilding(db, project).map((card) => {
        const session = sessions.get(card.board.id)!;
        let entry =
          latest(entriesOf(session).filter((e) => e.task_id === card.id)) ??
          session.agents.find((a) => a.agent === card.agent);
        // the main session is working the card when it's the board's only in_progress card
        if (!entry && card.lane === 'in_progress' && lanes.get(card.board.id)?.in_progress === 1) {
          entry = session.main ?? undefined;
        }
        return { ...card, activity: activity(entry) };
      });
      const cardAgent = board.cardAgents(
        db,
        allEntries.flatMap((e) => (e.task_id !== null ? [e.task_id] : [])),
        scope.map((p) => p.id),
      );
      const agents = board.getAgentBoard(db, project).map((m) => {
        const entry =
          latest(
            allEntries.filter((e) => {
              const assigned = e.task_id !== null ? cardAgent.get(e.task_id) : null;
              return assigned === m.name || assigned === m.id;
            }),
          ) ??
          latest([...sessions.values()].flatMap((s) => s.agents).filter((a) => a.agent === m.name));
        return { ...m, now: activity(entry) };
      });
      return {
        project: { id: self.id, name: self.name, parent_id: self.parent_id },
        workspace: standalone ? null : view,
        now_building: nowBuilding,
        up_next: board.getUpNext(db, project),
        agents,
        verticals: standalone
          ? []
          : boards.map((p) => ({
              project: { id: p.id, name: p.name },
              lanes: lanes.get(p.id)!,
              session: states.view(p.id, now),
            })),
      };
    })();
    return json(res, 200, body);
  }

  const suggestMatch = pathname.match(/^\/project\/([^/]+)\/vertical-suggestions$/);
  if (method === 'GET' && suggestMatch) {
    const pid = suggestMatch[1];
    const root = projectRoot(pid);
    if (!root) return json(res, 404, { error: 'unknown project' });
    // only a standalone project (no verticals, not a vertical itself) gets suggestions
    const { workspace, verticals } = board.getWorkspace(db, pid);
    if (workspace.id !== pid || verticals.length > 0) return json(res, 200, { suggestions: [] });
    // folders relative to the git toplevel, as split targets resolve them (absolute if outside)
    const top = realOrResolved(sessionCwd(root));
    const suggestions = suggestVerticals(root).map((s) => {
      const abs = realOrResolved(join(root, s.folder));
      const rel = relative(top, abs);
      return { ...s, folder: rel.startsWith('..') || isAbsolute(rel) ? abs : rel };
    });
    return json(res, 200, { suggestions });
  }

  // ── split / merge verticals ─────────────────────────────────────────
  const kitLabel = (kit: SplitTarget['kit']) => (kit === 'install' ? 'installed' : kit);
  const splitMatch = pathname.match(/^\/project\/([^/]+)\/(split-preview|split)$/);
  if (method === 'POST' && splitMatch) {
    const [, pid, action] = splitMatch;
    // both loopback-only: preview probes paths and runs git in arbitrary folders
    if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' });
    const source = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) as Project | undefined;
    if (!source) return json(res, 404, { error: 'unknown project' });
    const b = await readBody(req);
    const targets = resolveSplitTargets(source, b.targets);
    if (action === 'split-preview') {
      const placement = board.suggestCardPlacement(
        db,
        pid,
        targets.map((t, i) => ({ key: String(i), folder: t.folder })),
      );
      return json(res, 200, {
        targets: targets.map((t) => ({ name: t.name, root: t.root, folder: t.folder, kit: kitLabel(t.kit) })),
        placement,
      });
    }
    if (!b.assignments || typeof b.assignments !== 'object' || Array.isArray(b.assignments))
      return json(res, 400, { error: 'assignments required' });
    const opts = { targets: targets.map((t) => ({ name: t.name, root: t.root })), assignments: b.assignments };
    const installs = targets.filter((t) => t.kit === 'install');
    if (installs.length) {
      // Dry-run the split (rolled back) so a SplitError surfaces BEFORE the kit is
      // written into any folder; init must run outside the DB transaction.
      const DRY_RUN = Symbol('dry-run');
      try {
        db.transaction(() => {
          board.splitIntoVerticals(db, pid, opts);
          throw DRY_RUN;
        })();
      } catch (err) {
        if (err !== DRY_RUN) {
          if (err instanceof board.SplitError) return json(res, 400, { error: err.message, cardIds: err.cardIds });
          throw err;
        }
      }
      for (const t of installs) {
        try {
          await runInit(t.root);
        } catch (err) {
          const stderr = String((err as { stderr?: string }).stderr ?? (err as Error).message);
          return json(res, 500, { error: `kit install failed for ${t.name}`, detail: stderr.slice(-500) });
        }
      }
    }
    let result;
    try {
      result = board.splitIntoVerticals(db, pid, opts);
    } catch (err) {
      if (err instanceof board.SplitError) return json(res, 400, { error: err.message, cardIds: err.cardIds });
      throw err;
    }
    // existing client contract: moved cards leave the source board and upsert on their target
    for (const cardId of Object.keys(result.moved)) {
      broadcaster.send(pid, { type: 'card_removed', project_id: pid, card_id: cardId });
      announce(board.getTask(db, cardId));
    }
    for (const v of result.verticals) announcePhases(v.id);
    announceVerticals(source.parent_id ?? source.id);
    return json(res, 200, {
      verticals: result.verticals.map((v, i) => ({ ...v, kit: kitLabel(targets[i].kit) })),
      moved: result.moved,
    });
  }

  if (method === 'POST' && pathname === '/verticals/merge') {
    if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' });
    const b = await readBody(req);
    if (typeof b.from !== 'string' || typeof b.into !== 'string')
      return json(res, 400, { error: 'from and into required' });
    if (b.phases !== 'append' && b.phases !== 'fold')
      return json(res, 400, { error: "phases must be 'append' or 'fold'" });
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim()))
      return json(res, 400, { error: 'name must be a non-empty string' });
    const fromRoot = projectRoot(b.from);
    const intoRoot = projectRoot(b.into);
    let root: string | undefined;
    if (b.root !== undefined) {
      if (typeof b.root !== 'string' || !b.root.trim()) return json(res, 400, { error: 'root must be a path' });
      root = canonicalRoot(b.root);
      let isDir = false;
      try {
        isDir = statSync(root).isDirectory();
      } catch {
        /* missing → not a directory */
      }
      if (!isDir) return json(res, 400, { error: `not an existing directory: ${root}` });
      if (fromRoot && intoRoot) {
        const [r, f, i] = [root, fromRoot, intoRoot].map(realOrResolved);
        const top = realOrResolved(sessionCwd(fromRoot));
        const sharedAncestor =
          isAncestorOrSelf(r, f) &&
          isAncestorOrSelf(r, i) &&
          top === realOrResolved(sessionCwd(intoRoot)) &&
          isAncestorOrSelf(top, r);
        if (r !== f && r !== i && !sharedAncestor)
          return json(res, 400, {
            error: "root must be from's or into's root, or a shared ancestor of both inside the same git repo",
          });
      }
    }
    const fromCards = (
      db.prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY position, rowid').all(b.from) as { id: string }[]
    ).map((r) => r.id);
    let into: Project;
    try {
      into = board.mergeVerticals(db, b.from, b.into, { name: b.name?.trim(), root, phases: b.phases });
    } catch (err) {
      if (err instanceof board.MergeError) return json(res, 400, { error: err.message, cardIds: err.cardIds });
      throw err;
    }
    // `from` is gone: close its terminal (its own process groups only) and drop its memory-only state
    const session = ptySessions.get(b.from);
    if (session) {
      ptySessions.delete(b.from);
      await killSessions([session]);
    }
    states.forget(b.from);
    lastNudgedIdleAt.delete(b.from);
    mainIdleStart.delete(b.from);
    broadcaster.send(b.from, { type: 'project_removed', project_id: b.from });
    for (const cardId of fromCards) announce(board.getTask(db, cardId));
    announcePhases(into.id);
    announceVerticals(into.parent_id!);
    return json(res, 200, into);
  }

  // ── plan drafts (workspace-wide visual plans) ──
  if (pathname === '/plan-drafts' && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') {
      const ws = draftWorkspace(url.searchParams.get('workspace') ?? '');
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      return json(res, 200, drafts.listDrafts(db, ws));
    }
    if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' });
    const b = await readBody(req);
    const ws = typeof b.workspace === 'string' ? draftWorkspace(b.workspace) : null;
    if (!ws) return json(res, 404, { error: 'unknown workspace' });
    try {
      const draft = drafts.createDraft(db, ws, b.title);
      announceDraft(draft);
      return json(res, 200, draft);
    } catch (err) {
      return draftError(res, err);
    }
  }

  const draftMatch = pathname.match(/^\/plan-drafts\/([^/]+)$/);
  if (draftMatch && ['GET', 'PATCH', 'DELETE'].includes(method ?? '')) {
    const id = draftMatch[1];
    if (method !== 'GET' && !isLoopback(req)) return json(res, 403, { error: 'forbidden' });
    try {
      if (method === 'GET') {
        const draft = drafts.getDraft(db, id);
        if (!draft) return json(res, 404, { error: 'unknown draft' });
        return json(res, 200, draftView(draft));
      }
      if (method === 'DELETE') {
        // raw row, not getDraft: a draft with corrupt data must still be deletable
        const draft = db.prepare('SELECT id, workspace_id, version FROM plan_drafts WHERE id = ?').get(id) as
          | Pick<PlanDraft, 'id' | 'workspace_id' | 'version'>
          | undefined;
        if (!draft || !drafts.deleteDraft(db, id)) return json(res, 404, { error: 'unknown draft' });
        announceDraft(draft, true);
        return json(res, 200, { deleted: id });
      }
      const b = await readBody(req);
      const current = drafts.getDraft(db, id);
      if (!current) return json(res, 404, { error: 'unknown draft' });
      if (b.version !== undefined && b.version !== current.version)
        return json(res, 409, { error: 'version mismatch', version: current.version });
      const draft = drafts.applyDraftOps(db, id, b.ops);
      announceDraft(draft);
      return json(res, 200, draftView(draft));
    } catch (err) {
      return draftError(res, err);
    }
  }

  const draftAction = pathname.match(/^\/plan-drafts\/([^/]+)\/(diff|commit|run)$/);
  if (draftAction && method === (draftAction[2] === 'diff' ? 'GET' : 'POST')) {
    const [, id, action] = draftAction;
    if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' });
    try {
      if (action === 'diff') return json(res, 200, drafts.diffDraft(db, id));
      const b = await readBody(req);
      if (action === 'commit') {
        if (typeof b.version !== 'number' || !Number.isFinite(b.version))
          return json(res, 400, { error: 'version (number) required' });
        const result = drafts.commitDraft(db, id, b.version);
        for (const m of result.moved)
          broadcaster.send(m.from, { type: 'card_removed', project_id: m.from, card_id: m.id });
        for (const d of result.deleted)
          broadcaster.send(d.project_id, { type: 'card_removed', project_id: d.project_id, card_id: d.id });
        flushEvents();
        const gone = new Set(result.deleted.map((d) => d.id));
        const cards = new Set([...result.touched, ...result.deleted.flatMap((d) => d.unblocked)]);
        for (const cardId of cards) if (!gone.has(cardId)) announce(board.getTask(db, cardId));
        for (const pid of result.boards) announcePhases(pid);
        announceDraft(result.draft);
        return json(res, 200, { diff: result.diff, draft: draftView(result.draft) });
      }
      const result = drafts.runDraft(db, id, b.mode);
      for (const cardId of result.queued) announce(board.getTask(db, cardId));
      for (const { board_id, already_on } of result.autopilot.enabled) {
        if (already_on) continue;
        broadcaster.send(board_id, { type: 'autopilot', project_id: board_id, on: true });
        const parent = (db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(board_id) as {
          parent_id: string | null;
        }).parent_id;
        if (parent) announceVerticals(parent);
      }
      flushEvents();
      const draft = drafts.getDraft(db, id)!;
      announceDraft(draft);
      return json(res, 200, result);
    } catch (err) {
      return draftError(res, err);
    }
  }

  const projMatch = pathname.match(/^\/project\/([^/]+)(?:\/(repo|autopilot|settings))?$/);
  if (projMatch && projMatch[1] !== 'new' && projMatch[1] !== 'pick') {
    const [, pid, action] = projMatch;
    if (method === 'DELETE' && !action) {
      const parent = db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(pid) as
        | { parent_id: string | null }
        | undefined;
      board.deleteProject(db, pid);
      states.forget(pid);
      lastNudgedIdleAt.delete(pid);
      mainIdleStart.delete(pid);
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
    if (method === 'POST' && action === 'autopilot') {
      const b = await readBody(req);
      if (typeof b.on !== 'boolean') return json(res, 400, { error: 'on (boolean) required' });
      if (!projectRoot(pid)) return json(res, 404, { error: 'unknown project' });
      const project = board.setAutopilot(db, pid, b.on);
      broadcaster.send(pid, { type: 'autopilot', project_id: pid, on: b.on });
      if (project.parent_id) announceVerticals(project.parent_id);
      else flushEvents();
      return json(res, 200, { project_id: pid, autopilot: project.autopilot });
    }
    if (action === 'settings' && (method === 'GET' || method === 'PUT')) {
      if (!projectRoot(pid)) return json(res, 404, { error: 'unknown project' });
      if (method === 'GET') return json(res, 200, board.getBoardSettings(db, pid));
      if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' });
      const b = await readBody(req);
      let settings;
      try {
        settings = board.setBoardSettings(db, pid, b);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      broadcaster.send(pid, { type: 'settings', project_id: pid, settings });
      return json(res, 200, settings);
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

  if (method === 'POST' && pathname === '/pty/send') {
    // types text into the project's Claude session — gated like /pty/agent, and
    // only into a verified Claude Code foreground at an idle prompt (same bar as autopilot).
    if (!terminalReady()) return json(res, 409, { error: 'terminal disabled' });
    if (!authTerminal(req, url)) return json(res, 403, { error: 'forbidden' });
    const project = url.searchParams.get('project');
    if (!project || !projectRoot(project)) return json(res, 404, { error: 'unknown project' });
    const b = await readBody(req);
    const text =
      typeof b.text === 'string'
        ? b.text
            .replace(/[\r\n]+/g, ' ')
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
            .trim()
        : '';
    if (text.length < 1 || text.length > 2000) return json(res, 400, { error: 'text must be 1-2000 characters' });
    const session = ptySessions.get(project);
    if (!session) return json(res, 409, { error: 'no claude session' });
    const result = await withTypingLock(session, async () => {
      if (ptySessions.get(project) !== session || !(await claudeIsForeground(session))) return 'no claude session';
      const state = states.view(project, Date.now()).state;
      // needs_you = a permission prompt is on screen: Enter would pick its
      // highlighted option, so only an idle prompt is safe to type into.
      if (state === 'needs_you') return 'waiting for a decision in the terminal — answer it there';
      if (state !== 'idle') return state === 'working' ? 'agent busy' : 'no claude session';
      await typeIntoClaude(session, text);
      return null;
    });
    if (result) return json(res, 409, { error: result });
    board.appendEvent(db, { project_id: project, type: 'note', payload: { msg: text, via: 'home' } });
    flushEvents();
    return json(res, 200, { sent: true });
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

  // ── flow metrics: aggregation lives in core/metrics.ts; these only parse + load ──
  if (method === 'GET' && ['/metrics/flow', '/metrics/burn', '/metrics/summary'].includes(pathname)) {
    const q = url.searchParams;
    const project = q.get('project');
    if (!project) return json(res, 400, { error: 'project required' });
    if (!projectRoot(project)) return json(res, 404, { error: 'unknown project' });
    const tz = q.get('tz') || metrics.localTimeZone();
    if (!metrics.isValidTimeZone(tz)) return json(res, 400, { error: `invalid tz: ${tz}` });
    const now = Date.now();
    try {
      if (pathname === '/metrics/burn') {
        const phaseId = q.get('phase');
        if (!phaseId) return json(res, 400, { error: 'phase required' });
        const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId) as metrics.BurnPhase & { project_id: string } | undefined;
        if (!phase) return json(res, 404, { error: 'unknown phase' });
        const boards = [project, ...board.listVerticals(db, project).map((v) => v.id)];
        if (!boards.includes(phase.project_id)) return json(res, 400, { error: 'phase is not on this project' });
        return json(res, 200, metrics.burnMetrics(db, phase, [project], { tz, now }));
      }
      // a workspace id expands to its verticals inside the loader
      const filter: metrics.MetricsFilter = { projectIds: [project] };
      for (const [key, param] of [['phaseId', 'phase'], ['tag', 'tag'], ['agent', 'agent']] as const) {
        const v = q.get(param);
        if (v) filter[key] = v;
      }
      const from = q.get('from');
      const to = q.get('to');
      if (from) filter.from = metrics.parseTime(from, tz, 'from');
      if (to) filter.to = metrics.parseTime(to, tz, 'to');
      const view = pathname === '/metrics/flow' ? metrics.flowMetrics : metrics.summaryMetrics;
      return json(res, 200, view(db, filter, { tz, now }));
    } catch (err) {
      // bad params → 400; anything else is ours → 500 (route()'s outer catch would say 400)
      const status = err instanceof metrics.MetricsParamError ? 400 : 500;
      return json(res, status, { error: (err as Error).message });
    }
  }

  // ── forecast: Monte Carlo finish dates (core/forecast.ts). Target: plan, else phase, else the whole board ──
  if (method === 'GET' && pathname === '/metrics/forecast') {
    const q = url.searchParams;
    const planId = q.get('plan');
    const phaseId = q.get('phase');
    let project = q.get('project');
    if (planId && phaseId) return json(res, 400, { error: 'give plan or phase, not both' });
    const tz = q.get('tz') || metrics.localTimeZone();
    if (!metrics.isValidTimeZone(tz)) return json(res, 400, { error: `invalid tz: ${tz}` });
    try {
      const weeks = forecast.intParam(q.get('weeks'), 'weeks', 2, 52);
      const seed = forecast.intParam(q.get('seed'), 'seed', 0, 2 ** 32 - 1);
      let target: forecast.ForecastTarget = { kind: 'board' };
      if (planId) {
        const draft = drafts.getDraft(db, planId);
        if (!draft) return json(res, 404, { error: 'unknown plan' });
        if (project && project !== draft.workspace_id) return json(res, 400, { error: 'plan is not on this project' });
        if (draft.committed_version === null) return json(res, 409, { error: 'plan is not committed' });
        project = draft.workspace_id;
        target = { kind: 'plan', cardIds: Object.values(draft.data.committed) };
      }
      if (!project) return json(res, 400, { error: 'project required' });
      if (!projectRoot(project)) return json(res, 404, { error: 'unknown project' });
      if (phaseId) {
        const phase = db.prepare('SELECT project_id FROM phases WHERE id = ?').get(phaseId) as { project_id: string } | undefined;
        if (!phase) return json(res, 404, { error: 'unknown phase' });
        const boards = [project, ...board.listVerticals(db, project).map((v) => v.id)];
        if (!boards.includes(phase.project_id)) return json(res, 400, { error: 'phase is not on this project' });
        target = { kind: 'phase', phaseId };
      }
      const tag = q.get('tag') || undefined;
      return json(res, 200, forecast.forecast(db, { projectId: project, tag }, target, { tz, now: Date.now(), weeks, seed }));
    } catch (err) {
      const status = err instanceof metrics.MetricsParamError ? 400 : 500;
      return json(res, status, { error: (err as Error).message });
    }
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
      const member = board.listTeam(db).find((m) => m.id === id);
      board.deleteTeamMember(db, id);
      removeAvatarFile(member?.avatar);
      return json(res, 200, { deleted: id });
    }
    if (method === 'PATCH') {
      const b = await readBody(req);
      try {
        return json(res, 200, board.updateTeamMember(db, id, b));
      } catch (err) {
        const msg = (err as Error).message;
        if (err instanceof board.TeamNameError) return json(res, 400, { error: msg });
        if (msg.startsWith('no such team member')) return json(res, 404, { error: msg });
        return json(res, 500, { error: msg });
      }
    }
  }
  const avatarMatch = pathname.match(/^\/team\/([^/]+)\/avatar$/);
  if (avatarMatch && (method === 'POST' || method === 'DELETE')) {
    if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' });
    const id = avatarMatch[1];
    const member = board.listTeam(db).find((m) => m.id === id);
    if (!member) return json(res, 404, { error: `no such team member: ${id}` });
    if (method === 'DELETE') {
      removeAvatarFile(member.avatar);
      return json(res, 200, board.setTeamAvatar(db, id, null));
    }
    const type = AVATAR_TYPES[String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()];
    if (!type) return json(res, 400, { error: 'content-type must be image/png, image/jpeg or image/webp' });
    const bytes = await readRawBody(req, MAX_AVATAR_BYTES);
    if (!type.matches(bytes)) return json(res, 400, { error: 'image bytes do not match content-type' });
    // Re-read after the (async) body read: the member may have been deleted or
    // given another avatar meanwhile.
    const current = board.listTeam(db).find((m) => m.id === id);
    if (!current) return json(res, 404, { error: `no such team member: ${id}` });
    const fileName = `${id}-${randomBytes(8).toString('hex')}.${type.ext}`;
    if (!AVATAR_NAME.test(fileName)) return json(res, 400, { error: 'invalid member id' });
    mkdirSync(AVATAR_DIR, { recursive: true });
    writeFileSync(join(AVATAR_DIR, fileName), bytes);
    let updated;
    try {
      updated = board.setTeamAvatar(db, id, fileName);
    } catch (err) {
      removeAvatarFile(fileName); // no orphaned file
      throw err;
    }
    removeAvatarFile(current.avatar);
    return json(res, 200, updated);
  }
  if (method === 'GET' && pathname.startsWith('/avatars/')) {
    const name = pathname.slice('/avatars/'.length);
    const m = name.match(AVATAR_NAME);
    if (!m) return json(res, 404, { error: 'not found' });
    try {
      const content = await readFile(join(AVATAR_DIR, name));
      res.writeHead(200, {
        'content-type': AVATAR_MIME[m[1]],
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(content);
      return;
    } catch {
      return json(res, 404, { error: 'not found' });
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
      json(res, 200, { task_id: task.id, lane: task.lane });
      if (task.lane === 'done') recountCard(task); // merged by now: final numbers from the merge commit
      return;
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
      // Lines are the card's whole change, not this run's: recountCard moves them
      // onto this (latest) row and zeroes earlier runs, so rebuilds don't double count.
      const task = board.getTask(db, taskId);
      const startEv = db
        .prepare(`SELECT created_at AS t FROM task_events WHERE task_id = ? AND type = 'build_start' ORDER BY id DESC LIMIT 1`)
        .get(taskId) as { t: number } | undefined;
      board.recordActivity(db, {
        project_id: task.project_id,
        task_id: taskId,
        // credit the card's team member; the hook's agent is the subagent type (the role)
        agent: task.assigned_agent ? board.memberName(db, task.assigned_agent) : (b.agent ?? null),
        role: b.role ?? b.agent ?? null,
        agent_id: b.agent_id,
        tokens: Number(b.tokens) || 0,
        tokens_out: Number(b.tokens_out) || 0,
        lines_added: 0,
        lines_removed: 0,
        ms: startEv ? Date.now() - startEv.t : 0,
      });
      json(res, 200, { ok: true });
      return recountCard(task);
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
    // A subagent's pings only name its card when the path shows up in the tool
    // input; carry its last known card forward so it stays attributed.
    if (status.task_id === null && b.agent_id) {
      const prev = states.view(b.project_id, now).agents.find((a) => a.agent_id === b.agent_id);
      if (prev) status.task_id = prev.task_id;
    }
    if (status.agent === 'orchestrator') {
      const wasIdle = states.view(b.project_id, now).main?.verb === 'idle';
      if (status.verb !== 'idle') mainIdleStart.delete(b.project_id);
      else if (!wasIdle || !mainIdleStart.has(b.project_id)) mainIdleStart.set(b.project_id, now);
    }
    states.record(b.project_id, { ...status, agent_id: b.agent_id ?? null, at: now });
    broadcaster.send(b.project_id, {
      type: 'status',
      project_id: b.project_id,
      status,
      session: states.view(b.project_id, now),
    });
    if (AUTOPILOT_ENGINE && status.agent === 'orchestrator' && status.verb === 'idle') void evaluateAutopilot(b.project_id);
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
const intervals: NodeJS.Timeout[] = [];
if (process.env.KANKAN_DISPATCHER !== '0') {
  const dispatcher = new Dispatcher(db);
  intervals.push(setInterval(() => {
    dispatcher.runOnce().catch((err) => console.error(`dispatcher tick failed: ${(err as Error).message}`));
  }, 1000).unref());
}

// ── autopilot sweep ─────────────────────────────────────────────────
// Every 30s, re-evaluate projects that opted in (catches idle sessions whose
// idle ping arrived before a card was queued or before usage dropped).
if (AUTOPILOT_ENGINE) {
  intervals.push(setInterval(() => {
    const rows = db.prepare('SELECT id FROM projects WHERE autopilot = 1').all() as { id: string }[];
    for (const { id } of rows) void evaluateAutopilot(id);
  }, AUTOPILOT_INTERVAL_MS).unref());
}

// ── shutdown ────────────────────────────────────────────────────────
// Without this, a stopped daemon orphans every pty shell (and whatever runs
// in it, e.g. claude) — they get re-parented to PID 1 and live on invisibly.
// node-pty makes each shell a session/process-group leader; with job control
// the shell puts each job (e.g. claude) in its OWN process group, so we signal
// every process group on the shell's tty, not just the shell's.
const PTY_KILL_GRACE_MS = 500;
const SHUTDOWN_DEADLINE_MS = 3000;
let shuttingDown = false;

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    /* ESRCH: already gone */
  }
}

let ownPgid: number | undefined;
async function daemonPgid(): Promise<number> {
  if (ownPgid === undefined) {
    try {
      const g = Number((await execFileAsync('ps', ['-o', 'pgid=', '-p', String(process.pid)])).stdout.trim());
      if (g > 1) ownPgid = g;
    } catch {
      /* fall back below */
    }
  }
  return ownPgid ?? process.pid;
}

/** The session's shell, verified to still be ours (null → signal nothing for it). */
async function verifyShell(shellPid: number): Promise<ShellInfo> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'ppid=,pgid=,tty=', '-p', String(shellPid)]);
    return shellInfo(shellPid, stdout, process.pid);
  } catch {
    return null; // gone (or ps failed): don't guess
  }
}

/** Groups currently on `tty` — only ever queried for a real pty name, since
 *  `ps -t ??` could list terminal-less processes machine-wide. */
async function groupsOnTty(tty: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=,tty=', '-t', tty]);
    return ttyGroups(tty, stdout, await daemonPgid());
  } catch {
    return [];
  }
}

/** Every process group on the shell's tty (the shell's own included); [] if the pid isn't verifiably our shell. */
async function sessionGroups(shellPid: number): Promise<{ shellPid: number; tty: string | null; groups: number[] }> {
  const info = await verifyShell(shellPid);
  const onTty = info?.tty ? await groupsOnTty(info.tty) : [];
  return { shellPid, tty: info?.tty ?? null, groups: ptyGroups(shellPid, info, onTty, await daemonPgid()) };
}

/** SIGHUP every process group of these sessions' verified shells, then SIGKILL
 *  whatever is still verifiably ours after a grace period. */
async function killSessions(sessions: PtySession[]): Promise<void> {
  const targets = await Promise.all(sessions.map((s) => sessionGroups(s.proc.pid as number)));
  for (const t of targets) for (const g of t.groups) killGroup(g, 'SIGHUP');
  if (targets.some((t) => t.groups.length > 0)) {
    await new Promise((r) => setTimeout(r, PTY_KILL_GRACE_MS));
    for (const t of targets) {
      if (t.groups.length === 0) continue;
      // re-enumerate: only still-alive members of our tty (or our still-verified shell) get SIGKILL
      const current = t.tty ? await groupsOnTty(t.tty) : [];
      if ((await verifyShell(t.shellPid)) !== null) current.push(t.shellPid);
      for (const g of stillOurs(t.groups, current)) killGroup(g, 'SIGKILL');
    }
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();

  const sessions = [...ptySessions.values()];
  console.log(`closing ${sessions.length} terminal session(s)`);
  await killSessions(sessions);

  for (const t of intervals) clearInterval(t);
  for (const w of [wss, ptyWss]) {
    for (const client of w.clients) client.terminate();
    w.close();
  }
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  try {
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
