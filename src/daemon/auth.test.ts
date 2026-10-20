import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { allowed, asAgent, Auth, cookieValue, levelOf } from './auth.js';
import { rawFetch, startDaemon, type TestDaemon } from './test-daemon.js';

const FAKE = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'fake-claude.mjs');
const q = (s = '') => new URLSearchParams(s);

describe('route levels and callers', () => {
  it('everything not listed is the user’s; agents get exactly their tools’ routes', () => {
    assert.equal(levelOf('POST', '/api/approvals/abc', q()), 'user', 'deciding an approval');
    assert.equal(levelOf('POST', '/api/approvals', q()), 'agent', 'asking for one');
    assert.equal(levelOf('GET', '/api/approvals/abc/wait', q()), 'agent');
    for (const [m, path] of [['POST', '/api/permissions'], ['POST', '/api/integrations/add'], ['POST', '/api/integrations/policy'], ['POST', '/api/secrets/settings'], ['POST', '/api/secrets/install'], ['POST', '/api/workspace'], ['POST', '/api/roles'], ['POST', '/skills'], ['POST', '/git/commit'], ['DELETE', '/project/x'], ['POST', '/api/conversations/dm:main/messages'], ['POST', '/api/projects/x/auto'], ['GET', '/api/files'], ['GET', '/config']])
      assert.equal(levelOf(m, path, q()), 'user', `${m} ${path}`);
    assert.equal(levelOf('POST', '/task/abc/review', q()), 'agent');
    assert.equal(levelOf('POST', '/event', q()), 'hook');
    assert.equal(levelOf('GET', '/project', q('root=/x&create=0')), 'hook', 'hooks only look up');
    assert.equal(levelOf('GET', '/project', q('root=/x')), 'agent', 'get-or-create needs a token');
    assert.equal(levelOf('GET', '/app/project/x', q()), 'public');
    assert.equal(levelOf('GET', '/app.js', q()), 'public', 'the overlay’s files');
  });

  it('who may call what', () => {
    const agent = { kind: 'agent' as const, role: 'pm', conversation: 'ch:x', project: 'p' };
    assert.equal(allowed('user', agent), false);
    assert.equal(allowed('agent', agent), true);
    assert.equal(allowed('user', { kind: 'local' }), true);
    assert.equal(allowed('agent', { kind: 'none' }), false);
    assert.equal(allowed('hook', { kind: 'none' }, true), true, 'old kits on this Mac');
    assert.equal(allowed('hook', { kind: 'none' }, false), false, 'never from the network');
  });

  it('an agent speaks only as itself', () => {
    const agent = { kind: 'agent' as const, role: 'pm', conversation: 'ch:build', project: 'p' };
    assert.deepEqual(asAgent({ role: 'main', author: 'user', from: 'user', by: 'user', conversation: 'dm:main', text: 'x' }, agent), { role: 'pm', author: 'pm', from: 'pm', by: 'agent', conversation: 'ch:build', text: 'x' });
    assert.deepEqual(asAgent({ text: 'x' }, agent), { text: 'x' }, 'adds nothing that was not there');
  });

  it('keeps the local token in a file only the user can read, and reuses it', () => {
    const home = mkdtempSync(join(tmpdir(), 'drydock-auth-'));
    try {
      const a = new Auth(home, {});
      assert.equal(new Auth(home, {}).localToken, a.localToken, 'a second daemon reads the same token');
      assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);
      const t = a.mintAgent({ role: 'pm', conversation: 'c', project: null });
      assert.equal(a.resolve({ headers: { authorization: `Bearer ${t}` } } as any).kind, 'agent');
      a.revoke(t);
      assert.equal(a.resolve({ headers: { authorization: `Bearer ${t}` } } as any).kind, 'none', 'revoked when the run ends');
      assert.equal(a.resolve({ headers: { cookie: `x=1; drydock_session=${a.sessionKey}` } } as any).kind, 'user');
      assert.equal(cookieValue('a=1; b=2=3', 'b'), '2=3');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the daemon with callers', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'drydock-auth-daemon-')));
  let d: TestDaemon;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json();
  };
  before(async () => {
    d = await startDaemon({ dbPath: null, env: { BRAIN_HOME: join(tmp, 'home'), BRAIN_CLAUDE_BIN: FAKE } });
    await call('POST', '/api/workspace', { path: join(tmp, 'ws') });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('refuses a caller with no token, or a wrong one; the local token works', async () => {
    assert.equal((await rawFetch(`${d.base}/api/permissions`)).status, 401);
    assert.equal((await rawFetch(`${d.base}/api/projects`, { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await rawFetch(`${d.base}/api/projects`, { headers: { authorization: `Bearer ${d.token}` } })).status, 200);
    assert.equal((await rawFetch(`${d.base}/app/`)).status === 401, false, 'the app’s pages are public');
  });

  it('hands Drydock’s own app a session cookie, and the cookie works', async () => {
    assert.equal((await rawFetch(`${d.base}/api/session`)).status, 403, 'not a browser request');
    const r = await rawFetch(`${d.base}/api/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const cookie = r.headers.get('set-cookie') ?? '';
    assert.match(cookie, /drydock_session=[^;]+; HttpOnly; SameSite=Strict/);
    const session = cookie.split(';')[0];
    assert.equal((await rawFetch(`${d.base}/api/permissions`, { headers: { cookie: session } })).status, 200);
  });

  it('lets old project hooks report from this Mac without a token', async () => {
    assert.notEqual((await rawFetch(`${d.base}/project?root=${encodeURIComponent(tmp)}&create=0`)).status, 401);
    assert.equal((await rawFetch(`${d.base}/project?root=${encodeURIComponent(tmp)}`)).status, 401, 'but not create a project');
  });

  it('an agent can ask for approvals but not decide them, grant itself tools, or speak as the user', async () => {
    await call('POST', '/api/conversations/dm:main/messages', { text: 'SELF_APPROVE' });
    let reply = '';
    for (let i = 0; i < 100 && !reply; i++) {
      const { messages } = await call('GET', '/api/conversations/dm%3Amain/messages');
      reply = messages.find((m: any) => m.author === 'main' && /self-approve/.test(m.body))?.body ?? '';
      if (!reply) await new Promise((r) => setTimeout(r, 150));
    }
    assert.match(reply, /self-approve 403 grant 403 as-user 403 pending pending/);
    const pending = await call('GET', '/api/approvals');
    assert.ok(pending.some((a: any) => a.tool === 'Bash' && a.status === 'pending'), 'its request still waits for the user');
    assert.ok(!(await call('GET', '/api/permissions')).some?.((p: any) => p.tool === 'Bash' && p.policy === 'allow'), 'no standing Bash grant');
  });
});
