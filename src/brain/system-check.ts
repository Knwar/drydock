// What Drydock needs on this computer: Node, git, the Claude CLI and a
// signed-in Claude account. Checked at start, every 5 minutes and on demand;
// the app shows a banner while anything is missing. None of it costs tokens.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getBus } from './bus.js';

const execFileAsync = promisify(execFile);
const CLAUDE_BIN = process.env.BRAIN_CLAUDE_BIN ?? 'claude';
const NODE_MIN = 20;

export interface Check {
  id: 'node' | 'git' | 'claude' | 'signin';
  ok: boolean;
  label: string;
  detail: string;
  /** what to do about it, when it is not ok */
  fix: string | null;
  command: string | null;
}
export interface SystemStatus {
  ok: boolean;
  checks: Check[];
  at: number;
}

const run = async (bin: string, args: string[]) => {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 20_000 });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    // `claude auth status` exits non-zero when signed out but still prints its JSON
    return { ok: false, out: String((e as { stdout?: string }).stdout ?? '').trim() };
  }
};

/** Reads `claude auth status --json`: signed in or not, and with what. */
export function parseAuth(out: string): { loggedIn: boolean; method: string | null; plan: string | null } {
  try {
    const j = JSON.parse(out);
    return { loggedIn: Boolean(j.loggedIn), method: j.authMethod ?? null, plan: j.subscriptionType ?? null };
  } catch {
    return { loggedIn: false, method: null, plan: null };
  }
}

export async function runChecks(): Promise<SystemStatus> {
  const major = Number(process.versions.node.split('.')[0]);
  const checks: Check[] = [
    major >= NODE_MIN
      ? { id: 'node', ok: true, label: 'Node.js', detail: `v${process.versions.node}`, fix: null, command: null }
      : { id: 'node', ok: false, label: 'Node.js', detail: `v${process.versions.node} is too old`, fix: `Install Node ${NODE_MIN} or newer, then restart Drydock.`, command: 'brew install node' },
  ];
  const git = await run('git', ['--version']);
  checks.push(
    git.ok
      ? { id: 'git', ok: true, label: 'git', detail: git.out.replace(/^git version\s*/, 'v'), fix: null, command: null }
      : { id: 'git', ok: false, label: 'git', detail: 'Not installed', fix: 'Projects are git repositories, so agents need git. Install it, then check again.', command: process.platform === 'darwin' ? 'xcode-select --install' : 'sudo apt install git' },
  );
  const cli = await run(CLAUDE_BIN, ['--version']);
  if (!cli.ok) {
    checks.push({ id: 'claude', ok: false, label: 'Claude CLI', detail: 'Not installed', fix: 'Every agent runs through Claude Code. Install it, then check again.', command: 'npm install -g @anthropic-ai/claude-code' });
    checks.push({ id: 'signin', ok: false, label: 'Claude sign-in', detail: 'Needs the Claude CLI first', fix: null, command: null });
  } else {
    checks.push({ id: 'claude', ok: true, label: 'Claude CLI', detail: cli.out.split(/\s/)[0] ? `v${cli.out.split(/\s/)[0].replace(/^v/, '')}` : 'Installed', fix: null, command: null });
    const auth = parseAuth((await run(CLAUDE_BIN, ['auth', 'status', '--json'])).out);
    checks.push(
      auth.loggedIn
        ? { id: 'signin', ok: true, label: 'Claude sign-in', detail: auth.plan ? `Signed in (${auth.plan} plan)` : auth.method === 'api_key' || auth.method === 'apiKey' ? 'Using an API key' : 'Signed in', fix: null, command: null }
        : { id: 'signin', ok: false, label: 'Claude sign-in', detail: 'Not signed in', fix: 'Agents cannot run until Claude Code is signed in. Sign in once in a terminal, then check again.', command: 'claude auth login' },
    );
  }
  return { ok: checks.every((c) => c.ok), checks, at: Date.now() };
}

let last: SystemStatus | null = null;
let inflight: Promise<SystemStatus> | null = null;

/** The latest result (re-checked when older than a minute, or when asked). */
export async function systemStatus(force = false): Promise<SystemStatus> {
  if (!force && last && Date.now() - last.at < 60_000) return last;
  inflight ??= runChecks()
    .then((s) => {
      const changed = !last || JSON.stringify(last.checks) !== JSON.stringify(s.checks);
      last = s;
      if (changed) {
        try {
          getBus().emit({ type: 'system' });
        } catch {} // not bound in unit tests
      }
      return s;
    })
    .finally(() => (inflight = null));
  return inflight;
}

export function startSystemChecks(): NodeJS.Timeout {
  void systemStatus(true);
  return setInterval(() => void systemStatus(true), 5 * 60_000).unref();
}
