import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

// End-to-end coverage for the daemon's network boundary: the loopback-OR-token
// gate on the new /subscriptions* + /deliveries routes, and the readBody size
// cap. We spawn the REAL server (server.ts runs its bootstrap on import) on a
// random port so the assertions exercise the shipped code path.

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'server.ts');

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

/** First non-internal IPv4 address, if the box has one (lets us drive a real
 *  NON-loopback connection). Null on hosts with only loopback. */
function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function waitForUp(base: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${base}/config`, { signal: AbortSignal.timeout(500) });
        if (res.ok) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return reject(new Error('daemon did not start in time'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe('daemon network boundary', () => {
  let proc: ChildProcess;
  let dir: string;
  let port: number;
  const loopbackBase = () => `http://127.0.0.1:${port}`;

  before(async () => {
    port = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'kankan-gate-'));
    proc = spawn('npx', ['tsx', SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        // Bind all interfaces so the non-loopback 401 test can actually connect
        // from a LAN IP; the gate must still deny it.
        HOST: '0.0.0.0',
        DB_PATH: join(dir, 'board.db'),
        KANKAN_DISPATCHER: '0',
        KANKAN_TERMINAL: '', // no per-start token → non-loopback callers are token-less
      },
      stdio: 'ignore',
    });
    await waitForUp(loopbackBase());
  });

  after(async () => {
    proc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows loopback callers on /subscriptions (how the MCP tools + hooks reach it, tokenless)', async () => {
    const res = await fetch(`${loopbackBase()}/subscriptions`);
    assert.equal(res.status, 200); // through the gate → board.listSubscriptions
    assert.ok(Array.isArray(await res.json()));
  });

  it('allows loopback callers on /deliveries', async () => {
    const res = await fetch(`${loopbackBase()}/deliveries`);
    assert.equal(res.status, 200);
  });

  it('allows loopback callers on /subscriptions/:id (404 for unknown id, not 401)', async () => {
    const res = await fetch(`${loopbackBase()}/subscriptions/does-not-exist`);
    assert.equal(res.status, 404);
  });

  it('does NOT gate a pre-existing board route (/board → 400 for missing project, not 401)', async () => {
    const res = await fetch(`${loopbackBase()}/board`);
    assert.equal(res.status, 400);
  });

  it('denies a NON-loopback caller without a token on /subscriptions with 401', async (t) => {
    const ip = nonLoopbackIPv4();
    if (!ip) return t.skip('no non-loopback IPv4 interface on this host');
    const res = await fetch(`http://${ip}:${port}/subscriptions`);
    assert.equal(res.status, 401);
    // and /deliveries + /subscriptions/:id are gated the same way
    assert.equal((await fetch(`http://${ip}:${port}/deliveries`)).status, 401);
    assert.equal((await fetch(`http://${ip}:${port}/subscriptions/x`)).status, 401);
    // a pre-existing route is still reachable from the LAN (only the 3 new routes are gated)
    assert.equal((await fetch(`http://${ip}:${port}/board`)).status, 400);
  });

  it('caps oversized request bodies with 413 and leaves small bodies unaffected', async () => {
    const huge = JSON.stringify({ x: 'a'.repeat(2_000_000) }); // > 1MB
    const big = await fetch(`${loopbackBase()}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    assert.equal(big.status, 413);

    // a normal small body passes the cap and reaches the handler's own validation
    const small = await fetch(`${loopbackBase()}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    assert.equal(small.status, 400); // "project_id and title required" → not a cap error
  });
});
