#!/usr/bin/env node
// drydock: start, stop and find Drydock on this computer.
//   drydock start [--port N] [--no-open]   start it in the background and print where it is
//   drydock status                          is it running, and at which address
//   drydock open                            open it in the browser (starts it if needed)
//   drydock stop | restart                  stop or restart it
//   drydock logs                            follow its log
//   drydock update                          pull the latest version, rebuild, restart
// Anything else (init, worktree, verify…) goes to the agents' CLI, bin/brain.js.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = join(ROOT, 'bin', 'brain.js');
/** Drydock's folder inside a root: .drydock, or .ai-brain where an older install has one (as in src/brain/workspace.ts). */
const dataDir = (root) => (existsSync(join(root, '.ai-brain')) && !existsSync(join(root, '.drydock')) ? join(root, '.ai-brain') : join(root, '.drydock'));
const DATA_DIR = process.env.BRAIN_HOME ?? dataDir(homedir());
const PORT_FILE = join(DATA_DIR, 'port');
const LOG_FILE = join(DATA_DIR, 'daemon.log');
const DEFAULT_PORT = 7900;

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const green = c('32');
const red = c('31');
const yellow = c('33');
const home = (p) => (p && p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p);

/** The port: --port (remembered), else DRYDOCK_PORT, else the remembered one, else 7900. */
function port(args = []) {
  const i = args.indexOf('--port');
  if (i >= 0) {
    const p = Number(args[i + 1]);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) fail(`--port needs a number from 1024 to 65535`);
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PORT_FILE, String(p));
    return p;
  }
  if (process.env.DRYDOCK_PORT) return Number(process.env.DRYDOCK_PORT);
  try {
    return Number(readFileSync(PORT_FILE, 'utf8').trim()) || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function fail(msg) {
  console.error(red(msg));
  process.exit(1);
}

/** The user's local token (the daemon writes it at start; readable by the user only). */
function token() {
  try {
    return readFileSync(join(DATA_DIR, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function get(base, path) {
  try {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(path === '/api/system' ? 30_000 : 1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Who holds the port, when it is not Drydock. */
function holder(p) {
  try {
    const pid = execFileSync('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN']).toString().trim().split('\n')[0];
    if (!pid) return null;
    const name = execFileSync('ps', ['-o', 'comm=', '-p', pid]).toString().trim();
    return `${name.split('/').pop()} (pid ${pid})`;
  } catch {
    return null;
  }
}

const brain = (args, p, quiet = false) =>
  spawnSync(process.execPath, [BRAIN, ...args], { cwd: ROOT, env: { ...process.env, DAEMON_URL: `http://localhost:${p}` }, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });

async function banner(p) {
  const base = `http://localhost:${p}`;
  const ws = await get(base, '/api/workspace');
  const sys = await get(base, '/api/system');
  const signin = sys?.checks?.find((x) => x.id === 'signin');
  const missing = sys?.checks?.filter((x) => !x.ok && x.command) ?? [];
  console.log(`
  ${green('●')} ${bold('Drydock is running')}

  ${bold('Open')}        ${bold(`${base}/app/`)}
  ${dim('Port')}        ${p}
  ${dim('Workspace')}   ${ws?.root ? home(ws.root) : yellow('not chosen yet: the app asks for a folder the first time you open it')}
  ${dim('Claude')}      ${!sys ? dim('checking…') : signin?.ok ? green(signin.detail) : red(`${signin?.detail ?? 'not ready'}`)}
  ${dim('Log')}         ${home(LOG_FILE)}
${missing.map((x) => `\n  ${red('!')} ${x.label}: ${x.detail}. Fix: ${bold(x.command)}`).join('')}
  ${dim('Forgot the address? Run')} drydock status ${dim('or')} drydock open
  ${dim('Stop it with')} drydock stop
`);
}

async function start(args) {
  const p = port(args);
  const base = `http://localhost:${p}`;
  if (!(await get(base, '/api/workspace'))) {
    const other = holder(p);
    if (other) fail(`Port ${p} is used by another program: ${other}.\nStart Drydock on a different port (it is remembered): drydock start --port ${p + 50}`);
    if (!existsSync(join(ROOT, 'dist', 'web', 'index.html'))) fail(`Drydock is not built yet. In ${home(ROOT)} run: ./install.sh`);
    process.stdout.write(dim('  Starting Drydock…'));
    const r = brain(['daemon', 'start'], p, true);
    process.stdout.write(tty ? '\r\x1b[K' : '\n');
    if (r.status !== 0) fail(`Drydock did not start. The last lines of its log:\n\n${tail(20)}\n\nFull log: ${LOG_FILE}`);
  }
  await banner(p);
  if (tty && !args.includes('--no-open')) openBrowser(`${base}/app/`);
}

function tail(n) {
  try {
    return readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n');
  } catch {
    return '(no log yet)';
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function status() {
  const p = port();
  if (await get(`http://localhost:${p}`, '/api/workspace')) return banner(p);
  const other = holder(p);
  console.log(`\n  ${red('●')} ${bold('Drydock is not running')} ${dim(`(it uses port ${p})`)}`);
  if (other) console.log(`  ${yellow('!')} Port ${p} is held by another program: ${other}`);
  console.log(`\n  Start it with: ${bold('drydock start')}\n`);
}

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  if (cmd === 'start') return start(args);
  if (cmd === 'status') return status();
  if (cmd === 'open') {
    const p = port();
    if (!(await get(`http://localhost:${p}`, '/api/workspace'))) return start([]);
    console.log(`Opening http://localhost:${p}/app/`);
    return openBrowser(`http://localhost:${p}/app/`);
  }
  if (cmd === 'stop') return console.log(/not running/.test(brain(['daemon', 'stop'], port(), true).stdout) ? 'Drydock was not running.' : 'Drydock stopped.');
  if (cmd === 'restart') {
    brain(['daemon', 'stop'], port(), true);
    return start(['--no-open']);
  }
  if (cmd === 'logs') return void spawnSync('tail', ['-n', '40', '-f', LOG_FILE], { stdio: 'inherit' });
  if (cmd === 'update') {
    const run = (bin, a) => {
      console.log(dim(`$ ${bin} ${a.join(' ')}`));
      if (spawnSync(bin, a, { cwd: ROOT, stdio: 'inherit' }).status !== 0) fail(`${bin} ${a.join(' ')} failed; Drydock was not restarted.`);
    };
    run('git', ['pull', '--ff-only']);
    run('npm', ['install', '--no-audit', '--no-fund']);
    run('npm', ['run', 'build']);
    brain(['daemon', 'stop'], port(), true);
    return start(['--no-open']);
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`
  ${bold('drydock')} start [--port N] [--no-open]   start it and print its address
  ${bold('drydock')} status                        is it running, and where (forgot the address? this)
  ${bold('drydock')} open                          open it in your browser
  ${bold('drydock')} stop | restart                stop or restart it
  ${bold('drydock')} logs                          follow its log (Ctrl+C to leave)
  ${bold('drydock')} update                        get the latest version and restart
`);
    return;
  }
  // the agents' commands (init, worktree, verify…)
  process.exit(brain([cmd, ...args], port()).status ?? 1);
}

await main();
