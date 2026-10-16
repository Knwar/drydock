import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDaemon, type TestDaemon } from '../daemon/test-daemon.js';
import { dbName } from './services.js';
import { detectRecipe, validateRecipe } from './live.js';

const FIX = join(import.meta.dirname, '..', '..', 'test', 'fixtures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The project's app: answers with what it was given, and /crash exits.
const APP = `
const http = require('node:http');
console.log('key is ' + process.env.APP_KEY);
http.createServer((req, res) => {
  if (req.url === '/crash') { res.end('bye'); setTimeout(() => process.exit(1), 10); return; }
  res.end(JSON.stringify({ v: VERSION, key: process.env.APP_KEY ? 'present' : 'missing', db: process.env.DATABASE_URL, home: !!process.env.HOME, brain: Object.keys(process.env).filter((k) => k.startsWith('BRAIN_')) }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

describe('live apps on this Mac (fake password manager and database server)', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'brain-live-')));
  const ws = join(tmp, 'ws');
  let d: TestDaemon;
  let id = '';
  let root = '';
  let slug = '';
  let port = 0;
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(d.base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${r.data.error}`);
    return r.data;
  };
  /** GET through the daemon's <slug>.localhost proxy. */
  const visit = (path = '/', host = `${slug}.localhost:${port}`) =>
    new Promise<{ status: number; body: string }>((done, fail) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', fail);
      req.end();
    });
  const until = async (pred: () => Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return;
      await sleep(200);
    }
    throw new Error('timed out');
  };
  const status = () => call('GET', `/api/projects/${id}/live`);
  const writeApp = (version: number) => writeFileSync(join(root, 'server.js'), APP.replace('VERSION', String(version)));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });

  before(async () => {
    d = await startDaemon({
      dbPath: null,
      env: {
        BRAIN_HOME: join(tmp, 'home'),
        FAKE_VAULT: join(tmp, 'vault.json'),
        BRAIN_OP_BIN: join(FIX, 'fake-op.mjs'),
        BRAIN_DB_DRIVER: 'fake',
        BRAIN_FAKE_DB_FILE: join(tmp, 'dbserver.json'),
        BRAIN_DOCKER_BIN: '/nonexistent/docker',
        BRAIN_LIVE_TICK_MS: '400',
      },
    });
    port = Number(new URL(d.base).port);
    await call('POST', '/api/workspace', { path: ws });
    const p = await call('POST', '/api/projects', { name: 'Shop Demo', description: 'A test shop.' });
    id = p.id;
    root = p.root;
    slug = root.split('/').pop()!;
    await call('POST', '/api/secrets/settings', { provider: '1password' });
    await call('POST', '/api/secrets', { name: 'APP_KEY', value: 'app-key-value-123' });
    await call('POST', '/api/secrets', { name: 'PG_ADMIN', value: 'admin-pw' });
  });
  after(async () => {
    await call('POST', `/api/projects/${id}/live/stop`).catch(() => undefined);
    await d?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is not runnable without a recipe, and refuses a bad one', async () => {
    const s = await status();
    assert.equal(s.runnable, false);
    assert.match((await call('POST', `/api/projects/${id}/live/start`, {})).message, /Not runnable yet/);
    assert.equal((await raw('POST', `/api/projects/${id}/live/recipe`, { recipe: { kind: 'web', services: [{ name: 'web', command: 'x', cwd: '../../elsewhere' }] } })).status, 400);
  });

  it('registers a database server and tests the admin login', async () => {
    assert.equal((await raw('POST', '/api/local-services', { name: 'NAS Postgres', type: 'postgres', host: 'nas.local', admin_user: 'postgres' })).status, 400, 'needs the admin password secret');
    const s = await call('POST', '/api/local-services', { name: 'NAS Postgres', type: 'postgres', host: 'nas.local', admin_user: 'postgres', secret: 'PG_ADMIN' });
    assert.equal(s.port, 5432);
    assert.equal(s.check.ok, true);
    assert.equal(s.check.version, '16.4-fake');
  });

  it('first Start creates the database, asks to approve secrets, then runs behind <slug>.localhost', async () => {
    writeApp(1);
    await call('POST', `/api/projects/${id}/live/recipe`, { recipe: { kind: 'web', services: [{ name: 'web', command: 'node server.js', primary: true }], needs: [{ type: 'postgres', as: 'DATABASE_URL' }], secrets: ['APP_KEY'] } });
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'app v1');

    const first = await call('POST', `/api/projects/${id}/live/start`, {});
    assert.equal(first.status, 'needs_approval');
    const dbSecret = `${slug.toUpperCase().replace(/-/g, '_')}_DATABASE_URL`;
    assert.deepEqual(first.needsApproval.sort(), ['APP_KEY', dbSecret].sort());
    const server = JSON.parse(readFileSync(join(tmp, 'dbserver.json'), 'utf8'))['nas.local:5432'];
    assert.ok(server[dbName(slug)], 'its own database exists on the server');

    assert.equal((await call('POST', `/api/projects/${id}/live/start`, { by: 'agent' })).status, 'needs_approval', 'an agent cannot approve secrets');
    await call('POST', `/api/projects/${id}/live/start`, { approve: first.needsApproval });
    await until(async () => (await status()).status === 'live');
    const s = await status();
    assert.equal(s.services[0].url, `http://${slug}.localhost:${port}`);
    assert.equal(s.databases[0].where, 'NAS Postgres');

    const page = JSON.parse((await visit()).body);
    assert.equal(page.v, 1);
    assert.equal(page.key, 'present');
    assert.match(page.db, new RegExp(`^postgresql://${dbName(slug)}:.+@nas\\.local:5432/${dbName(slug)}$`));
    assert.equal(page.home, true);
    assert.deepEqual(page.brain, [], "AI Brain's own env is not passed to the app");
    const log = (await call('GET', `/api/projects/${id}/live/logs`)).log;
    assert.match(log, /key is \[secret\]/);
    assert.ok(!log.includes('app-key-value-123'));
  });

  it('pause freezes it and resume brings it back', async () => {
    await call('POST', `/api/projects/${id}/live/pause`);
    assert.equal((await status()).status, 'paused');
    const r = await visit();
    assert.equal(r.status, 503);
    assert.match(r.body, /paused/);
    await call('POST', `/api/projects/${id}/live/resume`);
    await until(async () => (await status()).status === 'live');
    assert.equal(JSON.parse((await visit()).body).v, 1);
  });

  it('restarts by itself after a merge to main', async () => {
    writeApp(2);
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'app v2');
    await until(async () => {
      const r = await visit().catch(() => ({ status: 0, body: '' }));
      return r.status === 200 && JSON.parse(r.body).v === 2;
    });
  });

  it('restarts after a crash, and gives up after 3 in 10 minutes', async () => {
    await visit('/crash');
    await sleep(300);
    for (let i = 0; i < 3; i++) {
      await until(async () => (await visit().catch(() => ({ status: 0 }))).status === 200, 30_000);
      await visit('/crash');
      await sleep(300); // let it exit before checking it is back
    }
    await until(async () => (await status()).status === 'crashed', 30_000);
    const dm = (await call('GET', '/api/conversations/dm%3Amain/messages')).messages;
    assert.match(dm[dm.length - 1].body, /crashed on this Mac/);
  });

  it('stop frees it; the proxy says it is not running', async () => {
    await call('POST', `/api/projects/${id}/live/stop`);
    assert.equal((await status()).status, 'stopped');
    const r = await visit();
    assert.equal(r.status, 503);
    assert.match(r.body, /not running/);
    assert.equal((await visit('/', `other.localhost:${port}`)).status, 503, 'unknown apps get a page, not the AI Brain API');
  });

  it('a server with databases cannot be removed; resetting drops only what AI Brain made', async () => {
    const svc = (await call('GET', '/api/local-services')).services[0];
    assert.equal((await raw('DELETE', `/api/local-services/${svc.id}`)).status, 400);
    const dbId = (await status()).databases[0].id;
    const r = await call('POST', `/api/projects/${id}/databases/${dbId}/reset`);
    assert.equal(r.backup.file, null, 'no pg_dump here, so it says why');
    assert.ok(!JSON.parse(readFileSync(join(tmp, 'dbserver.json'), 'utf8'))['nas.local:5432'][dbName(slug)]);
    await call('DELETE', `/api/local-services/${svc.id}`);
  });

  it('with no server and no Docker, the card says what is missing', async () => {
    const r = await call('POST', `/api/projects/${id}/live/start`, {});
    assert.equal(r.status, 'error');
    assert.match(r.message, /Docker is not running/);
  });
});

describe('recipes', () => {
  it('detects Vite and Next.js projects, and validates by hand-written ones', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brain-recipe-')));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }));
    assert.match(detectRecipe(dir)!.services![0].command, /vite --port \$PORT/);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const r = detectRecipe(dir)!;
    assert.match(r.services![0].command, /next dev -p \$PORT/);
    assert.equal(r.install, 'pnpm install');
    mkdirSync(join(dir, 'empty'));
    assert.equal(detectRecipe(join(dir, 'empty')), null);
    assert.throws(() => validateRecipe({ kind: 'app' }, dir), /launch/);
    assert.throws(() => validateRecipe({ kind: 'web', services: [{ name: 'Web', command: 'x' }] }, dir), /lowercase/);
    assert.throws(() => validateRecipe({ kind: 'web', services: [{ name: 'web', command: 'x' }], needs: [{ type: 'postgres', as: 'db' }] }, dir), /needs/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('database names stay within MySQL limits', () => {
    assert.equal(dbName('notes-app'), 'aib_notes_app_dev');
    assert.ok(dbName('a-very-long-project-name-that-keeps-going').length <= 30);
  });
});
