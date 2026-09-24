import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

const postJson = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', body: JSON.stringify(body) });

async function createProject(base: string, root: string): Promise<string> {
  const res = await fetch(`${base}/project?root=${encodeURIComponent(root)}`);
  return ((await res.json()) as { project_id: string }).project_id;
}

describe('POST /project/:id/autopilot', () => {
  let daemon: TestDaemon | undefined;
  const projDir = mkdtempSync(join(tmpdir(), 'kankan-ap-proj-'));
  let project = '';

  before(async () => {
    daemon = await startDaemon();
    project = await createProject(daemon.base, projDir);
  });
  after(async () => {
    await daemon?.stop();
    rmSync(projDir, { recursive: true, force: true });
  });

  it('turns autopilot on → 200, broadcast, and /workspace/summary shows it', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws?project=${project}`);
    const msgs: { type: string; project_id?: string; on?: boolean }[] = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once('open', r));
    try {
      const res = await postJson(`${daemon!.base}/project/${project}/autopilot`, { on: true });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { project_id: project, autopilot: 1 });
      const sum = (await (await fetch(`${daemon!.base}/workspace/summary?project=${project}`)).json()) as {
        boards: { project: { id: string; autopilot: number } }[];
      };
      assert.equal(sum.boards[0].project.autopilot, 1);
      const deadline = Date.now() + 2000;
      while (!msgs.some((m) => m.type === 'autopilot') && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(
        msgs.find((m) => m.type === 'autopilot'),
        { type: 'autopilot', project_id: project, on: true },
      );
    } finally {
      ws.close();
    }
  });

  it('non-boolean on → 400', async () => {
    for (const body of [{}, { on: 'yes' }, { on: 1 }]) {
      const res = await postJson(`${daemon!.base}/project/${project}/autopilot`, body);
      assert.equal(res.status, 400);
    }
  });

  it('unknown project → 404', async () => {
    const res = await postJson(`${daemon!.base}/project/no-such-project/autopilot`, { on: true });
    assert.equal(res.status, 404);
  });
});

describe('autopilot nudges an idle session through the pty (fake claude)', () => {
  let daemon: TestDaemon | undefined;
  let enabled = false;
  let token = '';
  let project = '';
  // fake `claude` first on PATH: runs `cat` (no exec, so the foreground group
  // leader stays `/bin/sh …/claude`, which looksLikeClaude accepts) reading
  // stdin, so whatever autopilot types shows up in the pty output.
  const binDir = mkdtempSync(join(tmpdir(), 'kankan-ap-fake-claude-'));
  const projDir = mkdtempSync(join(tmpdir(), 'kankan-ap-pty-proj-'));

  before(async () => {
    const fake = join(binDir, 'claude');
    writeFileSync(fake, '#!/bin/sh\ncat\n');
    chmodSync(fake, 0o755);
    daemon = await startDaemon({
      env: {
        KANKAN_TERMINAL: '1',
        KANKAN_AUTOPILOT: '1',
        SHELL: '/bin/sh',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    });
    const cfg = (await (await fetch(`${daemon.base}/config`)).json()) as { terminal: boolean; token: string | null };
    enabled = cfg.terminal;
    token = cfg.token ?? '';
    if (enabled) project = await createProject(daemon.base, projDir);
  });
  after(async () => {
    // stopping the daemon kills its pty shell and the fake claude with it
    await daemon?.stop();
    rmSync(binDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  it('types the prompt once per idle period', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    const base = daemon!.base;
    assert.equal((await postJson(`${base}/project/${project}/autopilot`, { on: true })).status, 200);
    const { task_id } = (await (await postJson(`${base}/task`, { project_id: project, title: 'Q' })).json()) as {
      task_id: string;
    };
    assert.equal((await postJson(`${base}/task/${task_id}/move`, { lane: 'queued' })).status, 200);

    const ws = new WebSocket(`ws://127.0.0.1:${daemon!.port}/pty?project=${project}&token=${token}`);
    t.after(() => ws.close());
    let out = '';
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { t: string; d?: string };
      if (m.t === 'o') out += m.d;
    });
    await new Promise((r) => ws.once('open', r));

    const agent = () => fetch(`${base}/pty/agent?project=${project}&token=${token}`, { method: 'POST' });
    assert.equal((await agent()).status, 200);
    // wait until the fake claude holds the foreground (shell reports busy)
    for (const deadline = Date.now() + 10000; Date.now() < deadline; ) {
      const body = (await (await agent()).json()) as { started: boolean };
      if (!body.started) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // count nudges via the board broadcast (deterministic); the pty output
    // proves the prompt was actually typed into the fake claude
    const board = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws?project=${project}`);
    t.after(() => board.close());
    let nudges = 0;
    board.on('message', (raw) => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === 'autopilot_nudge') nudges++;
    });
    await new Promise((r) => board.once('open', r));
    const waitFor = async (cond: () => boolean, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    };
    const status = (verb: string) => postJson(`${base}/status`, { project_id: project, agent: 'orchestrator', verb });

    await status('idle');
    await waitFor(() => nudges >= 1 && out.includes('Work the next queued card on this board (autopilot).'));
    assert.equal(nudges, 1);
    assert.ok(out.includes('Work the next queued card'), `expected the prompt in pty output, got: ${JSON.stringify(out.slice(-300))}`);

    // a second idle ping in the SAME idle period (no working in between) → no re-nudge
    await status('idle');
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(nudges, 1);

    // working → idle starts a new idle period → nudged again
    await status('working');
    await status('idle');
    await waitFor(() => nudges >= 2);
    assert.equal(nudges, 2);
  });
});
