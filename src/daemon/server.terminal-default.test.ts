import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// The embedded terminal is ON by default; only KANKAN_TERMINAL=0 turns it off.
// It also stays off when node-pty can't load here — those cases skip.

const WARNING = 'WARNING: embedded terminal is reachable on';

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

  it('warns when the terminal is on and HOST is non-loopback', async (t) => {
    const d = await start({ KANKAN_TERMINAL: undefined, HOST: '0.0.0.0' });
    if (!(await terminalOn(d))) return t.skip('node-pty unavailable here');
    const out = await settledOutput(d);
    assert.ok(out.includes(`${WARNING} 0.0.0.0`), out);
    assert.equal(out.split(WARNING).length - 1, 1, 'warning logged once');
  });

  it('no warning with HOST=127.0.0.1', async (t) => {
    const d = await start({ KANKAN_TERMINAL: undefined, HOST: '127.0.0.1' });
    if (!(await terminalOn(d))) return t.skip('node-pty unavailable here');
    const out = await settledOutput(d);
    assert.ok(!out.includes(WARNING), out);
  });
});
