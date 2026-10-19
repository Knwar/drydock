// Local services: database and other servers on the user's network that apps
// can use when they run locally. The user registers a server once (admin login
// kept in their password manager). When a project's run recipe needs, say,
// "postgres as DATABASE_URL", Drydock creates that project's own database and
// a user that can reach only it, saves the connection URL as a project secret,
// and injects it when the app starts. It only ever touches databases it made
// (fixed aib_ prefix, recorded here). With no matching server, it falls back to
// a Docker container per project.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { DB } from '../core/db.js';
import { defineSchema } from './schema.js';
import { cli, getSecret, readSecrets, SecretError, storeSecret, deleteSecret, secretSettings } from './secrets.js';

defineSchema(`
CREATE TABLE IF NOT EXISTS local_services (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,          -- postgres | mysql | mongodb | redis | rabbitmq | s3 | smtp | other
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  tls           INTEGER NOT NULL DEFAULT 0,
  admin_user    TEXT,                   -- databases: the admin login's user name
  secret        TEXT,                   -- databases: the admin password; others: the full connection URL
  projects      TEXT,                   -- JSON array of project ids allowed, or NULL for all
  max_databases INTEGER NOT NULL DEFAULT 20,
  check_json    TEXT,                   -- last test: {ok, version, error, at}
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS service_databases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id  TEXT NOT NULL,             -- a local_services id, or docker:<type>
  project_id  TEXT NOT NULL,
  env         TEXT NOT NULL DEFAULT 'dev',
  as_name     TEXT NOT NULL,             -- the env var the app reads, e.g. DATABASE_URL
  db_name     TEXT NOT NULL,
  db_user     TEXT NOT NULL,
  secret      TEXT NOT NULL,             -- the secret holding the connection URL
  created_at  INTEGER NOT NULL,
  UNIQUE (project_id, env, as_name)
);
`);

export const DB_TYPES = ['postgres', 'mysql', 'mongodb'] as const;
export const SERVICE_TYPES = [...DB_TYPES, 'redis', 'rabbitmq', 's3', 'smtp', 'other'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
const isDb = (t: string): t is (typeof DB_TYPES)[number] => (DB_TYPES as readonly string[]).includes(t);
export const DEFAULT_PORT: Record<ServiceType, number> = { postgres: 5432, mysql: 3306, mongodb: 27017, redis: 6379, rabbitmq: 5672, s3: 9000, smtp: 1025, other: 0 };

export interface LocalService {
  id: string;
  name: string;
  type: ServiceType;
  host: string;
  port: number;
  tls: boolean;
  admin_user: string | null;
  secret: string | null;
  projects: string[] | null;
  max_databases: number;
  check: { ok: boolean; version?: string; error?: string; at: number } | null;
  created_at: number;
  databases: number;
}

const row2service = (r: any, db: DB): LocalService => ({
  id: r.id,
  name: r.name,
  type: r.type,
  host: r.host,
  port: r.port,
  tls: Boolean(r.tls),
  admin_user: r.admin_user,
  secret: r.secret,
  projects: r.projects ? JSON.parse(r.projects) : null,
  max_databases: r.max_databases,
  check: r.check_json ? JSON.parse(r.check_json) : null,
  created_at: r.created_at,
  databases: (db.prepare('SELECT COUNT(*) AS n FROM service_databases WHERE service_id = ?').get(r.id) as { n: number }).n,
});

export const listServices = (db: DB): LocalService[] => (db.prepare('SELECT * FROM local_services ORDER BY name').all() as any[]).map((r) => row2service(r, db));
export const getService = (db: DB, id: string): LocalService | undefined => {
  const r = db.prepare('SELECT * FROM local_services WHERE id = ?').get(id);
  return r ? row2service(r, db) : undefined;
};

export function saveService(db: DB, input: Partial<LocalService> & { name: string; type: string; host: string }): LocalService {
  if (!(SERVICE_TYPES as readonly string[]).includes(input.type)) throw new SecretError(`Unknown type ${input.type}`, 'invalid');
  if (!/^[A-Za-z0-9.-]+$/.test(input.host)) throw new SecretError('Enter a host name or IP address, e.g. nas.local or 192.168.1.20', 'invalid');
  const type = input.type as ServiceType;
  const port = Number(input.port) || DEFAULT_PORT[type];
  if (!port || port > 65535) throw new SecretError('Enter a port.', 'invalid');
  if (input.secret && !getSecret(db, input.secret)) throw new SecretError(`No secret named ${input.secret}`, 'not_found');
  if (isDb(type) && (!input.admin_user || !input.secret)) throw new SecretError('A database server needs an admin user and its password (a saved secret).', 'invalid');
  const id = input.id ?? `${type}-${randomBytes(3).toString('hex')}`;
  db.prepare(
    `INSERT INTO local_services (id, name, type, host, port, tls, admin_user, secret, projects, max_databases, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host, port = excluded.port, tls = excluded.tls, admin_user = excluded.admin_user, secret = excluded.secret, projects = excluded.projects, max_databases = excluded.max_databases`,
  ).run(id, input.name.trim().slice(0, 60), type, input.host, port, input.tls ? 1 : 0, input.admin_user ?? null, input.secret ?? null, input.projects ? JSON.stringify(input.projects) : null, Math.max(1, Number(input.max_databases) || 20), Date.now());
  return getService(db, id)!;
}

export function removeService(db: DB, id: string): void {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM service_databases WHERE service_id = ?').get(id) as { n: number }).n;
  if (n) throw new SecretError(`Drydock still has ${n} database(s) on this server. Delete them first, or keep the server.`, 'invalid');
  db.prepare('DELETE FROM local_services WHERE id = ?').run(id);
}

// ── drivers ──────────────────────────────────────────────────────

interface Conn {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
}
export interface Driver {
  version(c: Conn): Promise<string>;
  /** Create (or re-password) the database and its own user; idempotent. */
  ensure(c: Conn, name: string, user: string, password: string): Promise<void>;
  drop(c: Conn, name: string, user: string): Promise<void>;
  url(host: string, port: number, tls: boolean, name: string, user: string, password: string): string;
}

const enc = encodeURIComponent;

const postgres: Driver = {
  async version(c) {
    return withPg(c, async (cl) => String((await cl.query('SHOW server_version')).rows[0].server_version));
  },
  async ensure(c, name, user, password) {
    await withPg(c, async (cl) => {
      const u = cl.escapeIdentifier(user);
      const exists = (await cl.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rowCount;
      await cl.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${u} LOGIN PASSWORD ${cl.escapeLiteral(password)}`);
      if (!(await cl.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await cl.query(`CREATE DATABASE ${cl.escapeIdentifier(name)} OWNER ${u}`);
      await cl.query(`REVOKE CONNECT ON DATABASE ${cl.escapeIdentifier(name)} FROM PUBLIC`);
    });
  },
  async drop(c, name, user) {
    await withPg(c, async (cl) => {
      await cl.query(`DROP DATABASE IF EXISTS ${cl.escapeIdentifier(name)} WITH (FORCE)`);
      await cl.query(`DROP ROLE IF EXISTS ${cl.escapeIdentifier(user)}`);
    });
  },
  url: (host, port, tls, name, user, password) => `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${name}${tls ? '?sslmode=require' : ''}`,
};

async function withPg<T>(c: Conn, fn: (cl: import('pg').Client) => Promise<T>): Promise<T> {
  const { default: pg } = await import('pg');
  const cl = new pg.Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: 'postgres', ssl: c.tls ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 8000 });
  await cl.connect();
  try {
    return await fn(cl);
  } finally {
    await cl.end().catch(() => undefined);
  }
}

const mysql: Driver = {
  async version(c) {
    return withMysql(c, async (cn) => String(((await cn.query('SELECT VERSION() AS v')) as any)[0][0].v));
  },
  async ensure(c, name, user, password) {
    await withMysql(c, async (cn) => {
      await cn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
      await cn.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [user, password]);
      await cn.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [user, password]);
      await cn.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@'%'`, [user]);
    });
  },
  async drop(c, name, user) {
    await withMysql(c, async (cn) => {
      await cn.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await cn.query(`DROP USER IF EXISTS ?@'%'`, [user]);
    });
  },
  url: (host, port, tls, name, user, password) => `mysql://${enc(user)}:${enc(password)}@${host}:${port}/${name}${tls ? '?ssl={"rejectUnauthorized":false}' : ''}`,
};

async function withMysql<T>(c: Conn, fn: (cn: import('mysql2/promise').Connection) => Promise<T>): Promise<T> {
  const m = await import('mysql2/promise');
  const cn = await m.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password, ssl: c.tls ? { rejectUnauthorized: false } : undefined, connectTimeout: 8000 });
  try {
    return await fn(cn);
  } finally {
    await cn.end().catch(() => undefined);
  }
}

const mongodb: Driver = {
  async version(c) {
    return withMongo(c, async (cl) => String((await cl.db('admin').command({ buildInfo: 1 })).version));
  },
  async ensure(c, name, user, password) {
    await withMongo(c, async (cl) => {
      const d = cl.db(name);
      const have = (await d.command({ usersInfo: user })).users?.length;
      await d.command(have ? { updateUser: user, pwd: password } : { createUser: user, pwd: password, roles: [{ role: 'readWrite', db: name }] });
    });
  },
  async drop(c, name, user) {
    await withMongo(c, async (cl) => {
      const d = cl.db(name);
      await d.command({ dropUser: user }).catch(() => undefined);
      await d.dropDatabase();
    });
  },
  url: (host, port, tls, name, user, password) => `mongodb://${enc(user)}:${enc(password)}@${host}:${port}/${name}?authSource=${name}${tls ? '&tls=true' : ''}`,
};

async function withMongo<T>(c: Conn, fn: (cl: import('mongodb').MongoClient) => Promise<T>): Promise<T> {
  const { MongoClient } = await import('mongodb');
  const cl = new MongoClient(`mongodb://${enc(c.user)}:${enc(c.password)}@${c.host}:${c.port}/?authSource=admin${c.tls ? '&tls=true&tlsAllowInvalidCertificates=true' : ''}`, { serverSelectionTimeoutMS: 8000 });
  await cl.connect();
  try {
    return await fn(cl);
  } finally {
    await cl.close().catch(() => undefined);
  }
}

/** Tests swap every driver for one backed by a JSON file (BRAIN_DB_DRIVER=fake). */
async function fakeDriver(): Promise<Driver> {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const file = process.env.BRAIN_FAKE_DB_FILE!;
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const auth = (c: Conn) => {
    if (c.password !== 'admin-pw') throw new Error('password authentication failed');
    return `${c.host}:${c.port}`;
  };
  return {
    version: async (c) => (auth(c), '16.4-fake'),
    ensure: async (c, name, user, password) => {
      const d = load();
      d[auth(c)] = { ...d[auth(c)], [name]: { user, password } };
      writeFileSync(file, JSON.stringify(d));
    },
    drop: async (c, name) => {
      const d = load();
      delete d[auth(c)]?.[name];
      writeFileSync(file, JSON.stringify(d));
    },
    url: postgres.url,
  };
}

const driverFor = async (type: string): Promise<Driver> => {
  if (process.env.BRAIN_DB_DRIVER === 'fake') return fakeDriver();
  if (type === 'postgres') return postgres;
  if (type === 'mysql') return mysql;
  if (type === 'mongodb') return mongodb;
  throw new SecretError(`${type} has no database to create`, 'invalid');
};

async function adminConn(db: DB, s: LocalService): Promise<Conn> {
  const env = await readSecrets(db, [s.secret!]);
  return { host: s.host, port: s.port, tls: s.tls, user: s.admin_user!, password: env[s.secret!] };
}

/** Connect and report the version; for non-database services, just open a TCP connection. */
export async function testService(db: DB, id: string): Promise<LocalService> {
  const s = getService(db, id);
  if (!s) throw new SecretError('No such service', 'not_found');
  let check: LocalService['check'];
  try {
    const version = isDb(s.type) ? await (await driverFor(s.type)).version(await adminConn(db, s)) : await tcpCheck(s.host, s.port);
    check = { ok: true, version, at: Date.now() };
  } catch (e) {
    check = { ok: false, error: (e as Error).message.slice(0, 300), at: Date.now() };
  }
  db.prepare('UPDATE local_services SET check_json = ? WHERE id = ?').run(JSON.stringify(check), id);
  return getService(db, id)!;
}

async function tcpCheck(host: string, port: number): Promise<string> {
  if (process.env.BRAIN_DB_DRIVER === 'fake') return 'reachable';
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port, timeout: 5000 }, () => (sock.destroy(), resolve('reachable')));
    sock.on('timeout', () => (sock.destroy(), reject(new Error('timed out'))));
    sock.on('error', reject);
  });
}

// ── per-project databases ────────────────────────────────────────

/** aib_<slug>_<env>, within MySQL's 32-character user name limit. */
export function dbName(slug: string, env = 'dev'): string {
  const base = `aib_${slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${env.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
  return base.length <= 30 ? base : `${base.slice(0, 23)}_${createHash('sha1').update(base).digest('hex').slice(0, 6)}`;
}
const secretNameFor = (slug: string, as: string) => `${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}_${as}`.slice(0, 64);

export interface Need {
  type: string;
  as: string;
  /** a registered service's name, when there is more than one of a type */
  service?: string;
}
export interface Resolved {
  as: string;
  secret: string;
  where: string; // "Postgres on nas.local" / "Docker"
  database: string | null;
}

export const projectDatabases = (db: DB, projectId: string) =>
  db.prepare('SELECT d.*, s.name AS service_name, s.host, s.type FROM service_databases d LEFT JOIN local_services s ON s.id = d.service_id WHERE d.project_id = ? ORDER BY d.id').all(projectId) as any[];

function pickService(db: DB, projectId: string, need: Need): LocalService | null {
  const fits = listServices(db).filter((s) => s.type === need.type && (!s.projects || s.projects.includes(projectId)));
  if (need.service) return fits.find((s) => s.name.toLowerCase() === need.service!.toLowerCase()) ?? null;
  return fits.find((s) => s.check?.ok) ?? fits[0] ?? null;
}

/**
 * Make sure the project has what `need` asks for, and say which secret holds
 * its connection URL. Creates the database (and its user) the first time.
 */
export async function resolveNeed(db: DB, project: { id: string; slug: string }, need: Need, env = 'dev'): Promise<Resolved> {
  if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(need.as)) throw new SecretError(`"${need.as}" is not an env var name`, 'invalid');
  const have = db.prepare('SELECT * FROM service_databases WHERE project_id = ? AND env = ? AND as_name = ?').get(project.id, env, need.as) as any;
  if (have && getSecret(db, have.secret)) return { as: need.as, secret: have.secret, where: have.service_id.startsWith('docker:') ? 'Docker' : getService(db, have.service_id)?.name ?? 'a server', database: have.db_name };

  const s = pickService(db, project.id, need);
  if (s && !isDb(s.type)) {
    if (!s.secret) throw new SecretError(`${s.name} has no connection URL saved.`, 'not_configured');
    return { as: need.as, secret: s.secret, where: s.name, database: null };
  }
  if (!secretSettings(db).provider) throw new SecretError('Connect a password manager in Settings › Secrets first: database passwords are kept there.', 'not_configured');
  const name = dbName(project.slug, env);
  const password = randomBytes(18).toString('base64url');
  const secret = secretNameFor(project.slug, need.as);
  let url: string;
  let serviceId: string;
  if (s) {
    if (s.databases >= s.max_databases) throw new SecretError(`${s.name} already has ${s.databases} Drydock databases (the limit you set).`, 'invalid');
    const driver = await driverFor(s.type);
    await driver.ensure(await adminConn(db, s), name, name, password);
    url = driver.url(s.host, s.port, s.tls, name, name, password);
    serviceId = s.id;
  } else {
    url = await dockerEnsure(project.slug, need.type, name, password);
    serviceId = `docker:${need.type}`;
  }
  await storeSecret(db, { name: secret, value: url, kind: 'generated', projectId: project.id, note: `${need.type} for ${project.slug} (${env}), made by Drydock` });
  db.prepare(
    `INSERT INTO service_databases (service_id, project_id, env, as_name, db_name, db_user, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, env, as_name) DO UPDATE SET service_id = excluded.service_id, db_name = excluded.db_name, db_user = excluded.db_user, secret = excluded.secret`,
  ).run(serviceId, project.id, env, need.as, name, name, secret, Date.now());
  return { as: need.as, secret, where: s ? s.name : 'Docker', database: name };
}

/**
 * Dump a database Drydock made into <workspace>/.ai-brain/backups. Uses the
 * container's own dump tool for Docker databases, and pg_dump / mysqldump /
 * mongodump when they are installed for server ones. Returns the file, or null
 * with the reason when it cannot.
 */
export async function backupDatabase(db: DB, id: number): Promise<{ file: string | null; reason?: string }> {
  const { currentWorkspace } = await import('./workspace.js');
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ws = currentWorkspace();
  const r = db.prepare('SELECT * FROM service_databases WHERE id = ?').get(id) as any;
  if (!ws || !r) return { file: null, reason: 'nothing to back up' };
  const dir = join(ws.root, '.ai-brain', 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const type = r.service_id.startsWith('docker:') ? r.service_id.slice(7) : getService(db, r.service_id)?.type;
  const file = join(dir, `${r.db_name}-${stamp}.${type === 'mongodb' ? 'archive' : 'sql'}`);
  const url = (await readSecrets(db, [r.secret]))[r.secret];
  let res;
  if (r.service_id.startsWith('docker:')) {
    const c = container(r.db_name, type);
    const cmd: Record<string, string[]> = {
      postgres: ['pg_dump', '-U', r.db_user, r.db_name],
      mysql: ['sh', '-c', 'exec mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'],
      mongodb: ['sh', '-c', 'exec mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db "$MONGO_INITDB_DATABASE"'],
    };
    if (!cmd[type]) return { file: null, reason: `no backup for ${type}` };
    res = await dumpTo(file, DOCKER(), ['exec', c, ...cmd[type]], {});
  } else {
    // passwords go in env or a 0600 config file, never in argv
    const u = new URL(url);
    const pw = decodeURIComponent(u.password);
    const bare = Object.assign(new URL(url), { password: '' }).toString();
    const mongoCfg = join(dir, `.mongodump-${stamp}.yaml`);
    const tool: Record<string, [string, string[], Record<string, string>]> = {
      postgres: ['pg_dump', ['--dbname', bare], { PGPASSWORD: pw }],
      mysql: ['mysqldump', ['-h', u.hostname, '-P', u.port || '3306', '-u', decodeURIComponent(u.username), r.db_name], { MYSQL_PWD: pw }],
      mongodb: ['mongodump', ['--archive', `--uri=${bare}`, `--config=${mongoCfg}`], {}],
    };
    const t = tool[type];
    if (!t) return { file: null, reason: `no backup for ${type}` };
    if ((await cli('/usr/bin/which', [t[0]])).code !== 0) return { file: null, reason: `${t[0]} is not installed` };
    // the URL (with its password) is passed to the dump tool for this one run
    if (type === 'mongodb') writeFileSync(mongoCfg, `password: ${JSON.stringify(pw)}\n`, { mode: 0o600 });
    try {
      res = await dumpTo(file, t[0], t[1], t[2]);
    } finally {
      rmSync(mongoCfg, { force: true });
    }
  }
  if (res.code !== 0) {
    rmSync(file, { force: true });
    return { file: null, reason: res.stderr.trim().split('\n').pop() || 'the dump failed' };
  }
  return { file };
}

/** Run a dump command with its stdout streamed (bytes intact) into a 0600 file. */
async function dumpTo(file: string, bin: string, args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const { spawn } = await import('node:child_process');
  const { createWriteStream } = await import('node:fs');
  return new Promise((done) => {
    const out = createWriteStream(file, { mode: 0o600 });
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => done({ code: 127, stderr: e.message }));
    child.on('close', (code) => out.end(() => done({ code: code ?? 1, stderr })));
  });
}

/** Delete a database Drydock made (and its user and secret). Callers confirm with the user first. */
export async function dropProjectDatabase(db: DB, id: number): Promise<void> {
  const r = db.prepare('SELECT * FROM service_databases WHERE id = ?').get(id) as any;
  if (!r) throw new SecretError('No such database', 'not_found');
  if (!r.db_name.startsWith('aib_')) throw new SecretError('Refusing to drop a database Drydock did not create.', 'invalid');
  if (r.service_id.startsWith('docker:')) await dockerRemove(r.db_name, r.service_id.slice(7));
  else {
    const s = getService(db, r.service_id);
    if (!s) throw new SecretError('Its server is no longer registered.', 'not_found');
    await (await driverFor(s.type)).drop(await adminConn(db, s), r.db_name, r.db_user);
  }
  if (getSecret(db, r.secret)) await deleteSecret(db, r.secret).catch(() => undefined);
  db.prepare('DELETE FROM service_databases WHERE id = ?').run(id);
}

// ── Docker fallback ──────────────────────────────────────────────

const DOCKER = () => process.env.BRAIN_DOCKER_BIN ?? 'docker';
const IMAGES: Record<string, { image: string; port: number; env: (name: string, pw: string) => Record<string, string>; data: string; url: (port: number, name: string, pw: string) => string }> = {
  postgres: { image: 'postgres:16-alpine', port: 5432, data: '/var/lib/postgresql/data', env: (n, pw) => ({ POSTGRES_DB: n, POSTGRES_USER: n, POSTGRES_PASSWORD: pw }), url: (p, n, pw) => postgres.url('127.0.0.1', p, false, n, n, pw) },
  mysql: { image: 'mysql:8.4', port: 3306, data: '/var/lib/mysql', env: (n, pw) => ({ MYSQL_DATABASE: n, MYSQL_USER: n, MYSQL_PASSWORD: pw, MYSQL_RANDOM_ROOT_PASSWORD: 'yes' }), url: (p, n, pw) => mysql.url('127.0.0.1', p, false, n, n, pw) },
  mongodb: { image: 'mongo:7', port: 27017, data: '/data/db', env: (n, pw) => ({ MONGO_INITDB_ROOT_USERNAME: n, MONGO_INITDB_ROOT_PASSWORD: pw, MONGO_INITDB_DATABASE: n }), url: (p, n, pw) => `mongodb://${enc(n)}:${enc(pw)}@127.0.0.1:${p}/${n}?authSource=admin` },
  redis: { image: 'redis:7-alpine', port: 6379, data: '/data', env: () => ({}), url: (p) => `redis://127.0.0.1:${p}` },
};

export async function dockerAvailable(): Promise<boolean> {
  return (await cli(DOCKER(), ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 8000 })).code === 0;
}

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

const container = (name: string, type: string) => `${name}-${type}`.replace(/_/g, '-');

async function dockerEnsure(slug: string, type: string, name: string, password: string): Promise<string> {
  const spec = IMAGES[type];
  if (!spec) throw new SecretError(`No local server for ${type} is registered (Settings › Local services), and Drydock cannot start one in Docker.`, 'not_configured');
  if (!(await dockerAvailable())) throw new SecretError(`No ${type} server is registered (Settings › Local services) and Docker is not running. Register one, or start Docker or OrbStack.`, 'not_configured');
  const port = await freePort();
  const c = container(name, type);
  await cli(DOCKER(), ['rm', '-f', c]);
  const env = spec.env(name, password);
  // -e NAME with no value: docker takes it from its own environment, so passwords stay out of argv
  const r = await cli(
    DOCKER(),
    ['run', '-d', '--name', c, '--label', `ai-brain.project=${slug}`, '--restart', 'unless-stopped', '-p', `127.0.0.1:${port}:${spec.port}`, '-v', `${c}:${spec.data}`, ...Object.keys(env).flatMap((k) => ['-e', k]), spec.image, ...(type === 'redis' ? ['redis-server', '--appendonly', 'yes'] : [])],
    { env, timeoutMs: 600_000 },
  );
  if (r.code !== 0) throw new SecretError(`Docker could not start ${type}: ${r.stderr.trim().split('\n').pop()}`);
  return spec.url(port, name, password);
}

export async function dockerStart(name: string, type: string): Promise<void> {
  await cli(DOCKER(), ['start', container(name, type)]);
}
export async function dockerStop(name: string, type: string): Promise<void> {
  await cli(DOCKER(), ['stop', container(name, type)]);
}
async function dockerRemove(name: string, type: string): Promise<void> {
  const c = container(name, type);
  await cli(DOCKER(), ['rm', '-f', c]);
  await cli(DOCKER(), ['volume', 'rm', c]);
}
