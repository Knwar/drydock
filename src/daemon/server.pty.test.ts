import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// POST /pty/agent (types `claude` into a project's shell) and POST /pty/reset
// are command execution → gated exactly like the /pty upgrade.

const post = (url: string) => fetch(url, { method: 'POST' });

describe('/pty routes with the terminal disabled', () => {
  let daemon: TestDaemon | undefined;
  before(async () => {
    daemon = await startDaemon();
  });
  after(async () => {
    await daemon?.stop();
  });

  it('POST /pty/agent → 409', async () => {
    const res = await post(`${daemon!.base}/pty/agent?project=x&token=y`);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'terminal disabled' });
  });

  it('POST /pty/reset → 409', async () => {
    const res = await post(`${daemon!.base}/pty/reset?project=x&token=y`);
    assert.equal(res.status, 409);
  });
});

describe('/pty routes with the terminal enabled', () => {
  let daemon: TestDaemon | undefined;
  let token: string | null = null;
  let enabled = false;
  let project = '';
  // fake `claude` first on PATH so the valid case never launches the real one
  const binDir = mkdtempSync(join(tmpdir(), 'kankan-fake-claude-'));
  const projDir = mkdtempSync(join(tmpdir(), 'kankan-pty-proj-'));

  before(async () => {
    const fake = join(binDir, 'claude');
    writeFileSync(fake, '#!/bin/sh\nsleep 30\n');
    chmodSync(fake, 0o755);
    daemon = await startDaemon({
      env: { KANKAN_TERMINAL: '1', SHELL: '/bin/sh', PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    const cfg = (await (await fetch(`${daemon.base}/config`)).json()) as { terminal: boolean; token: string | null };
    enabled = cfg.terminal;
    token = cfg.token;
    if (enabled) {
      const res = await fetch(`${daemon.base}/project?root=${encodeURIComponent(projDir)}`);
      project = ((await res.json()) as { project_id: string }).project_id;
    }
  });
  after(async () => {
    await daemon?.stop();
    rmSync(binDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  const agent = (p: string, tok: string | null) =>
    post(`${daemon!.base}/pty/agent?project=${encodeURIComponent(p)}${tok === null ? '' : `&token=${encodeURIComponent(tok)}`}`);
  const reset = (p: string, tok: string | null) =>
    post(`${daemon!.base}/pty/reset?project=${encodeURIComponent(p)}${tok === null ? '' : `&token=${encodeURIComponent(tok)}`}`);

  it('missing/wrong token → 403 for /pty/agent and /pty/reset', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    for (const tok of [null, 'wrong']) {
      const a = await agent(project, tok);
      assert.equal(a.status, 403);
      assert.deepEqual(await a.json(), { error: 'forbidden' });
      assert.equal((await reset(project, tok)).status, 403);
    }
  });

  it('cross-origin request with a valid token → 403', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    const res = await fetch(`${daemon!.base}/pty/agent?project=${project}&token=${token}`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  });

  it('unknown project → 404', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    assert.equal((await agent('no-such-project', token)).status, 404);
  });

  it('starts the agent once; a second call reports already running', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    const first = await agent(project, token);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { started: true });
    const second = await agent(project, token);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { started: false, reason: 'already running' });
  });

  it('/pty/reset with the token kills the shell; the agent can then start again', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    const res = await reset(project, token);
    assert.equal(res.status, 200);
    const deadline = Date.now() + 5000;
    let body: { started: boolean } | undefined;
    while (Date.now() < deadline) {
      body = (await (await agent(project, token)).json()) as { started: boolean };
      if (body.started) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(body, { started: true });
  });
});
