import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startDaemon } from './test-daemon.js';

// SIGTERM must take the daemon down cleanly: exit 0, and no pty shell (or
// whatever runs in it, e.g. claude) left orphaned under PID 1.

interface Proc { pid: number; pgid: number; command: string }

function processes(): Proc[] {
  const out = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] }));
}

describe('daemon shutdown', () => {
  it('plain daemon: SIGTERM → exits 0 promptly', async () => {
    const daemon = await startDaemon();
    const t0 = Date.now();
    await daemon.stop();
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
    assert.equal(daemon.exitCode(), 0);
  });

  it('terminal daemon: SIGTERM kills the shell, its foreground claude and the spawn-helper', async (t) => {
    // realpath: macOS tmpdir is a /var → /private/var symlink; ps shows either.
    const binDir = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-shutdown-bin-')));
    const projDir = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-shutdown-proj-')));
    const fake = join(binDir, 'claude');
    // ignores SIGHUP (like a process that survives the tty hangup) so only an
    // explicit kill of its process group — the shell puts it in its own — ends it
    writeFileSync(fake, "#!/bin/sh\ntrap '' HUP\nsleep 300\n");
    chmodSync(fake, 0o755);
    const daemon = await startDaemon({
      env: { KANKAN_TERMINAL: '1', SHELL: '/bin/sh', PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    try {
      const cfg = (await (await fetch(`${daemon.base}/config`)).json()) as { terminal: boolean; token: string | null };
      if (!cfg.terminal) return t.skip('node-pty unavailable');
      const res = await fetch(`${daemon.base}/project?root=${encodeURIComponent(projDir)}`);
      const project = ((await res.json()) as { project_id: string }).project_id;
      const agent = await fetch(
        `${daemon.base}/pty/agent?project=${encodeURIComponent(project)}&token=${encodeURIComponent(cfg.token!)}`,
        { method: 'POST' },
      );
      assert.equal(agent.status, 200);

      const refs = (p: Proc) => p.command.includes(projDir) || p.command.includes(binDir);
      let tracked: Proc[] = [];
      for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
        tracked = processes().filter(refs);
        if (tracked.some((p) => p.command.includes(fake))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(tracked.some((p) => p.command.includes(fake)), 'fake claude should be running');
      // the fake claude's `sleep 300` child doesn't mention the dirs — catch it by process group
      const pgids = new Set(tracked.map((p) => p.pgid));

      const t0 = Date.now();
      await daemon.stop();
      assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
      assert.equal(daemon.exitCode(), 0);

      let left: Proc[] = [];
      for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
        left = processes().filter((p) => refs(p) || pgids.has(p.pgid));
        if (left.length === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(left, [], 'orphaned processes survived the daemon');
    } finally {
      await daemon.stop();
      rmSync(binDir, { recursive: true, force: true });
      rmSync(projDir, { recursive: true, force: true });
    }
  });
});
