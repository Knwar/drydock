import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');

describe('conversation details and restarting a session', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-session-info-')));
  const log = join(tmp, 'claude.log');
  let d: TestDaemon;
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${r.data.error}`);
    return r.data;
  };
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const until = async (fn: () => Promise<boolean> | boolean) => {
    const end = Date.now() + 15_000;
    while (!(await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  };
  const replies = async () => (await call('GET', '/api/conversations/dm%3Amain/messages')).messages.filter((m: any) => m.author === 'main' && m.kind === 'text').length;

  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log } });
    await call('POST', '/api/workspace', { path: join(tmp, 'ws') });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('shows each member’s session size, turns and usage in this conversation', async () => {
    assert.equal((await raw('POST', '/api/conversations/dm%3Amain/sessions/main/reset')).status, 400, 'nothing to restart yet');
    await call('POST', '/api/conversations/dm%3Amain/messages', { text: 'remember the blue folder' });
    await until(async () => (await replies()) >= 1);
    await call('POST', '/api/conversations/dm%3Amain/messages', { text: 'and the red one' });
    await until(async () => (await replies()) >= 2);
    const info = await call('GET', '/api/conversations/dm%3Amain/info');
    const m = info.members[0];
    assert.equal(m.id, 'main');
    assert.equal(m.session.active, true);
    assert.ok(m.session.turns >= 2);
    assert.ok(m.session.context_tokens > 0, 'context size from the latest call');
    assert.ok(m.usage.runs >= 2 && m.usage.output > 0);
    assert.equal(info.limits.maxContextTokens, 400_000);
  });

  it('restarting starts a fresh session next turn, with a recap instead of the old session', async () => {
    await call('POST', '/api/conversations/dm%3Amain/sessions/main/reset');
    const info = await call('GET', '/api/conversations/dm%3Amain/info');
    assert.equal(info.members[0].session.active, false);
    assert.equal(info.members[0].session.turns, 0);
    const before_ = runs().length;
    await call('POST', '/api/conversations/dm%3Amain/messages', { text: 'what folders?' });
    await until(() => runs().length > before_);
    const run = runs().at(-1);
    assert.equal(run.resumed, null, 'not resumed');
    assert.match(run.prompt, /restarted your session/);
    assert.match(run.prompt, /blue folder/, 'the recap carries the earlier messages');
    await until(async () => (await replies()) >= 3);
    assert.equal((await call('GET', '/api/conversations/dm%3Amain/info')).members[0].session.active, true, 'a new session from here on');
  });
});
