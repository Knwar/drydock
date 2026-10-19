import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('agent runs survive a daemon restart', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-resume-')));
  const env = { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE };
  let d: TestDaemon | undefined;
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(d!.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };

  it('posts an interrupted note and resumes the same session, without answering the old message twice', async () => {
    d = await startDaemon({ dbPath: null, env });
    await call('POST', '/api/workspace', { path: join(tmp, 'ws') });
    await call('POST', '/api/roles', { template: 'cto' });
    const token = `SLOW job ${Math.random().toString(36).slice(2, 8)}`;
    await call('POST', '/api/conversations/dm:cto/messages', { text: token });
    // wait until the run has started (its session is recorded)
    for (let i = 0; i < 300 && !(await call('GET', '/api/conversations/dm:cto/messages')).working; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500)); // the fake has printed its session by now
    const first = d;
    const pids = () => {
      try {
        return execFileSync('pgrep', ['-f', token], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    assert.ok(pids().length, 'the agent is running');
    await d.stop(); // the restart cuts the run off mid-job
    // and stops its process: left running, it would carry on unseen beside the resumed copy
    for (let i = 0; i < 30 && pids().length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(pids(), [], 'no agent process outlives the daemon');
    if (process.env.RESUME_DEBUG) console.log('FIRST DAEMON:\n' + first.output());
    d = await startDaemon({ dbPath: null, env });
    let messages: any[] = [];
    for (let i = 0; i < 450; i++) {
      messages = (await call('GET', '/api/conversations/dm:cto/messages')).messages;
      if (messages.some((m) => m.author === 'cto' && m.kind === 'text')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (process.env.RESUME_DEBUG) console.log('SECOND DAEMON:\n' + d.output() + '\nMESSAGES: ' + JSON.stringify(messages.map((m) => [m.author, m.kind, m.body.slice(0, 60)])));
    const note = messages.find((m) => m.kind === 'error');
    assert.match(note.body, /interrupted when Drydock restarted/);
    const reply = messages.find((m) => m.author === 'cto' && m.kind === 'text');
    assert.match(reply.body, /^echo: You were interrupted by an app restart.*\(resumed\)$/s);
    // the original message was taken in by the interrupted run: it is not answered again
    await new Promise((r) => setTimeout(r, 800));
    const after = (await call('GET', '/api/conversations/dm:cto/messages')).messages;
    assert.equal(after.filter((m: any) => m.author === 'cto' && m.kind === 'text').length, 1);
  });
});
