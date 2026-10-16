import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';
import { redact } from './secrets.js';

const FIX = join(import.meta.dirname, '..', '..', 'test', 'fixtures');

describe('secrets (fake 1Password, Bitwarden and Secrets Manager CLIs)', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-secrets-')));
  const vault = join(tmp, 'vault.json');
  const ws = join(tmp, 'ws');
  let d: TestDaemon;
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${r.data.error}`);
    return r.data;
  };
  const store = () => JSON.parse(readFileSync(vault, 'utf8'));
  const argv = () => readFileSync(vault + '.argv', 'utf8');
  /** run_with_secrets as the brain MCP tool does it: ticket, user's answer, execute. */
  const runAs = async (command: string, secrets: string[], decision: 'allow' | 'deny' = 'allow') => {
    const t = await call('POST', '/api/secrets/run', { role: 'main', conversation: 'dm:main', command, secrets });
    assert.equal(t.status, 'pending');
    assert.equal((await raw('POST', `/api/secrets/tickets/${t.ticket}/execute`, {})).status, 409, 'nothing runs before the user answers');
    await call('POST', `/api/approvals/${t.approval}`, { decision });
    return raw('POST', `/api/secrets/tickets/${t.ticket}/execute`, {});
  };

  before(async () => {
    d = await startDaemon({
      dbPath: null,
      env: {
        BRAIN_HOME: join(tmp, 'home'),
        FAKE_VAULT: vault,
        BRAIN_OP_BIN: join(FIX, 'fake-op.mjs'),
        BRAIN_BW_BIN: join(FIX, 'fake-bw.mjs'),
        BRAIN_BWS_BIN: join(FIX, 'fake-bws.mjs'),
        BRAIN_SECURITY_BIN: join(FIX, 'fake-security.mjs'),
        BRAIN_AUTH_BIN: join(FIX, 'fake-auth.mjs'),
      },
    });
    await call('POST', '/api/workspace', { path: ws });
  });
  after(async () => {
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to store anything until a password manager is chosen', async () => {
    const r = await raw('POST', '/api/secrets', { name: 'X_KEY', value: 'abcdef' });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'not_configured');
  });

  it('1Password: saves given and generated values without putting them in argv, and lists names only', async () => {
    await call('POST', '/api/secrets/settings', { provider: '1password' });
    await call('POST', '/api/secrets', { name: 'STRIPE_API_KEY', value: 'sk_test_supersecret123', note: 'test key' });
    const gen = await call('POST', '/api/secrets', { name: 'JWT_SIGNING_KEY', generate: { bytes: 32 } });
    assert.equal(gen.kind, 'generated');
    const s = store();
    assert.equal(s.items['op:AI Brain/STRIPE_API_KEY'], 'sk_test_supersecret123');
    const jwt = s.items['op:AI Brain/JWT_SIGNING_KEY'];
    assert.ok(jwt.length >= 40);
    assert.ok(!argv().includes('sk_test_supersecret123') && !argv().includes(jwt), 'values went in on stdin');
    const list = JSON.stringify(await call('GET', '/api/secrets'));
    assert.ok(list.includes('STRIPE_API_KEY') && !list.includes('sk_test_supersecret123') && !list.includes(jwt), 'no route returns values');
    assert.equal((await raw('POST', '/api/secrets', { name: 'lower-case', value: 'abcdef' })).status, 400);
  });

  it('run_with_secrets runs only the approved command, once, and blanks the values in its output', async () => {
    const r = await runAs('echo "key=$STRIPE_API_KEY"; printf %s "$STRIPE_API_KEY" | base64', ['STRIPE_API_KEY']);
    assert.equal(r.status, 200);
    assert.equal(r.data.code, 0);
    assert.ok(!r.data.output.includes('sk_test_supersecret123'), r.data.output);
    assert.ok(!r.data.output.includes(Buffer.from('sk_test_supersecret123').toString('base64')));
    assert.match(r.data.output, /key=\[secret\]/);
    const card = (await call('GET', '/api/conversations/dm%3Amain/messages')).messages.find((m: any) => m.kind === 'approval' && m.meta.tool === 'run_with_secrets');
    assert.match(card.body, /STRIPE_API_KEY/);
    assert.match(card.meta.input.command, /echo/);
  });

  it('a denied card runs nothing; unknown names are refused up front', async () => {
    const r = await runAs('touch ran.txt', ['STRIPE_API_KEY'], 'deny');
    assert.equal(r.status, 403);
    assert.throws(() => readFileSync(join(ws, 'ran.txt')));
    assert.equal((await raw('POST', '/api/secrets/run', { role: 'main', conversation: 'dm:main', command: 'true', secrets: ['NOPE_KEY'] })).status, 404);
  });

  it('moves a value out of a .env file without returning it, leaving a pointer', async () => {
    mkdirSync(join(ws, 'projects', 'demo'), { recursive: true });
    writeFileSync(join(ws, 'projects', 'demo', '.env'), 'PORT=3000\nDATABASE_URL="postgres://u:pw-in-file@db/x"\n');
    await call('POST', '/api/secrets', { name: 'DEMO_DATABASE_URL', from_file: { path: 'projects/demo/.env', key: 'DATABASE_URL' } });
    const env = readFileSync(join(ws, 'projects', 'demo', '.env'), 'utf8');
    assert.ok(!env.includes('pw-in-file') && env.includes('PORT=3000') && env.includes('moved to 1Password as DEMO_DATABASE_URL'));
    assert.equal(store().items['op:AI Brain/DEMO_DATABASE_URL'], 'postgres://u:pw-in-file@db/x');
    assert.equal((await raw('POST', '/api/secrets', { name: 'OUTSIDE_KEY', from_file: { path: '../../etc/hosts', key: 'X' } })).status, 404, 'only files inside the workspace');
  });

  it('rotates generated secrets, not keys issued elsewhere', async () => {
    const before_ = store().items['op:AI Brain/JWT_SIGNING_KEY'];
    await call('POST', '/api/secrets/JWT_SIGNING_KEY/rotate');
    assert.notEqual(store().items['op:AI Brain/JWT_SIGNING_KEY'], before_);
    assert.equal((await raw('POST', '/api/secrets/STRIPE_API_KEY/rotate')).status, 400);
  });

  it('request_secret posts a card; saving from the card answers it in the thread', async () => {
    const { message } = await call('POST', '/api/secrets/request', { role: 'main', conversation: 'dm:main', name: 'RESEND_API_KEY', purpose: 'Send emails', url: 'https://resend.com/api-keys' });
    await call('POST', '/api/secrets', { name: 'RESEND_API_KEY', value: 're_123456789', request: message });
    const msgs = (await call('GET', '/api/conversations/dm%3Amain/messages')).messages;
    assert.equal(msgs.find((m: any) => m.id === message).meta.status, 'saved');
    assert.match(msgs[msgs.length - 1].body, /Saved RESEND_API_KEY to 1Password/);
  });

  it('Bitwarden (Vaultwarden): needs the server and an unlock; optional Touch ID gates each use', async () => {
    await call('POST', '/api/secrets/settings', { provider: 'bitwarden' });
    assert.equal((await raw('POST', '/api/secrets/bitwarden/server', { server: 'http://vault.example.com' })).status, 400, 'https only');
    await call('POST', '/api/secrets/bitwarden/server', { server: 'https://vault.example.com' });
    assert.equal((await raw('POST', '/api/secrets', { name: 'BW_TOKEN_A', value: 'bw-value-1' })).data.code, 'locked');
    assert.equal((await raw('POST', '/api/secrets/bitwarden/unlock', { password: 'wrong' })).status, 403);
    await call('POST', '/api/secrets/bitwarden/unlock', { password: 'correct horse' });
    assert.equal((await call('GET', '/api/secrets')).bitwarden.unlocked, true);
    await call('POST', '/api/secrets', { name: 'BW_TOKEN_A', value: 'bw-value-1' });
    assert.ok(!argv().includes('correct horse') && !argv().includes('bw-value-1'), 'master password in env, value on stdin');
    assert.equal((await raw('POST', '/api/secrets', { name: 'STRIPE_API_KEY', value: 'other' })).status, 400, 'a name stays with its provider');

    await call('POST', '/api/secrets/settings', { confirmOnMac: true });
    writeFileSync(vault + '.deny', '');
    assert.equal((await runAs('echo $BW_TOKEN_A', ['BW_TOKEN_A'])).status, 403, 'Touch ID declined');
    rmSync(vault + '.deny');
    const ok = await runAs('echo $BW_TOKEN_A', ['BW_TOKEN_A']);
    assert.equal(ok.data.output.trim(), '[secret]');
    await call('POST', '/api/secrets/settings', { confirmOnMac: false });

    await call('POST', '/api/secrets/bitwarden/lock');
    assert.equal((await runAs('echo $BW_TOKEN_A', ['BW_TOKEN_A'])).data.code, 'locked');
  });

  it('Bitwarden Secrets Manager: token in the Keychain via stdin, project chosen, then saves and runs', async () => {
    await call('POST', '/api/secrets/settings', { provider: 'bws' });
    assert.equal((await raw('POST', '/api/secrets/bws/token', { token: 'short' })).status, 400);
    const st = await call('POST', '/api/secrets/bws/token', { token: '0.machine.token-for-tests' });
    assert.ok(!argv().includes('0.machine.token-for-tests'), 'the token is never an argument');
    assert.equal(st.bws.ready, false);
    assert.deepEqual(st.bws.projects, [{ id: 'proj-1', name: 'ai-brain' }]);
    await call('POST', '/api/secrets/settings', { bws: { projectId: 'proj-1' } });
    await call('POST', '/api/secrets', { name: 'SENTRY_DSN', value: 'https://dsn.example/1' });
    const r = await runAs('echo "dsn: $SENTRY_DSN"', ['SENTRY_DSN']);
    assert.equal(r.data.output.trim(), 'dsn: [secret]');
    await call('DELETE', '/api/secrets/SENTRY_DSN');
    assert.ok(!JSON.stringify(store().items).includes('dsn.example'));
  });

  it('redacts raw, base64 and URL-encoded forms', () => {
    assert.equal(redact('a p@ss:w0rd b cEBzczp3MHJk c p%40ss%3Aw0rd', ['p@ss:w0rd']), 'a [secret] b [secret] c [secret]');
  });
});
