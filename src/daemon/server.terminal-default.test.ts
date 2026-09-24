import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// The embedded terminal is ON by default; only KANKAN_TERMINAL=0 turns it off.
// It also stays off when node-pty can't load here — those cases skip.

const NOTE = 'note: daemon bound to';

const terminalOn = async (d: TestDaemon) =>
  ((await (await fetch(`${d.base}/config`)).json()) as { terminal: boolean }).terminal;

/** Wait until the daemon has logged its listen line (stdout), then a beat for stderr. */
async function settledOutput(d: TestDaemon): Promise<string> {
  const deadline = Date.now() + 5000;
  while (!d.output().includes('board daemon on') && Date.now() < deadline) await sleep(50);
  await sleep(200);
  return d.output();
}

describe('embedded terminal default', () => {
  const daemons: TestDaemon[] = [];
  const start = async (env: Record<string, string | undefined>) => {
    const d = await startDaemon({ env });
    daemons.push(d);
    return d;
  };
  after(async () => {
    await Promise.all(daemons.map((d) => d.stop()));
  });

  it('KANKAN_TERMINAL unset → terminal on', async (t) => {
    const d = await start({ KANKAN_TERMINAL: undefined });
    if (!(await terminalOn(d))) {
      assert.match(await settledOutput(d), /terminal disabled: node-pty unavailable/);
      return t.skip('node-pty unavailable here');
    }
    assert.equal(await terminalOn(d), true);
  });

  it('KANKAN_TERMINAL=0 → terminal off and /pty/agent 409', async () => {
    const d = await start({ KANKAN_TERMINAL: '0' });
    assert.equal(await terminalOn(d), false);
    const res = await fetch(`${d.base}/pty/agent?project=x`, { method: 'POST' });
    assert.equal(res.status, 409);
  });

  it('notes the local-only terminal when HOST is non-loopback', async (t) => {
    const d = await start({ KANKAN_TERMINAL: undefined, HOST: '0.0.0.0' });
    if (!(await terminalOn(d))) return t.skip('node-pty unavailable here');
    const out = await settledOutput(d);
    assert.ok(out.includes(`${NOTE} 0.0.0.0; the embedded terminal only accepts connections from this machine`), out);
    assert.equal(out.split(NOTE).length - 1, 1, 'note logged once');
  });

  it('no note with HOST=127.0.0.1', async (t) => {
    const d = await start({ KANKAN_TERMINAL: undefined, HOST: '127.0.0.1' });
    if (!(await terminalOn(d))) return t.skip('node-pty unavailable here');
    const out = await settledOutput(d);
    assert.ok(!out.includes(NOTE), out);
  });
});

/** First non-internal IPv4 address (a real NON-loopback path to the daemon). */
function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/** Try a /pty upgrade (no Origin); resolves true if it opened, false if refused. */
function wsOpens(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.once('open', () => {
      ws.terminate();
      resolve(true);
    });
    ws.once('error', () => resolve(false));
  });
}

describe('embedded terminal is loopback-only (HOST=0.0.0.0)', () => {
  let d: TestDaemon | undefined;
  let token: string | null = null;
  const ip = nonLoopbackIPv4();

  after(async () => {
    await d?.stop();
  });

  // `project=x` is unknown: past the gate the routes answer 404/200 and the WS
  // closes right after opening — no shell is ever spawned.
  const q = () => `project=x&token=${encodeURIComponent(token ?? '')}`;

  it('loopback: /config hands out the token and the gated routes pass', async (t) => {
    d = await startDaemon({ env: { KANKAN_TERMINAL: undefined, HOST: '0.0.0.0' } });
    const cfg = (await (await fetch(`${d.base}/config`)).json()) as { terminal: boolean; token: string | null };
    if (!cfg.terminal) return t.skip('node-pty unavailable here');
    token = cfg.token;
    assert.ok(token);
    assert.notEqual((await fetch(`${d.base}/pty/agent?${q()}`, { method: 'POST' })).status, 403);
    assert.notEqual((await fetch(`${d.base}/pty/reset?${q()}`, { method: 'POST' })).status, 403);
    assert.equal(await wsOpens(`ws://127.0.0.1:${d.port}/pty?${q()}`), true);
  });

  it('LAN: no token from /config; valid token + no Origin still rejected', async (t) => {
    if (!token) return t.skip('terminal not on');
    if (!ip) return t.skip('no non-loopback IPv4 interface on this host');
    const lan = `http://${ip}:${d!.port}`;
    const cfg = (await (await fetch(`${lan}/config`)).json()) as { terminal: boolean; token: string | null };
    assert.equal(cfg.token, null);
    assert.equal((await fetch(`${lan}/pty/agent?${q()}`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${lan}/pty/reset?${q()}`, { method: 'POST' })).status, 403);
    assert.equal(await wsOpens(`ws://${ip}:${d!.port}/pty?${q()}`), false);
  });
});
