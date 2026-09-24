import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test-only helper: spawns the REAL daemon (server.ts runs its bootstrap on
// import) on a free port with a temp DB. The child is node itself (tsx loaded
// via --import, no npx/tsx wrapper), so killing it kills the daemon — no
// orphaned grandchild survives the test run.

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

export interface TestDaemon {
  base: string;
  port: number;
  dbDir: string;
  stop(): Promise<void>;
  /** The daemon's exit code once it has exited (null if still running or killed by a signal). */
  exitCode(): number | null;
  /** Everything the daemon has written to stdout + stderr so far. */
  output(): string;
}

/** A free TCP port (bind :0, read it back, release it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

// Generous by default: under load (parallel suites, busy machine) a cold
// `node --import tsx` start can take well over 8s. Early exit still fails fast.
const START_TIMEOUT_MS = Number(process.env.KANKAN_TEST_DAEMON_TIMEOUT_MS) || 30_000;

function waitForUp(base: string, exited: () => boolean, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${base}/config`, { signal: AbortSignal.timeout(500) });
        if (res.ok) return resolve();
      } catch {
        /* not up yet */
      }
      if (exited()) return reject(new Error('daemon exited before it came up'));
      if (Date.now() > deadline) return reject(new Error('daemon did not start in time'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** opts.env overrides the child env; a value of `undefined` DELETES that var. */
export async function startDaemon(opts: { env?: Record<string, string | undefined> } = {}): Promise<TestDaemon> {
  const port = await freePort();
  const dbDir = mkdtempSync(join(tmpdir(), 'kankan-test-daemon-'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOST: '127.0.0.1',
    KANKAN_DISPATCHER: '0',
    KANKAN_TERMINAL: '0',
    KANKAN_AUTOPILOT: '0', // never type into a pty unless a test opts in
    ...opts.env,
    PORT: String(port),
    DB_PATH: join(dbDir, 'board.db'),
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const proc = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  proc.stderr!.setEncoding('utf8').on('data', (d: string) => (out += d));
  let exited = false;
  let code: number | null = null;
  const exit = new Promise<void>((resolve) => {
    proc.once('exit', (c) => {
      exited = true;
      code = c;
      resolve();
    });
  });

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (!exited) {
        proc.kill('SIGTERM');
        const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
        await exit;
        clearTimeout(timer);
      }
      rmSync(dbDir, { recursive: true, force: true });
    })());

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForUp(base, () => exited);
  } catch (err) {
    await stop();
    throw err;
  }
  return { base, port, dbDir, stop, exitCode: () => code, output: () => out };
}
