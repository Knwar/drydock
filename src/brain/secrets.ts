// Secrets: API keys, passwords and signing keys live in the user's password
// manager (1Password, a Bitwarden/Vaultwarden vault, or Bitwarden Secrets
// Manager), never in Drydock's
// DB, the vault, a repo, a prompt or a log. Drydock keeps only a registry of
// names and where each one lives. Agents work with names:
//   - save_secret stores a value (given, generated here, or moved out of a
//     .env file without the agent reading it);
//   - request_secret asks the user to paste a key into a card;
//   - run_with_secrets runs one command with secrets in its environment, after
//     the user approves the card (and, if they turned it on, confirms with
//     Touch ID). Output is returned with the values blanked out. Agents never
//     receive a value.
// The CLIs are `op` (1Password), `bw` (Bitwarden password manager, pointed at
// the user's Vaultwarden server) and `bws` (Bitwarden Secrets Manager, with a
// machine-account token kept in the macOS Keychain). Values go to op and bw on
// stdin; bws only takes them as arguments, so they are briefly visible to
// other processes of this user (`ps`) while it runs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DB } from '../core/db.js';
import { defineSchema } from './schema.js';
import { getSetting, putSetting } from './settings.js';
import { currentWorkspace, isInside } from './workspace.js';

defineSchema(`
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,          -- UPPER_SNAKE, the env var it is injected as
  project_id TEXT,
  provider   TEXT NOT NULL,             -- 1password | bitwarden | bws
  ref        TEXT NOT NULL,             -- op://vault/item/field, or the Bitwarden item / Secrets Manager secret id
  kind       TEXT NOT NULL,             -- generated | provided
  note       TEXT,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  used_at    INTEGER
);
`);

export type Provider = '1password' | 'bitwarden' | 'bws';
export const PROVIDER_NAME: Record<Provider, string> = { '1password': '1Password', bitwarden: 'Bitwarden', bws: 'Bitwarden Secrets Manager' };
export interface SecretSettings {
  provider: Provider | null;
  /** also ask for Touch ID (or the Mac password) before each use, on top of the approval card */
  confirmOnMac: boolean;
  onepassword: { vault: string; account: string | null; askEveryTime: boolean };
  bitwarden: { server: string | null; folder: string; unlockMinutes: number };
  bws: { serverUrl: string | null; projectId: string | null };
}
export interface SecretRow {
  name: string;
  project_id: string | null;
  provider: Provider;
  ref: string;
  kind: 'generated' | 'provided';
  note: string | null;
  created_at: number;
  rotated_at: number;
  used_at: number | null;
}

export class SecretError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'locked' | 'not_found' | 'denied' | 'cli' | 'invalid' = 'cli',
  ) {
    super(message);
  }
}

const DEFAULTS: SecretSettings = {
  provider: null,
  confirmOnMac: false,
  onepassword: { vault: 'Drydock', account: null, askEveryTime: false },
  bitwarden: { server: null, folder: 'Drydock', unlockMinutes: 15 },
  bws: { serverUrl: null, projectId: null },
};
export const secretSettings = (db: DB): SecretSettings => {
  const s = getSetting<Partial<SecretSettings>>(db, 'brain.secrets', {});
  return { ...DEFAULTS, ...s, onepassword: { ...DEFAULTS.onepassword, ...s.onepassword }, bitwarden: { ...DEFAULTS.bitwarden, ...s.bitwarden }, bws: { ...DEFAULTS.bws, ...s.bws } };
};
export function saveSecretSettings(db: DB, patch: Partial<SecretSettings>): SecretSettings {
  const cur = secretSettings(db);
  const next = { ...cur, ...patch, onepassword: { ...cur.onepassword, ...patch.onepassword }, bitwarden: { ...cur.bitwarden, ...patch.bitwarden }, bws: { ...cur.bws, ...patch.bws } };
  putSetting(db, 'brain.secrets', next);
  return next;
}

export const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export function checkName(name: string): string {
  if (!NAME_RE.test(name)) throw new SecretError('Secret names are UPPER_SNAKE_CASE env var names, e.g. STRIPE_API_KEY', 'invalid');
  return name;
}

// ── CLI plumbing ─────────────────────────────────────────────────

const OP = () => process.env.BRAIN_OP_BIN ?? 'op';
const BW = () => process.env.BRAIN_BW_BIN ?? 'bw';
const BWS = () => process.env.BRAIN_BWS_BIN ?? 'bws';
const SECURITY = () => process.env.BRAIN_SECURITY_BIN ?? '/usr/bin/security';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
/** Run a CLI with optional stdin and extra env. Never logs input or output. */
export function cli(bin: string, args: string[], opts: { input?: string; env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return done({ code: 127, stdout: '', stderr: String((e as Error).message) });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: 127, stdout, stderr: stderr || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(opts.input ?? '');
  });
}

const fail = (what: string, r: Run) => new SecretError(`${what} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0] || `exit ${r.code}`}`);

// ── Touch ID (optional) ──────────────────────────────────────────

/** The compiled Touch ID helper, built once into the workspace from scripts/brain-auth.swift. */
async function authBin(): Promise<string> {
  if (process.env.BRAIN_AUTH_BIN) return process.env.BRAIN_AUTH_BIN;
  const ws = currentWorkspace();
  if (!ws) throw new SecretError('no workspace', 'not_configured');
  const out = join(ws.root, '.ai-brain', 'bin', 'brain-auth');
  const src = join(import.meta.dirname, '..', '..', 'scripts', 'brain-auth.swift');
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) return out;
  mkdirSync(join(ws.root, '.ai-brain', 'bin'), { recursive: true });
  const r = await cli('swiftc', ['-O', '-o', out, src], { timeoutMs: 180_000 });
  if (r.code !== 0) throw new SecretError('Could not build the Touch ID check (needs the Xcode command line tools: xcode-select --install)', 'not_configured');
  return out;
}

/** Ask the person at the Mac to confirm. Throws `denied` when they don't. */
export async function confirmOnMac(reason: string): Promise<void> {
  const r = await cli(await authBin(), [reason], { timeoutMs: 120_000 });
  if (r.code === 0) return;
  throw new SecretError(r.code === 2 ? `This Mac cannot ask for Touch ID or your password: ${r.stderr.trim()}` : 'Not confirmed on the Mac.', 'denied');
}

// ── 1Password (op) ───────────────────────────────────────────────

const opArgs = (s: SecretSettings, args: string[]) => (s.onepassword.account ? [...args, '--account', s.onepassword.account] : args);

/** Homebrew packages for the CLIs that have one (Secrets Manager has none). */
export const INSTALL: Partial<Record<Provider, string[]>> = { '1password': ['install', '--cask', '1password-cli'], bitwarden: ['install', 'bitwarden-cli'] };
const BREW = () => process.env.BRAIN_BREW_BIN ?? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((b) => existsSync(b)) ?? 'brew';

export async function installProvider(p: Provider): Promise<void> {
  const args = INSTALL[p];
  if (!args) throw new SecretError(`${PROVIDER_NAME[p]} has no Homebrew package. Install it by hand.`, 'invalid');
  const r = await cli(BREW(), args, { env: { HOMEBREW_NO_AUTO_UPDATE: '1' }, timeoutMs: 600_000 });
  if (r.code !== 0) throw new SecretError(`Homebrew could not install it: ${(r.stderr || r.stdout).trim().split('\n').pop()}`, 'cli');
}

async function opStatus(s: SecretSettings) {
  const v = await cli(OP(), ['--version']);
  if (v.code !== 0) return { installed: false, ready: false, detail: 'Install the 1Password CLI: brew install 1password-cli, then turn on "Integrate with 1Password CLI" in the 1Password app (Settings › Developer).' };
  return { installed: true, ready: true, version: v.stdout.trim(), detail: `Secrets go to the "${s.onepassword.vault}" vault. The 1Password app asks you to authorize Drydock the first time it uses the CLI.` };
}

async function opEnsureVault(s: SecretSettings) {
  const got = await cli(OP(), opArgs(s, ['vault', 'get', s.onepassword.vault, '--format', 'json']));
  if (got.code === 0) return;
  const made = await cli(OP(), opArgs(s, ['vault', 'create', s.onepassword.vault, '--format', 'json']));
  if (made.code !== 0) throw fail(`Creating the 1Password vault "${s.onepassword.vault}"`, made);
}

async function opSave(s: SecretSettings, name: string, value: string, tags: string[], note: string | null): Promise<string> {
  await opEnsureVault(s);
  // replace an existing item (rotation): archive the old one first
  await cli(OP(), opArgs(s, ['item', 'delete', name, '--vault', s.onepassword.vault, '--archive']));
  const item = {
    title: name,
    category: 'API_CREDENTIAL',
    tags: ['ai-brain', ...tags],
    fields: [
      { id: 'credential', type: 'CONCEALED', purpose: '', label: 'credential', value },
      ...(note ? [{ id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value: note }] : []),
    ],
  };
  // the item JSON (with the value) goes in on stdin, never in argv
  const r = await cli(OP(), opArgs(s, ['item', 'create', '--vault', s.onepassword.vault, '--format', 'json', '-']), { input: JSON.stringify(item) });
  if (r.code !== 0) throw fail('Saving to 1Password', r);
  return `op://${s.onepassword.vault}/${name}/credential`;
}

async function opRead(s: SecretSettings, ref: string): Promise<string> {
  const r = await cli(OP(), opArgs(s, ['read', '--no-newline', ref]));
  if (r.code !== 0) throw fail(`Reading ${ref} from 1Password`, r);
  return r.stdout;
}

async function opDelete(s: SecretSettings, name: string) {
  const r = await cli(OP(), opArgs(s, ['item', 'delete', name, '--vault', s.onepassword.vault, '--archive']));
  if (r.code !== 0 && !/isn't an item|not found/i.test(r.stderr)) throw fail('Archiving in 1Password', r);
}

/** "Ask every time": drop 1Password's CLI authorization so the next use asks for Touch ID again. */
const opForget = (s: SecretSettings) => (s.onepassword.askEveryTime ? cli(OP(), opArgs(s, ['signout'])) : Promise.resolve(null));

// ── Bitwarden / Vaultwarden (bw) ─────────────────────────────────

// The unlocked session lives only in this process's memory and expires.
let bwSession: { key: string; until: number } | null = null;
let bwTimer: NodeJS.Timeout | null = null;
const session = () => (bwSession && bwSession.until > Date.now() ? bwSession.key : null);

export function lockBitwarden(): void {
  if (bwTimer) clearTimeout(bwTimer);
  bwTimer = null;
  if (bwSession) void cli(BW(), ['lock'], { env: { BW_SESSION: bwSession.key } });
  bwSession = null;
}

async function bwStatus(s: SecretSettings) {
  const v = await cli(BW(), ['--version']);
  if (v.code !== 0) return { installed: false, ready: false, detail: 'Install the Bitwarden CLI: brew install bitwarden-cli.' };
  const st = await cli(BW(), ['status'], { env: session() ? { BW_SESSION: session()! } : {} });
  let status: any = {};
  try {
    status = JSON.parse(st.stdout);
  } catch {
    /* older CLI */
  }
  const server = status.serverUrl ?? null;
  if (!s.bitwarden.server) return { installed: true, ready: false, detail: 'Enter your Vaultwarden server address below.' };
  if (server && server.replace(/\/$/, '') !== s.bitwarden.server.replace(/\/$/, '')) return { installed: true, ready: false, detail: `The Bitwarden CLI points at ${server}. Save the server below to switch it.` };
  if (status.status === 'unauthenticated') return { installed: true, ready: false, detail: `Sign the CLI in once in a terminal: bw login (your server: ${s.bitwarden.server}). Drydock never sees your login.` };
  const unlocked = Boolean(session());
  return {
    installed: true,
    ready: true,
    unlocked,
    unlockedUntil: unlocked ? bwSession!.until : null,
    account: status.userEmail ?? null,
    detail: unlocked ? `Unlocked until ${new Date(bwSession!.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.` : 'Locked. Unlock with your master password to let agents use secrets.',
  };
}

/** Point the bw CLI at the user's Vaultwarden server (allowed only while logged out; bw enforces that). */
export async function setBitwardenServer(db: DB, server: string): Promise<void> {
  const url = new URL(server); // throws on junk
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new SecretError('Use an https:// address for your Vaultwarden server.', 'invalid');
  const r = await cli(BW(), ['config', 'server', url.origin]);
  if (r.code !== 0) throw fail('Setting the server (log out of the CLI first: bw logout)', r);
  saveSecretSettings(db, { bitwarden: { ...secretSettings(db).bitwarden, server: url.origin } });
}

/** Unlock with the master password the user typed in the app. The password is used once and dropped. */
export async function unlockBitwarden(db: DB, password: string): Promise<number> {
  if (!password) throw new SecretError('Enter your master password.', 'invalid');
  const r = await cli(BW(), ['unlock', '--passwordenv', 'BRAIN_BW_PASSWORD', '--raw'], { env: { BRAIN_BW_PASSWORD: password } });
  if (r.code !== 0 || !r.stdout.trim()) throw new SecretError('Unlock failed: check the master password, and that the CLI is signed in (bw login).', 'denied');
  const minutes = Math.max(1, secretSettings(db).bitwarden.unlockMinutes);
  bwSession = { key: r.stdout.trim(), until: Date.now() + minutes * 60_000 };
  if (bwTimer) clearTimeout(bwTimer);
  bwTimer = setTimeout(lockBitwarden, minutes * 60_000);
  bwTimer.unref();
  await cli(BW(), ['sync'], { env: { BW_SESSION: bwSession.key } });
  return bwSession.until;
}

function bwEnv(): Record<string, string> {
  const key = session();
  if (!key) throw new SecretError('The Bitwarden vault is locked. Unlock it in Settings › Secrets.', 'locked');
  return { BW_SESSION: key };
}

async function bwFolder(s: SecretSettings): Promise<string> {
  const env = bwEnv();
  const list = await cli(BW(), ['list', 'folders', '--search', s.bitwarden.folder], { env });
  const found = (JSON.parse(list.stdout || '[]') as { id: string; name: string }[]).find((f) => f.name === s.bitwarden.folder);
  if (found) return found.id;
  const made = await cli(BW(), ['create', 'folder'], { env, input: Buffer.from(JSON.stringify({ name: s.bitwarden.folder })).toString('base64') });
  if (made.code !== 0) throw fail('Creating the Bitwarden folder', made);
  return JSON.parse(made.stdout).id;
}

async function bwSave(s: SecretSettings, name: string, value: string, existing: string | null, note: string | null): Promise<string> {
  const env = bwEnv();
  const folderId = await bwFolder(s);
  const item = { type: 1, name, folderId, notes: note ?? 'Managed by Drydock', login: { username: null, password: value, uris: [] }, fields: [], favorite: false, reprompt: 0 };
  const input = Buffer.from(JSON.stringify(item)).toString('base64'); // stdin, not argv
  const r = existing ? await cli(BW(), ['edit', 'item', existing], { env, input }) : await cli(BW(), ['create', 'item'], { env, input });
  if (r.code !== 0) throw fail('Saving to Bitwarden', r);
  return JSON.parse(r.stdout).id;
}

async function bwRead(id: string): Promise<string> {
  const r = await cli(BW(), ['get', 'password', id], { env: bwEnv() });
  if (r.code !== 0) throw fail('Reading from Bitwarden', r);
  return r.stdout.replace(/\n$/, '');
}

async function bwDelete(id: string) {
  const r = await cli(BW(), ['delete', 'item', id], { env: bwEnv() }); // moves to trash
  if (r.code !== 0 && !/not found/i.test(r.stderr)) throw fail('Deleting in Bitwarden', r);
}

// ── Bitwarden Secrets Manager (bws) ──────────────────────────────
// A machine account's access token authorizes the CLI. Drydock keeps it in
// the macOS Keychain (written through `security -i` on stdin, so it never
// shows in argv) and hands it to bws in the environment.

const KC_SERVICE = 'AI Brain: Bitwarden Secrets Manager token'; // Keychain item name: kept from the old name so saved tokens still work
const KC_ACCOUNT = 'ai-brain';

export async function setBwsToken(token: string): Promise<void> {
  if (!/^[\w.:+/=-]{20,}$/.test(token)) throw new SecretError('That does not look like a Secrets Manager access token.', 'invalid');
  const r = await cli(SECURITY(), ['-i'], { input: `add-generic-password -U -a "${KC_ACCOUNT}" -s "${KC_SERVICE}" -w "${token}"\n` });
  if (r.code !== 0 || /error/i.test(r.stderr)) throw new SecretError(`Could not save the token to the Keychain: ${r.stderr.trim()}`);
}

export async function clearBwsToken(): Promise<void> {
  await cli(SECURITY(), ['delete-generic-password', '-a', KC_ACCOUNT, '-s', KC_SERVICE]);
}

async function bwsEnv(s: SecretSettings): Promise<Record<string, string>> {
  const r = await cli(SECURITY(), ['find-generic-password', '-a', KC_ACCOUNT, '-s', KC_SERVICE, '-w']);
  const token = r.stdout.trim();
  if (r.code !== 0 || !token) throw new SecretError('Add a Secrets Manager access token in Settings › Secrets.', 'not_configured');
  return { BWS_ACCESS_TOKEN: token, ...(s.bws.serverUrl ? { BWS_SERVER_URL: s.bws.serverUrl } : {}) };
}

async function bwsJson(s: SecretSettings, args: string[], what: string): Promise<any> {
  const r = await cli(BWS(), [...args, '--output', 'json', '--color', 'no'], { env: await bwsEnv(s) });
  if (r.code !== 0) throw fail(what, r);
  return JSON.parse(r.stdout || 'null');
}

async function bwsStatus(s: SecretSettings) {
  const v = await cli(BWS(), ['--version']);
  if (v.code !== 0) return { installed: false, ready: false, detail: 'Install the Secrets Manager CLI: download bws from github.com/bitwarden/sdk-sm/releases (or run cargo install bws) and put it on your PATH. It has no Homebrew package.' };
  let projects: { id: string; name: string }[] = [];
  try {
    projects = (await bwsJson(s, ['project', 'list'], 'Listing projects')) ?? [];
  } catch (e) {
    return { installed: true, ready: false, detail: (e as Error).message.includes('Settings') ? 'Paste a machine account access token below (Secrets Manager › Machine accounts › Access tokens).' : (e as Error).message };
  }
  const project = projects.find((p) => p.id === s.bws.projectId);
  return {
    installed: true,
    ready: Boolean(project),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    detail: project ? `New secrets go to the "${project.name}" project.` : 'Choose the Secrets Manager project new secrets go to (the machine account needs read and write access to it).',
  };
}

async function bwsSave(s: SecretSettings, name: string, value: string, existing: string | null, note: string | null): Promise<string> {
  if (!s.bws.projectId) throw new SecretError('Choose a Secrets Manager project in Settings › Secrets.', 'not_configured');
  // bws takes the value as an argument; there is no stdin form
  const out = existing
    ? await bwsJson(s, ['secret', 'edit', existing, '--value', value, ...(note ? ['--note', note] : [])], 'Saving to Secrets Manager')
    : await bwsJson(s, ['secret', 'create', name, value, s.bws.projectId, '--note', note ?? 'Managed by Drydock'], 'Saving to Secrets Manager');
  return out.id;
}

async function bwsRead(s: SecretSettings, id: string): Promise<string> {
  return (await bwsJson(s, ['secret', 'get', id], 'Reading from Secrets Manager')).value;
}

async function bwsDelete(s: SecretSettings, id: string) {
  const r = await cli(BWS(), ['secret', 'delete', id], { env: await bwsEnv(s) });
  if (r.code !== 0 && !/not found/i.test(r.stderr)) throw fail('Deleting in Secrets Manager', r);
}

// ── registry + operations ────────────────────────────────────────

export const listSecrets = (db: DB, projectId?: string | null): SecretRow[] =>
  (projectId ? db.prepare('SELECT * FROM secrets WHERE project_id = ? OR project_id IS NULL ORDER BY name').all(projectId) : db.prepare('SELECT * FROM secrets ORDER BY name').all()) as SecretRow[];
export const getSecret = (db: DB, name: string) => db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as SecretRow | undefined;

export async function providerStatus(db: DB) {
  const s = secretSettings(db);
  const [onepassword, bitwarden, bws] = await Promise.all([opStatus(s), bwStatus(s), bwsStatus(s)]);
  return { provider: s.provider, settings: s, onepassword, bitwarden, bws };
}

function activeProvider(db: DB): { s: SecretSettings; provider: Provider } {
  const s = secretSettings(db);
  if (!s.provider) throw new SecretError('No password manager is connected. Choose one in Settings › Secrets.', 'not_configured');
  return { s, provider: s.provider };
}

/** A strong random value: 32 bytes by default, URL-safe base64. */
export const generateValue = (bytes = 32) => randomBytes(Math.min(128, Math.max(16, bytes))).toString('base64url');

/** Store a value under `name` (new or replacing), in the connected manager. Returns the registry row. */
export async function storeSecret(db: DB, input: { name: string; value: string; kind: 'generated' | 'provided'; projectId?: string | null; note?: string | null }): Promise<SecretRow> {
  const name = checkName(input.name);
  if (!input.value) throw new SecretError('Empty value.', 'invalid');
  const { s, provider } = activeProvider(db);
  const old = getSecret(db, name);
  if (old && old.provider !== provider) throw new SecretError(`${name} lives in ${PROVIDER_NAME[old.provider]}. Delete it first, or switch back to that provider.`, 'invalid');
  const note = input.note ?? null;
  let ref: string;
  if (provider === '1password') {
    ref = await opSave(s, name, input.value, input.projectId ? [input.projectId] : [], note);
    await opForget(s);
  } else if (provider === 'bitwarden') {
    ref = await bwSave(s, name, input.value, old?.ref ?? null, note);
  } else {
    ref = await bwsSave(s, name, input.value, old?.ref ?? null, note);
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO secrets (name, project_id, provider, ref, kind, note, created_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET ref = excluded.ref, kind = excluded.kind, note = COALESCE(excluded.note, secrets.note), project_id = COALESCE(excluded.project_id, secrets.project_id), rotated_at = excluded.rotated_at`,
  ).run(name, input.projectId ?? null, provider, ref, input.kind, note, old?.created_at ?? now, now);
  return getSecret(db, name)!;
}

/** Move KEY=value out of a .env-style file inside the workspace; the line becomes a pointer. The caller never sees the value. */
export async function moveFromFile(db: DB, file: string, key: string, name: string, projectId: string | null, note: string | null): Promise<SecretRow> {
  const ws = currentWorkspace();
  if (!ws) throw new SecretError('no workspace', 'not_configured');
  const path = resolve(ws.root, file);
  if (!isInside(ws.root, path) || !existsSync(path)) throw new SecretError(`No such file in the workspace: ${file}`, 'not_found');
  const lines = readFileSync(path, 'utf8').split('\n');
  const re = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[^A-Za-z0-9_]/g, '')}\\s*=\\s*(.*)$`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new SecretError(`${key} is not set in ${file}`, 'not_found');
  let value = re.exec(lines[i])![1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  const row = await storeSecret(db, { name, value, kind: 'provided', projectId, note });
  lines[i] = `# ${key}: moved to ${PROVIDER_NAME[row.provider]} as ${name} by Drydock (inject it with run_with_secrets)`;
  writeFileSync(path, lines.join('\n'));
  return row;
}

async function readValue(db: DB, row: SecretRow): Promise<string> {
  const { s } = activeProvider(db);
  if (row.provider === '1password') return opRead(s, row.ref);
  if (row.provider === 'bitwarden') return bwRead(row.ref);
  return bwsRead(s, row.ref);
}

/**
 * Read secrets for Drydock's own use (a server's admin login, an app the user
 * started). Agents never reach this directly: their path is withSecrets.
 */
export async function readSecrets(db: DB, names: string[]): Promise<Record<string, string>> {
  const rows = names.map((n) => getSecret(db, checkName(n)) ?? (() => { throw new SecretError(`No secret named ${n}. list_secrets shows what exists.`, 'not_found'); })());
  if (!rows.length) return {};
  const { s } = activeProvider(db);
  if (rows.some((r) => r.provider === 'bitwarden')) bwEnv(); // locked → say so before anything else
  const env: Record<string, string> = {};
  try {
    for (const r of rows) env[r.name] = await readValue(db, r);
  } finally {
    if (rows.some((r) => r.provider === '1password')) await opForget(s);
  }
  db.prepare(`UPDATE secrets SET used_at = ? WHERE name IN (${rows.map(() => '?').join(',')})`).run(Date.now(), ...rows.map((r) => r.name));
  return env;
}

/**
 * Read the named secrets for one use by an agent. The user has already
 * approved the card; with "confirm on this Mac" on, they also confirm here.
 */
export async function withSecrets<T>(db: DB, names: string[], reason: string, use: (env: Record<string, string>) => Promise<T>): Promise<T> {
  names.forEach((n) => { if (!getSecret(db, checkName(n))) throw new SecretError(`No secret named ${n}. list_secrets shows what exists.`, 'not_found'); });
  const { s } = activeProvider(db);
  if (names.some((n) => getSecret(db, n)!.provider === 'bitwarden')) bwEnv();
  if (s.confirmOnMac) await confirmOnMac(reason);
  return use(await readSecrets(db, names));
}

/** Blank out any of the values (and their common encodings) in text an agent will see. */
export function redact(text: string, values: string[]): string {
  let out = text;
  for (const v of values.filter((x) => x.length >= 4)) {
    for (const form of new Set([v, Buffer.from(v).toString('base64'), encodeURIComponent(v)])) out = out.split(form).join('[secret]');
  }
  return out;
}

/** Run a command in the workspace with secrets as env vars; returns redacted output. */
export async function runWithSecrets(db: DB, input: { command: string; secrets: string[]; cwd: string; reason: string; timeoutMs?: number }): Promise<{ code: number; output: string }> {
  const ws = currentWorkspace();
  if (!ws) throw new SecretError('no workspace', 'not_configured');
  const cwd = resolve(ws.root, input.cwd);
  if (!isInside(ws.root, cwd)) throw new SecretError('The command must run inside the Drydock workspace.', 'invalid');
  return withSecrets(db, input.secrets, input.reason, async (env) => {
    const r = await cli('/bin/bash', ['-lc', input.command], { cwd, env, timeoutMs: input.timeoutMs ?? 10 * 60_000 });
    const output = redact(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`, Object.values(env)).slice(-20_000);
    return { code: r.code, output };
  });
}

/** Delete from the manager (1Password archives; Bitwarden moves to trash) and from the registry. */
export async function deleteSecret(db: DB, name: string): Promise<void> {
  const row = getSecret(db, checkName(name));
  if (!row) throw new SecretError(`No secret named ${name}`, 'not_found');
  const { s } = activeProvider(db);
  if (row.provider === '1password') {
    await opDelete(s, row.name);
    await opForget(s);
  } else if (row.provider === 'bitwarden') await bwDelete(row.ref);
  else await bwsDelete(s, row.ref);
  db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
}

/** Replace a generated secret with a fresh value. Provided keys are rotated at their service, then re-saved. */
export async function rotateSecret(db: DB, name: string, bytes?: number): Promise<SecretRow> {
  const row = getSecret(db, checkName(name));
  if (!row) throw new SecretError(`No secret named ${name}`, 'not_found');
  if (row.kind !== 'generated') throw new SecretError(`${name} was issued by another service: create a new key there, then save it with the same name.`, 'invalid');
  return storeSecret(db, { name, value: generateValue(bytes), kind: 'generated', projectId: row.project_id, note: row.note });
}
