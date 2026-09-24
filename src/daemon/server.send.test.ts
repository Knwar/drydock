import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// POST /pty/send types text into a project's Claude session: gated like
// /pty/agent, sanitized, and only into a verified idle Claude foreground.

const postJson = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /pty/send with the terminal disabled', () => {
  let daemon: TestDaemon | undefined;
  before(async () => {
    daemon = await startDaemon();
  });
  after(async () => {
    await daemon?.stop();
  });

  it('→ 409 terminal disabled', async () => {
    const res = await postJson(`${daemon!.base}/pty/send?project=x&token=y`, { text: 'hi' });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'terminal disabled' });
  });
});

describe('POST /pty/send with the terminal enabled (fake claude)', () => {
  let daemon: TestDaemon | undefined;
  let enabled = false;
  let token = '';
  let project = '';
  // fake `claude` first on PATH: runs `cat` (no exec, so the foreground group
  // leader stays `/bin/sh …/claude`, which looksLikeClaude accepts) and echoes
  // whatever is typed into it back through the pty.
  const binDir = mkdtempSync(join(tmpdir(), 'kankan-send-fake-claude-'));
  const projDir = mkdtempSync(join(tmpdir(), 'kankan-send-proj-'));

  before(async () => {
    const fake = join(binDir, 'claude');
    writeFileSync(fake, '#!/bin/sh\ncat\n');
    chmodSync(fake, 0o755);
    daemon = await startDaemon({
      env: { KANKAN_TERMINAL: '1', SHELL: '/bin/sh', PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    const cfg = (await (await fetch(`${daemon.base}/config`)).json()) as { terminal: boolean; token: string | null };
    enabled = cfg.terminal;
    token = cfg.token ?? '';
    if (enabled) {
      const res = await fetch(`${daemon.base}/project?root=${encodeURIComponent(projDir)}`);
      project = ((await res.json()) as { project_id: string }).project_id;
    }
  });
  after(async () => {
    // stopping the daemon kills its pty shell and the fake claude with it
    await daemon?.stop();
    rmSync(binDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  const send = (p: string, tok: string | null, body: unknown) =>
    postJson(
      `${daemon!.base}/pty/send?project=${encodeURIComponent(p)}${tok === null ? '' : `&token=${encodeURIComponent(tok)}`}`,
      body,
    );

  it('missing/wrong token → 403', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    for (const tok of [null, 'wrong']) {
      const res = await send(project, tok, { text: 'hi' });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: 'forbidden' });
    }
  });

  it('unknown project → 404', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    const res = await send('no-such-project', token, { text: 'hi' });
    assert.equal(res.status, 404);
  });

  it('empty / all-control-chars / >2000 chars / missing text → 400', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    for (const body of [{ text: '' }, { text: '\u001b\u0003\r\n\u007f\u0085 ' }, { text: 'x'.repeat(2001) }, {}]) {
      const res = await send(project, token, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it('types sanitized text into an idle claude; 409 when busy or claude gone', async (t) => {
    if (!enabled) return t.skip('node-pty unavailable');
    const base = daemon!.base;
    const status = (verb: string) => postJson(`${base}/status`, { project_id: project, agent: 'orchestrator', verb });

    // no pty session yet → nothing to type into
    assert.deepEqual(await (await send(project, token, { text: 'hi' })).json(), { error: 'no claude session' });

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

    const boardWs = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws?project=${project}`);
    t.after(() => boardWs.close());
    const events: { type: string; payload: unknown }[] = [];
    boardWs.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string; event?: { type: string; payload: unknown } };
      if (m.type === 'event' && m.event) events.push(m.event);
    });
    await new Promise((r) => boardWs.once('open', r));

    await status('idle');
    const ok = await send(project, token, { text: 'hello\u001b[31m\nworld\u0003' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { sent: true });
    for (const deadline = Date.now() + 5000; !out.includes('hello[31m world') && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(out.includes('hello[31m world'), `expected sanitized text in pty output, got: ${JSON.stringify(out.slice(-300))}`);
    assert.ok(!out.includes('\u0003') && !out.includes('^C'), 'no Ctrl-C reached the pty');
    assert.ok(!out.includes('\u001b[31m'), 'no ESC sequence reached the pty');

    // recorded as a board event (broadcast to board subscribers)
    for (const deadline = Date.now() + 5000; !events.some((e) => e.type === 'note') && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const note = events.find((e) => e.type === 'note');
    assert.ok(note, 'a note event was appended');
    const payload = typeof note!.payload === 'string' ? JSON.parse(note!.payload) : note!.payload;
    assert.deepEqual(payload, { msg: 'hello[31m world', via: 'home' });

    // needs you → a permission prompt is up; Enter would answer it → refuse
    await status('needs you');
    const decision = await send(project, token, { text: 'should-not-appear' });
    assert.equal(decision.status, 409);
    assert.deepEqual(await decision.json(), { error: 'waiting for a decision in the terminal — answer it there' });

    // working → busy, nothing typed
    await status('Edit');
    const busy = await send(project, token, { text: 'should-not-appear' });
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { error: 'agent busy' });

    // end the fake claude (Ctrl-D → cat sees EOF) → shell is foreground again.
    // Status stays working, so a send can never type while claude is still up:
    // it answers 'agent busy' until the foreground check fails first.
    ws.send(JSON.stringify({ t: 'i', d: '\u0004' }));
    let gone: { status: number; body: unknown } = { status: 0, body: null };
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      const res = await send(project, token, { text: 'should-not-appear' });
      gone = { status: res.status, body: await res.json() };
      if ((gone.body as { error?: string }).error !== 'agent busy') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(gone.status, 409);
    assert.deepEqual(gone.body, { error: 'no claude session' });
    assert.ok(!out.includes('should-not-appear'), 'nothing typed when busy / no claude');
  });
});
