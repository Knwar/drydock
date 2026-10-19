#!/usr/bin/env node
// brain CLI (Drydock's agent-facing commands, forked from kankanban; people use bin/drydock.js)
//   brain setup [folder]      choose the workspace folder (no folder: show it)
//   brain init [dir] [name]   set up a project (auto-starts the daemon)
//   brain update [dir]        re-sync kit files into a set-up project (overwrites kit-owned files)
//   brain info                project details for this folder
//   brain start               start daemon + show project details (set-up folders only)
//   brain stop                stop the daemon (set-up folders only)
//   brain restart             restart + show project details (set-up folders only)
//   brain worktree add|remove|merge <id> [--force]   per-card git worktree, run in the project
//   brain verify [id]                                the project's checks in a card's worktree
//   brain security-scan [dir]  dependency audit, secret scan, Semgrep if installed
//   brain recount-lines [--dry-run] [--db <path>]    recompute lines written per card from git history
//   brain daemon start|stop|restart|status|run   machine-level daemon management
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_URL = process.env.DAEMON_URL ?? 'http://localhost:7900';
const PORT = new URL(DAEMON_URL).port || '7900';
const DATA_DIR = process.env.BRAIN_HOME ?? join(homedir(), '.ai-brain');
const PID_FILE = join(DATA_DIR, 'daemon.pid');
const LOG_FILE = join(DATA_DIR, 'daemon.log');

// The daemon finds its DB itself (workspace, else bootstrap); DB_PATH only when set explicitly.
const daemonEnv = () => ({ ...process.env, PORT });
function workspaceRoot() {
  try {
    const ws = JSON.parse(readFileSync(join(process.env.BRAIN_HOME ?? DATA_DIR, 'config.json'), 'utf8')).workspace;
    return ws && existsSync(ws) ? ws : null;
  } catch {
    return null;
  }
}
const dbPath = () => {
  const ws = workspaceRoot();
  return process.env.DB_PATH ?? (ws ? join(ws, '.ai-brain', 'board.db') : join(DATA_DIR, 'bootstrap.db'));
};
const daemonCmd = () => [join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'daemon', 'server.ts')];

async function up() {
  try {
    // ask for something only this daemon answers (the bare address redirects to the app, and another program could hold the port)
    const res = await fetch(`${DAEMON_URL}/api/workspace`, { signal: AbortSignal.timeout(700) });
    return res.ok && 'configured' in (await res.json());
  } catch {
    return false;
  }
}

async function start() {
  if (await up()) {
    console.log(`daemon already running at ${DAEMON_URL}`);
    return true;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const [bin, entry] = daemonCmd();
  const child = spawn(bin, [entry], {
    cwd: ROOT,
    env: daemonEnv(),
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 20; i++) {
    if (await up()) {
      console.log(`daemon started at ${DAEMON_URL} (db: ${dbPath()})\napp:     ${DAEMON_URL}/app/`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`daemon failed to start — see ${LOG_FILE}`);
  return false;
}

function pidsOnPort() {
  try {
    // listeners only: a browser/client merely connected to the port must never be signalled
    return execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN']).toString().trim().split('\n').filter(Boolean);
  } catch {
    return []; // nothing listening
  }
}

async function stop() {
  const pids = new Set(pidsOnPort());
  if (existsSync(PID_FILE)) {
    pids.add(readFileSync(PID_FILE, 'utf8').trim());
    rmSync(PID_FILE, { force: true });
  }
  const alive = (pid) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  let stopped = false;
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM'); // graceful: the daemon closes its terminal sessions
      stopped = true;
    } catch {
      /* already gone */
    }
  }
  // wait for the graceful shutdown (it takes up to ~3s); SIGKILL only as the fallback
  for (const deadline = Date.now() + 4000; [...pids].some(alive) && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const pid of pids) {
    if (!alive(pid)) continue;
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* gone meanwhile */
    }
  }
  console.log(stopped ? 'daemon stopped' : 'daemon was not running');
  return stopped;
}

/** A folder counts as set up when its .mcp.json wires the board server (kankan in older installs). */
function isSetup(dir) {
  try {
    return Object.keys(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers ?? {}).some((n) => n === 'kanban' || n === 'kankan');
  } catch {
    return false;
  }
}

async function fetchJson(path) {
  try {
    const res = await fetch(`${DAEMON_URL}${path}`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function info(dir) {
  console.log(`root:      ${dir}`);
  if (!(await up())) {
    console.log(`daemon:    down — start it with: brain start`);
    return;
  }
  const project = await fetchJson(`/project?root=${encodeURIComponent(dir)}`);
  if (!project) {
    console.log(`daemon:    up at ${DAEMON_URL}, but project lookup failed`);
    return;
  }
  const board = (await fetchJson(`/board?project=${project.project_id}`)) ?? [];
  const lanes = ['backlog', 'queued', 'in_progress', 'in_review', 'done'];
  const counts = lanes.map((l) => `${l}:${board.filter((c) => c.lane === l).length}`).join('  ');
  console.log(`project:   ${project.name} (${project.project_id})`);
  console.log(`daemon:    up at ${DAEMON_URL}`);
  console.log(`app:       ${DAEMON_URL}/app/project/${project.project_id}`);
  console.log(`overlay:   ${DAEMON_URL}/?project=${project.project_id}`);
  console.log(`board:     ${counts}`);
  console.log(`data:      ${dbPath()}  log: ${LOG_FILE}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (['info', 'start', 'stop', 'restart'].includes(cmd)) {
    const dir = process.cwd();
    if (!isSetup(dir)) {
      console.error(`this folder is not set up for Drydock — run: brain init`);
      process.exit(1);
    }
    if (cmd === 'stop') {
      await stop();
      process.exit(0);
    }
    if (cmd === 'restart') {
      await stop();
      await new Promise((r) => setTimeout(r, 400));
      if (!(await start())) process.exit(1);
    }
    if (cmd === 'start' && !(await up()) && !(await start())) process.exit(1);
    await info(dir);
    process.exit(0);
  }

  // Choose the workspace folder (D9): everything Drydock makes lives inside it.
  if (cmd === 'setup') {
    if (!rest[0]) {
      const ws = workspaceRoot();
      console.log(ws ? `workspace: ${ws}` : 'no workspace yet — run: brain setup <folder>');
      process.exit(ws ? 0 : 1);
    }
    if (!(await up()) && !(await start())) process.exit(1);
    const res = await fetch(`${DAEMON_URL}/api/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: resolve(rest[0]) }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error(`setup failed: ${body.error}`);
      process.exit(1);
    }
    console.log(`workspace: ${body.root}\ndb:        ${body.db}`);
    process.exit(0);
  }

  if (cmd === 'init') {
    const target = resolve(rest[0] ?? process.cwd());
    if (!(await up()) && !(await start())) process.exit(1);
    const args = [join(ROOT, 'scripts', 'init-project.sh'), target];
    if (rest[1]) args.push(rest[1]);
    const res = spawnSync('sh', args, { stdio: 'inherit', env: { ...process.env, DAEMON_URL } });
    process.exit(res.status ?? 0);
  }

  if (cmd === 'update') {
    const target = resolve(rest[0] ?? process.cwd());
    if (!isSetup(target)) {
      console.error(`this folder is not set up for Drydock — run: brain init`);
      process.exit(1);
    }
    const res = spawnSync('sh', [join(ROOT, 'scripts', 'init-project.sh'), target], {
      stdio: 'inherit',
      env: { ...process.env, DAEMON_URL, KANKAN_UPDATE: '1' },
    });
    process.exit(res.status ?? 0);
  }

  // Automated security checks (dependency audit, secret scan, Semgrep if installed).
  if (cmd === 'security-scan') {
    const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'security-scan.js'), ...rest], { cwd: process.cwd(), stdio: 'inherit' });
    process.exit(res.status ?? 0);
  }

  // Per-card git worktree, run against the project in the current directory.
  // The script lives centrally (one source of truth); we just invoke it in cwd.
  // The project's checks (tests, lint, typecheck) in a card's worktree; merge runs them too.
  if (cmd === 'verify') {
    const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'worktree.js'), 'verify', rest[0] ?? '.'], { cwd: process.cwd(), stdio: 'inherit' });
    process.exit(res.status ?? 0);
  }

  if (cmd === 'worktree') {
    const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'worktree.js'), ...rest], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  }

  // Recompute per-card line counts from git (explicit, idempotent; --dry-run writes nothing).
  if (cmd === 'recount-lines') {
    const res = spawnSync(daemonCmd()[0], [join(ROOT, 'src', 'core', 'recount-lines.ts'), ...rest], {
      stdio: 'inherit',
      env: { ...daemonEnv(), DB_PATH: dbPath() },
    });
    if (res.error) console.error(res.error.message);
    process.exit(res.status ?? 1);
  }

  if (cmd === 'daemon') {
    const sub = rest[0] ?? 'status';
    if (sub === 'start') process.exit((await start()) ? 0 : 1);
    if (sub === 'stop') {
      await stop();
      process.exit(0);
    }
    if (sub === 'restart') {
      await stop();
      await new Promise((r) => setTimeout(r, 400)); // let the port free up
      process.exit((await start()) ? 0 : 1);
    }
    if (sub === 'status') {
      console.log((await up()) ? `daemon up at ${DAEMON_URL}` : 'daemon down');
      process.exit(0);
    }
    if (sub === 'run') {
      const [bin, entry] = daemonCmd();
      const res = spawnSync(bin, [entry], { cwd: ROOT, stdio: 'inherit', env: daemonEnv() });
      process.exit(res.status ?? 0);
    }
  }

  console.log(`usage:
  brain init [dir] [name]                 set up a project (auto-starts daemon)
  brain update [dir]                      re-sync kit files into a set-up project
  brain info                              project details for this folder
  brain start|stop|restart                daemon + project details (set-up folders)
  brain worktree add|remove|merge <id>    per-card git worktree, run in the project
  brain verify [id]                       run the project's checks in a card's worktree (merge runs them too)
  brain recount-lines [--dry-run]         recompute lines written per card from git history
  brain daemon start|stop|restart|status  machine-level daemon management
  brain daemon run                        run daemon in the foreground`);
}

await main();
