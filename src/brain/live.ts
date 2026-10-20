// Local "live" apps: each project's main branch running on this Mac, reachable
// at http://<slug>.localhost:<daemon port> (other services at
// <service>.<slug>.localhost). The user starts, pauses, resumes and stops it;
// everything else is automatic: installing when the lockfile changes, running
// setup (migrations), creating databases on registered servers, restarting
// after a merge or a crash (giving up after 3 crashes in 10 minutes and telling
// the PM), and bringing running apps back after a restart.
//
// How to run a project comes from <project>/.drydock/run.json (written by the
// developer agent, see save_run_recipe), or is detected for common stacks.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import type { DB } from '../core/db.js';
import { createTask } from '../core/board.js';
import { getBus, isShuttingDown } from './bus.js';
import { addMessage, getConversation } from './chat.js';
import { projectRef } from './pipeline.js';
import { respond } from './runner.js';
import { addMissingColumns, defineSchema } from './schema.js';
import { cli, confirmOnMac, getSecret, readSecrets, redact, secretSettings } from './secrets.js';
import { dockerStart, dockerStop, freePort, projectDatabases, resolveNeed, type Need } from './services.js';
import { getSetting } from './settings.js';
import { notify } from './usage.js';
import { currentWorkspace, dataDir, isInside } from './workspace.js';

defineSchema(`
CREATE TABLE IF NOT EXISTS live_apps (
  project_id TEXT PRIMARY KEY,
  desired    TEXT NOT NULL DEFAULT 'stopped',  -- running | paused | stopped
  approved   TEXT NOT NULL DEFAULT '[]',       -- secret names the user let this app use
  lock_hash  TEXT,                             -- dependencies last installed for
  head       TEXT,                             -- git HEAD last started
  ports      TEXT NOT NULL DEFAULT '{}',       -- service -> port, kept stable
  pgids      TEXT NOT NULL DEFAULT '[]',       -- process groups, to clean up after a crash of Drydock itself
  updated_at INTEGER NOT NULL
);
`,
  // the run recipe the user last started by hand: changed commands wait for them
  (db) => addMissingColumns(db, 'live_apps', { recipe_ok: 'TEXT' }),
);

// ── recipe ───────────────────────────────────────────────────────

export interface ServiceSpec {
  name: string;
  command: string;
  cwd?: string;
  /** path that answers once it is up; default "/" */
  health?: string;
  primary?: boolean;
}
export interface Recipe {
  kind: 'web' | 'app' | 'none';
  install?: string;
  setup?: string;
  /** checks a card must pass before it merges (brain verify), e.g. "npm run lint && npm test" */
  verify?: string;
  services?: ServiceSpec[];
  /** kind "app": build and open it (a Mac app, a simulator) */
  launch?: string;
  needs?: Need[];
  secrets?: string[];
  env?: Record<string, string>;
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const ENV = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Throws a readable message for a bad recipe. */
export function validateRecipe(r: any, root: string): Recipe {
  const bad = (m: string) => {
    throw new Error(`run.json: ${m}`);
  };
  if (!r || typeof r !== 'object') bad('must be an object');
  if (!['web', 'app', 'none'].includes(r.kind)) bad('kind must be "web", "app" or "none"');
  for (const k of ['install', 'setup', 'launch', 'verify'] as const) if (r[k] !== undefined && typeof r[k] !== 'string') bad(`${k} must be a command string`);
  if (r.kind === 'web') {
    if (!Array.isArray(r.services) || !r.services.length) bad('a web project needs services: [{ name, command }]');
    const names = new Set<string>();
    for (const s of r.services) {
      if (!NAME.test(s?.name ?? '')) bad(`service name "${s?.name}" must be lowercase letters, digits and dashes`);
      if (names.has(s.name)) bad(`two services are called ${s.name}`);
      names.add(s.name);
      if (typeof s.command !== 'string' || !s.command.trim()) bad(`service ${s.name} needs a command (it gets its port as $PORT)`);
      if (s.cwd !== undefined && !isInside(root, resolve(root, s.cwd))) bad(`service ${s.name}: cwd must stay inside the project`);
      if (s.health !== undefined && !/^\//.test(s.health)) bad(`service ${s.name}: health must be a path like /health`);
    }
    if (r.services.filter((s: ServiceSpec) => s.primary).length > 1) bad('only one service can be primary');
  }
  if (r.kind === 'app' && !r.launch) bad('an app project needs launch: the command that builds and opens it');
  for (const n of r.needs ?? []) if (!n?.type || !ENV.test(n.as ?? '')) bad('needs entries are { "type": "postgres", "as": "DATABASE_URL" }');
  for (const n of r.secrets ?? []) if (!ENV.test(n)) bad(`secret "${n}" is not an UPPER_SNAKE name`);
  for (const [k, v] of Object.entries(r.env ?? {})) if (!ENV.test(k) || typeof v !== 'string') bad(`env ${k} must be an UPPER_SNAKE name with a string value`);
  return r as Recipe;
}

const has = (root: string, f: string) => existsSync(join(root, f));

/** A best guess for common stacks; the developer agent can write run.json to override. */
export function detectRecipe(root: string): Recipe | null {
  if (has(root, 'package.json')) {
    let pkg: any = {};
    try {
      pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : 'npm';
    let command: string | null = null;
    if (deps.next) command = 'npx next dev -p $PORT -H 127.0.0.1';
    else if (deps.vite && pkg.scripts?.dev?.includes('vite')) command = 'npx vite --port $PORT --strictPort --host 127.0.0.1';
    else if (pkg.scripts?.dev) command = `${pm} run dev`;
    else if (pkg.scripts?.start) command = `${pm} start`;
    if (!command) return null;
    return { kind: 'web', install: `${pm} install`, services: [{ name: 'web', command, primary: true }] };
  }
  if (has(root, 'pubspec.yaml') && readFileSync(join(root, 'pubspec.yaml'), 'utf8').includes('flutter')) {
    return { kind: 'web', install: 'flutter pub get', services: [{ name: 'web', command: 'flutter run -d web-server --web-port $PORT --web-hostname 127.0.0.1', primary: true }] };
  }
  if (has(root, 'manage.py')) {
    return { kind: 'web', install: has(root, 'requirements.txt') ? 'python3 -m pip install -r requirements.txt' : undefined, setup: 'python3 manage.py migrate', services: [{ name: 'web', command: 'python3 manage.py runserver 127.0.0.1:$PORT', primary: true }] };
  }
  return null;
}

export function readRecipe(root: string): { recipe: Recipe | null; source: 'file' | 'detected' | null; error?: string } {
  const file = join(dataDir(root), 'run.json');
  if (existsSync(file)) {
    try {
      return { recipe: validateRecipe(JSON.parse(readFileSync(file, 'utf8')), root), source: 'file' };
    } catch (e) {
      return { recipe: null, source: 'file', error: (e as Error).message };
    }
  }
  const d = detectRecipe(root);
  return { recipe: d, source: d ? 'detected' : null };
}

export function saveRecipe(root: string, recipe: unknown): Recipe {
  const r = validateRecipe(recipe, root);
  mkdirSync(dataDir(root), { recursive: true });
  writeFileSync(join(dataDir(root), 'run.json'), JSON.stringify(r, null, 2) + '\n');
  return r;
}

// ── state ────────────────────────────────────────────────────────

export type LiveStatus = 'stopped' | 'installing' | 'starting' | 'live' | 'paused' | 'crashed' | 'error' | 'needs_approval' | 'launched';

interface Svc {
  spec: ServiceSpec;
  port: number;
  child: ChildProcess | null;
  status: 'starting' | 'live' | 'stopped' | 'paused' | 'crashed';
  restarts: number[];
  log: string[];
  timer: NodeJS.Timeout | null;
}
interface App {
  projectId: string;
  slug: string;
  name: string;
  root: string;
  status: LiveStatus;
  message: string | null;
  services: Map<string, Svc>;
  env: Record<string, string>;
  secretValues: string[];
  stopping: boolean;
  startedAt: number | null;
  lastHit: number;
  needsApproval: string[];
  log: string[]; // install/setup/launch output
  busy: boolean; // a start is in progress
}

const apps = new Map<string, App>();
const LOG_LINES = 400;

export interface LiveSettings {
  maxRunning: number;
  /** pause an app nobody opened for this many hours; 0 = never */
  idleHours: number;
}
export const liveSettings = (db: DB): LiveSettings => ({ maxRunning: 6, idleHours: 0, ...getSetting<Partial<LiveSettings>>(db, 'brain.live', {}) });

const row = (db: DB, projectId: string) =>
  (db.prepare('SELECT * FROM live_apps WHERE project_id = ?').get(projectId) as any) ?? { project_id: projectId, desired: 'stopped', approved: '[]', lock_hash: null, head: null, ports: '{}', pgids: '[]', recipe_ok: null };
function saveRow(db: DB, projectId: string, patch: Record<string, unknown>) {
  const cur = { ...row(db, projectId), ...patch, updated_at: Date.now() };
  db.prepare(
    `INSERT INTO live_apps (project_id, desired, approved, lock_hash, head, ports, pgids, recipe_ok, updated_at) VALUES (@project_id, @desired, @approved, @lock_hash, @head, @ports, @pgids, @recipe_ok, @updated_at)
     ON CONFLICT(project_id) DO UPDATE SET desired = excluded.desired, approved = excluded.approved, lock_hash = excluded.lock_hash, head = excluded.head, ports = excluded.ports, pgids = excluded.pgids, recipe_ok = excluded.recipe_ok, updated_at = excluded.updated_at`,
  ).run(cur);
}

const emit = (projectId: string) => {
  try {
    getBus().emit({ type: 'live', project_id: projectId });
  } catch {
    /* tests without a bus */
  }
};

function appFor(db: DB, projectId: string): App {
  let a = apps.get(projectId);
  if (!a) {
    const ref = projectRef(db, projectId);
    a = { projectId, slug: ref.slug, name: ref.name, root: ref.root, status: 'stopped', message: null, services: new Map(), env: {}, secretValues: [], stopping: false, startedAt: null, lastHit: Date.now(), needsApproval: [], log: [], busy: false };
    apps.set(projectId, a);
  }
  return a;
}

function logTo(a: App, lines: string[], text: string, svc?: string) {
  const clean = redact(text, a.secretValues);
  for (const l of clean.split('\n')) if (l.trim()) lines.push(svc ? `[${svc}] ${l}` : l);
  if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
  const ws = currentWorkspace();
  if (ws) {
    const dir = join(ws.data, 'logs', 'live');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${a.slug}.log`), clean.endsWith('\n') ? clean : clean + '\n');
  }
}

/** The environment apps get: a clean base (not Drydock's own env), the recipe's values, secrets, ports. */
function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];
  return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pubspec.lock', 'requirements.txt', 'poetry.lock', 'Pipfile.lock', 'Gemfile.lock', 'go.sum', 'Cargo.lock'];
function lockHash(root: string, recipe: Recipe): string {
  const h = createHash('sha1').update(recipe.install ?? '');
  for (const dir of new Set([root, ...(recipe.services ?? []).map((s) => resolve(root, s.cwd ?? '.'))]))
    for (const f of LOCKFILES) if (existsSync(join(dir, f))) h.update(f).update(readFileSync(join(dir, f)));
  if (existsSync(join(root, 'package.json')) && !existsSync(join(root, 'node_modules'))) h.update('missing node_modules');
  return h.digest('hex');
}

async function gitHead(root: string): Promise<string | null> {
  const r = await cli('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Run a one-off step (install, setup, launch) with the app's env, logging its output. */
function runStep(a: App, command: string, cwd: string, timeoutMs = 15 * 60_000): Promise<number> {
  return new Promise((done) => {
    logTo(a, a.log, `$ ${command}`);
    const child = spawn('/bin/bash', ['-lc', command], { cwd, env: a.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => logTo(a, a.log, String(d)));
    child.stderr.on('data', (d) => logTo(a, a.log, String(d)));
    child.on('error', (e) => (clearTimeout(timer), logTo(a, a.log, e.message), done(127)));
    child.on('close', (code) => (clearTimeout(timer), done(code ?? 1)));
  });
}

const killGroup = (pid: number | undefined, sig: NodeJS.Signals) => {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    /* already gone */
  }
};

// ── lifecycle ────────────────────────────────────────────────────

export interface StartResult {
  status: LiveStatus;
  needsApproval?: string[];
  message?: string | null;
}

/**
 * Start (or restart) a project's app. `by` is who asked: the user's button may
 * approve new secrets (`approve`); automatic restarts and agents may only use
 * secrets the user already approved.
 */
export async function startApp(db: DB, projectId: string, opts: { by: 'user' | 'auto' | 'agent'; approve?: string[] } = { by: 'user' }): Promise<StartResult> {
  const a = appFor(db, projectId);
  if (a.busy) return { status: a.status, message: 'Already starting.' };
  a.busy = true;
  try {
    return await start(db, a, opts);
  } finally {
    a.busy = false;
  }
}

async function start(db: DB, a: App, opts: { by: 'user' | 'auto' | 'agent'; approve?: string[] }): Promise<StartResult> {
  const projectId = a.projectId;
  const fail = (status: LiveStatus, message: string): StartResult => {
    a.status = status;
    a.message = message;
    emit(projectId);
    return { status, message };
  };
  const { recipe, error } = readRecipe(a.root);
  if (error) return fail('error', error);
  if (!recipe || recipe.kind === 'none') return fail('stopped', 'Not runnable yet: no run recipe. The developer adds .drydock/run.json (save_run_recipe).');
  // the recipe's commands run on this Mac: new or changed ones run only after the user starts it once by hand
  const fingerprint = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
  if (opts.by !== 'user' && row(db, projectId).recipe_ok !== fingerprint) {
    a.needsApproval = [];
    return fail('needs_approval', 'Its run commands are new or changed. Press Start to check and run them; after that it restarts by itself again.');
  }
  const running = [...apps.values()].filter((x) => x.projectId !== projectId && ['live', 'starting', 'installing', 'paused'].includes(x.status)).length;
  if (running >= liveSettings(db).maxRunning) return fail('error', `${running} apps are already running (your limit). Stop one first, or raise the limit in Settings › Local services.`);

  if (a.services.size) await stopApp(db, projectId, { keepDesired: true });
  a.log = [];
  a.message = null;

  // databases and other services the recipe needs
  const needed: { as: string; secret: string }[] = [];
  try {
    for (const n of recipe.needs ?? []) needed.push(await resolveNeed(db, { id: projectId, slug: a.slug }, n));
  } catch (e) {
    return fail('error', (e as Error).message);
  }
  const secretNames = [...new Set([...(recipe.secrets ?? []), ...needed.map((n) => n.secret)])];
  const missing = secretNames.filter((n) => !getSecret(db, n));
  if (missing.length) return fail('error', `Missing secrets: ${missing.join(', ')}. Add them in Settings › Secrets.`);
  const r = row(db, projectId);
  let approved = new Set<string>(JSON.parse(r.approved));
  if (opts.by === 'user' && opts.approve?.length) {
    const adding = opts.approve.filter((n) => secretNames.includes(n) && !approved.has(n));
    // the user's own confirmation on this Mac, when they asked for it (Settings › Secrets)
    if (adding.length && secretSettings(db).confirmOnMac) {
      try {
        await confirmOnMac(`let ${a.slug} use ${adding.join(', ')}`);
      } catch (e) {
        return fail('needs_approval', (e as Error).message);
      }
    }
    approved = new Set([...approved, ...adding]);
  }
  const unapproved = secretNames.filter((n) => !approved.has(n));
  if (unapproved.length) {
    a.needsApproval = unapproved;
    saveRow(db, projectId, { approved: JSON.stringify([...approved]) });
    return { ...fail('needs_approval', `Approve the secrets this app may use: ${unapproved.join(', ')}`), needsApproval: unapproved };
  }
  a.needsApproval = [];
  saveRow(db, projectId, { approved: JSON.stringify([...approved]), desired: 'running', ...(opts.by === 'user' ? { recipe_ok: fingerprint } : {}) });

  let values: Record<string, string>;
  try {
    values = await readSecrets(db, secretNames);
  } catch (e) {
    return fail('error', (e as Error).message);
  }
  for (const d of projectDatabases(db, projectId)) if (d.service_id.startsWith('docker:')) await dockerStart(d.db_name, d.service_id.slice(7));
  a.secretValues = Object.values(values);
  const secretEnv: Record<string, string> = Object.fromEntries((recipe.secrets ?? []).map((n) => [n, values[n]]));
  for (const n of needed) secretEnv[n.as] = values[n.secret];

  // stable ports, and each service told where the others are
  const ports: Record<string, number> = JSON.parse(r.ports);
  const specs = recipe.kind === 'web' ? recipe.services! : [];
  for (const s of specs) if (!ports[s.name] || !(await portFree(ports[s.name]))) ports[s.name] = await freePort();
  const peers: Record<string, string> = {};
  for (const s of specs) {
    const key = s.name.toUpperCase().replace(/-/g, '_');
    peers[`${key}_PORT`] = String(ports[s.name]);
    peers[`${key}_URL`] = `http://127.0.0.1:${ports[s.name]}`;
  }
  a.env = { ...baseEnv(), ...recipe.env, ...peers, ...secretEnv, HOST: '127.0.0.1' };

  // dependencies, when they changed
  const hash = lockHash(a.root, recipe);
  if (recipe.install && hash !== r.lock_hash) {
    a.status = 'installing';
    emit(projectId);
    if ((await runStep(a, recipe.install, a.root)) !== 0) return fail('error', 'Installing dependencies failed. See the log.');
    saveRow(db, projectId, { lock_hash: lockHash(a.root, recipe) });
  }
  a.status = 'starting';
  emit(projectId);
  if (recipe.setup && (await runStep(a, recipe.setup, a.root)) !== 0) return fail('error', 'The setup step (e.g. migrations) failed. See the log.');
  saveRow(db, projectId, { head: await gitHead(a.root), ports: JSON.stringify(ports) });

  if (recipe.kind === 'app') {
    const code = await runStep(a, recipe.launch!, a.root);
    saveRow(db, projectId, { desired: 'stopped' });
    return code === 0 ? fail('launched', 'Built and opened.') : fail('error', 'Launch failed. See the log.');
  }

  a.stopping = false;
  a.startedAt = Date.now();
  a.lastHit = Date.now();
  for (const spec of specs) spawnService(db, a, { spec, port: ports[spec.name], child: null, status: 'starting', restarts: [], log: [], timer: null });
  emit(projectId);
  return { status: a.status };
}

const portFree = (port: number) =>
  new Promise<boolean>((done) => {
    const s = connect({ host: '127.0.0.1', port }, () => (s.destroy(), done(false)));
    s.on('error', () => done(true));
  });

function spawnService(db: DB, a: App, svc: Svc) {
  a.services.set(svc.spec.name, svc);
  svc.status = 'starting';
  const child = spawn('/bin/bash', ['-lc', svc.spec.command], { cwd: resolve(a.root, svc.spec.cwd ?? '.'), env: { ...a.env, PORT: String(svc.port) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  svc.child = child;
  child.stdout?.on('data', (d) => logTo(a, svc.log, String(d), svc.spec.name));
  child.stderr?.on('data', (d) => logTo(a, svc.log, String(d), svc.spec.name));
  child.on('error', (e) => logTo(a, svc.log, e.message, svc.spec.name));
  child.on('exit', (code, signal) => onExit(db, a, svc, code, signal));
  saveRow(db, a.projectId, { pgids: JSON.stringify([...a.services.values()].filter((s) => s.child?.pid).map((s) => ({ pid: s.child!.pid, cmd: s.spec.command }))) });
  waitHealthy(a, svc);
  refresh(a);
}

function waitHealthy(a: App, svc: Svc) {
  const until = Date.now() + 180_000;
  const tick = () => {
    if (svc.status !== 'starting' || a.stopping) return;
    const req = request({ host: '127.0.0.1', port: svc.port, path: svc.spec.health ?? '/', method: 'GET', timeout: 3000 }, (res) => {
      res.resume();
      if ((res.statusCode ?? 500) < 500) {
        svc.status = 'live';
        refresh(a);
      } else again();
    });
    req.on('error', again);
    req.on('timeout', () => req.destroy());
    req.end();
  };
  const again = () => {
    if (Date.now() > until) {
      a.message = `${svc.spec.name} is not answering on port ${svc.port} after 3 minutes. See the log.`;
      refresh(a);
      return;
    }
    svc.timer = setTimeout(tick, 1000);
  };
  svc.timer = setTimeout(tick, 500);
}

/** Overall status from the services. */
function refresh(a: App) {
  const s = [...a.services.values()];
  if (!s.length) return emit(a.projectId);
  if (s.some((x) => x.status === 'crashed')) a.status = 'crashed';
  else if (s.every((x) => x.status === 'paused')) a.status = 'paused';
  else if (s.every((x) => x.status === 'live')) a.status = 'live';
  else if (s.some((x) => x.status === 'starting')) a.status = 'starting';
  emit(a.projectId);
}

const CRASH_WINDOW = 10 * 60_000;
function onExit(db: DB, a: App, svc: Svc, code: number | null, signal: NodeJS.Signals | null) {
  if (svc.timer) clearTimeout(svc.timer);
  svc.child = null;
  if (a.stopping || isShuttingDown()) {
    svc.status = 'stopped';
    return;
  }
  logTo(a, svc.log, `exited (${signal ?? `code ${code}`})`, svc.spec.name);
  svc.restarts = svc.restarts.filter((t) => Date.now() - t < CRASH_WINDOW);
  if (svc.restarts.length < 3) {
    svc.restarts.push(Date.now());
    const delay = 2000 * 2 ** (svc.restarts.length - 1);
    svc.status = 'starting';
    refresh(a);
    svc.timer = setTimeout(() => !a.stopping && spawnService(db, a, svc), delay);
    return;
  }
  svc.status = 'crashed';
  a.message = `${svc.spec.name} crashed 3 times in 10 minutes and was left stopped.`;
  refresh(a);
  reportCrash(db, a, svc);
}

/** Tell the PM (build thread, with a card) and the user. */
function reportCrash(db: DB, a: App, svc: Svc) {
  notify('Drydock', `${a.name}: ${svc.spec.name} keeps crashing`);
  const tail = svc.log.slice(-25).join('\n');
  const build = `ch:${a.slug}-build`;
  if (!getConversation(db, build)) {
    addMessage(db, 'dm:main', 'main', `**${a.name}** crashed on this Mac (${svc.spec.name}, 3 times in 10 minutes). It is stopped; the log is on the project page.`);
    return;
  }
  let card = '';
  try {
    card = createTask(db, a.projectId, `Fix crash: ${svc.spec.name} keeps exiting`, { tag: 'infra', requirements: `The locally running app (${svc.spec.name}) crashed 3 times in 10 minutes after the latest merge.\n\nLast log lines:\n\n\`\`\`\n${tail}\n\`\`\`` }).id;
  } catch {
    /* no board for this project */
  }
  const text = `@PM ${a.name} crashed on this Mac: ${svc.spec.name} exited 3 times in 10 minutes and is stopped.${card ? ` I added card ${card} with the log.` : ''} Find the cause, fix it, and restart it with live_restart once merged.\n\n\`\`\`\n${tail.slice(-1500)}\n\`\`\``;
  addMessage(db, build, 'main', text);
  respond(build, text);
}

export async function stopApp(db: DB, projectId: string, opts: { keepDesired?: boolean } = {}): Promise<void> {
  const a = apps.get(projectId);
  if (!opts.keepDesired) saveRow(db, projectId, { desired: 'stopped' });
  if (!a) return;
  a.stopping = true;
  const kids = [...a.services.values()];
  for (const s of kids) {
    if (s.timer) clearTimeout(s.timer);
    killGroup(s.child?.pid, 'SIGCONT');
    killGroup(s.child?.pid, 'SIGTERM');
  }
  await Promise.all(
    kids.map(
      (s) =>
        new Promise<void>((done) => {
          if (!s.child) return done();
          const t = setTimeout(() => (killGroup(s.child?.pid, 'SIGKILL'), done()), 5000);
          s.child.once('exit', () => (clearTimeout(t), done()));
        }),
    ),
  );
  a.services.clear();
  a.status = 'stopped';
  a.startedAt = null;
  saveRow(db, projectId, { pgids: '[]' });
  if (!opts.keepDesired) for (const d of projectDatabases(db, projectId)) if (d.service_id.startsWith('docker:')) await dockerStop(d.db_name, d.service_id.slice(7));
  emit(projectId);
}

export function pauseApp(db: DB, projectId: string): void {
  const a = apps.get(projectId);
  if (!a || !['live', 'starting'].includes(a.status)) throw new Error('It is not running.');
  for (const s of a.services.values()) {
    if (s.timer) clearTimeout(s.timer);
    killGroup(s.child?.pid, 'SIGSTOP');
    s.status = 'paused';
  }
  saveRow(db, projectId, { desired: 'paused' });
  refresh(a);
}

export function resumeApp(db: DB, projectId: string): void {
  const a = apps.get(projectId);
  if (!a || a.status !== 'paused') throw new Error('It is not paused.');
  for (const s of a.services.values()) {
    killGroup(s.child?.pid, 'SIGCONT');
    s.status = 'starting';
    waitHealthy(a, s);
  }
  a.lastHit = Date.now();
  saveRow(db, projectId, { desired: 'running' });
  refresh(a);
}

/** What the project page shows. */
export function appStatus(db: DB, projectId: string) {
  const a = apps.get(projectId);
  let ref;
  try {
    ref = projectRef(db, projectId);
  } catch {
    return null;
  }
  const { recipe, source, error } = readRecipe(ref.root);
  const daemon = (() => {
    try {
      return new URL(getBus().daemonUrl).port;
    } catch {
      return '7900';
    }
  })();
  const services = recipe?.kind === 'web' ? recipe.services! : [];
  const primary = services.find((s) => s.primary) ?? services[0];
  const ports: Record<string, number> = JSON.parse(row(db, projectId).ports);
  return {
    status: a?.status ?? 'stopped',
    message: a?.message ?? (error ?? null),
    kind: recipe?.kind ?? null,
    recipe: source,
    runnable: Boolean(recipe && recipe.kind !== 'none'),
    startedAt: a?.startedAt ?? null,
    needsApproval: a?.needsApproval ?? [],
    approved: JSON.parse(row(db, projectId).approved) as string[],
    secrets: [...new Set([...(recipe?.secrets ?? [])])],
    needs: recipe?.needs ?? [],
    services: services.map((s) => ({
      name: s.name,
      primary: s === primary,
      status: a?.services.get(s.name)?.status ?? 'stopped',
      port: a?.services.get(s.name)?.port ?? ports[s.name] ?? null,
      url: `http://${s === primary ? '' : `${s.name}.`}${ref.slug}.localhost:${daemon}`,
    })),
    databases: projectDatabases(db, projectId).map((d) => ({ id: d.id, as: d.as_name, name: d.db_name, where: d.service_id.startsWith('docker:') ? 'Docker' : d.service_name ?? 'removed server', type: d.type ?? d.service_id.slice(7) })),
  };
}

/**
 * Smoke-test the running app: GET each path on a service and report status,
 * time, size and the page title (or the start of an error body). Cheap and
 * deterministic: what QC runs after a merge before anything heavier.
 */
export async function checkApp(projectId: string, paths: string[], service?: string): Promise<{ ok: boolean; results: { path: string; status: number | null; ms: number; bytes: number; title: string | null; error: string | null }[]; message?: string }> {
  const a = apps.get(projectId);
  const svcs = a ? [...a.services.values()] : [];
  const svc = service ? a?.services.get(service) : (svcs.find((s) => s.spec.primary) ?? svcs[0]);
  if (!a || !svc || a.status !== 'live') return { ok: false, results: [], message: `Not live (${a?.status ?? 'stopped'}). Start it from the project overview, or live_restart.` };
  const results = [];
  for (const path of paths.slice(0, 20)) {
    const t0 = Date.now();
    const r = await new Promise<{ status: number | null; body: string; error: string | null }>((done) => {
      const req = request({ host: '127.0.0.1', port: svc.port, path: path.startsWith('/') ? path : `/${path}`, method: 'GET', timeout: 15_000, headers: { accept: 'text/html,application/json,*/*' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => body.length < 200_000 && (body += c));
        res.on('end', () => done({ status: res.statusCode ?? null, body, error: null }));
      });
      req.on('timeout', () => req.destroy(new Error('timed out after 15s')));
      req.on('error', (e) => done({ status: null, body: '', error: e.message }));
      req.end();
    });
    const title = /<title[^>]*>([^<]{0,120})<\/title>/i.exec(r.body)?.[1]?.trim() ?? null;
    const bad = r.status === null || r.status >= 400;
    results.push({ path, status: r.status, ms: Date.now() - t0, bytes: r.body.length, title, error: r.error ?? (bad ? redact(r.body.replace(/\s+/g, ' ').slice(0, 300), a.secretValues) : null) });
  }
  return { ok: results.every((r) => r.status !== null && r.status < 400), results };
}

export function appLogs(projectId: string, service?: string, lines = 200): string {
  const a = apps.get(projectId);
  if (!a) return '';
  const parts = service ? [a.services.get(service)?.log ?? []] : [a.log, ...[...a.services.values()].map((s) => s.log)];
  return parts.flat().slice(-lines).join('\n');
}

export const runningCount = () => [...apps.values()].filter((a) => ['live', 'starting', 'installing', 'paused'].includes(a.status)).length;
export const runningApps = () => [...apps.values()].filter((a) => ['live', 'starting', 'installing', 'paused', 'crashed'].includes(a.status)).map((a) => ({ project_id: a.projectId, name: a.name, slug: a.slug, status: a.status }));

// ── automation ───────────────────────────────────────────────────

/** Every 15 s: restart after a merge (new HEAD on main), and pause apps idle past the limit. */
export function startLiveWatcher(): NodeJS.Timeout {
  let busy = false;
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const db = getBus().db();
      const idle = liveSettings(db).idleHours;
      for (const a of apps.values()) {
        if (a.status === 'live' && idle > 0 && Date.now() - a.lastHit > idle * 3_600_000) pauseApp(db, a.projectId);
        if (!['live', 'crashed'].includes(a.status)) continue;
        const head = await gitHead(a.root);
        if (head && head !== row(db, a.projectId).head) {
          logTo(a, a.log, `new commit ${head.slice(0, 8)} on main: restarting`);
          await startApp(db, a.projectId, { by: 'auto' });
        }
      }
    } catch (e) {
      console.error(`live watcher: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, Number(process.env.BRAIN_LIVE_TICK_MS) || 15_000);
}

const BOOTED = Date.now();

/** A process group left by a previous run, if it is still the same command (pids get reused). */
async function stillOurs(pid: number, cmd: string): Promise<boolean> {
  const r = await cli('/bin/ps', ['-o', 'command=', '-p', String(pid)]);
  return r.code === 0 && r.stdout.includes(cmd.slice(0, 60));
}

/** On daemon start: clear leftovers from the previous run, then bring back what was running. */
export async function restoreApps(db: DB): Promise<void> {
  const rows = (db.prepare("SELECT project_id, desired, pgids FROM live_apps WHERE (desired != 'stopped' OR pgids != '[]') AND updated_at < ?").all(BOOTED) as { project_id: string; desired: string; pgids: string }[]).filter((r) => !apps.has(r.project_id));
  for (const r of rows) for (const g of JSON.parse(r.pgids) as { pid: number; cmd: string }[]) if (g?.pid && (await stillOurs(g.pid, g.cmd))) killGroup(g.pid, 'SIGKILL');
  for (const r of rows) {
    if (apps.has(r.project_id)) continue; // the user started it meanwhile
    if (r.desired === 'running') await startApp(db, r.project_id, { by: 'auto' }).catch((e) => console.error(`restore ${r.project_id}: ${e.message}`));
    else saveRow(db, r.project_id, { desired: 'stopped', pgids: '[]' });
  }
}

/** On daemon shutdown: stop the processes but remember they should run, so restoreApps brings them back. */
export function stopAllForShutdown(): void {
  for (const a of apps.values()) {
    a.stopping = true;
    for (const s of a.services.values()) {
      killGroup(s.child?.pid, 'SIGCONT');
      killGroup(s.child?.pid, 'SIGTERM');
    }
  }
}

// ── the *.localhost proxy ────────────────────────────────────────

/** <service>.<slug>.localhost or <slug>.localhost → that service's port, or null when the host is not an app. */
function target(host: string | undefined): { a: App | null; port: number | null; slug: string } | null {
  const m = /^(?:([a-z0-9-]+)\.)?([a-z0-9-]+)\.localhost(?::\d+)?$/i.exec(host ?? '');
  if (!m) return null;
  const [, svcName, slug] = m;
  const a = [...apps.values()].find((x) => x.slug.toLowerCase() === slug.toLowerCase()) ?? null;
  if (!a) return { a: null, port: null, slug };
  const svcs = [...a.services.values()];
  const svc = svcName ? a.services.get(svcName.toLowerCase()) : (svcs.find((s) => s.spec.primary) ?? svcs[0]);
  a.lastHit = Date.now();
  return { a, port: svc && svc.status !== 'paused' ? svc.port : null, slug };
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;padding:48px;color:#333"><h2>${title}</h2><p>${body}</p><p><a href="javascript:location.reload()">Reload</a></p>`;

/** Handle a request for a running app. Returns false when the host is not an app (normal routing continues). */
export function proxyHttp(req: IncomingMessage, res: ServerResponse): boolean {
  const t = target(req.headers.host);
  if (!t) return false;
  if (!t.port) {
    res.writeHead(503, { 'content-type': 'text/html' }).end(page(`${t.a?.name ?? t.slug} is not running`, t.a?.status === 'paused' ? 'It is paused. Resume it from its project page in Drydock.' : 'Start it from its project page in Drydock.'));
    return true;
  }
  const up = request({ host: '127.0.0.1', port: t.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => !res.headersSent && res.writeHead(502, { 'content-type': 'text/html' }).end(page(`${t.a?.name ?? t.slug} is starting`, 'It is not answering yet. This page reloads when you try again.')));
  req.pipe(up);
  return true;
}

/** WebSocket upgrades (dev-server hot reload) for running apps. */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const t = target(req.headers.host);
  if (!t) return false;
  if (!t.port) {
    socket.destroy();
    return true;
  }
  const up = connect({ host: '127.0.0.1', port: t.port }, () => {
    const headers = Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]));
    up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  return true;
}

