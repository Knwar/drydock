// Importing projects that already exist: a folder already in projects/, a
// folder copied in from elsewhere on this Mac, or a git clone. Imported code is
// untrusted until the user says otherwise: its own Claude Code settings (hooks
// run commands when an agent starts there) and .mcp.json servers are moved to
// .ai-brain/quarantine/ unless the user trusts them, and nothing is installed
// or run until the user starts it. Git history and remotes are kept; nothing
// is pushed. Then the Main agent describes what exists (requirements v1 "as
// is"), finds how to run and check it, and for software asks the Architect to
// draw the design from the code.
import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DB } from '../core/db.js';
import * as board from '../core/board.js';
import { getBus } from './bus.js';
import { addMessage, createChannel, getConversation } from './chat.js';
import { projectRef, saveRequirements, slugify, type ProjectRef } from './pipeline.js';
import { isType, TYPES, type ProjectType } from './plugins.js';
import { setStage } from './projects.js';
import { respond } from './runner.js';
import { currentWorkspace, isInside } from './workspace.js';

const run = promisify(execFile);
const INIT = join(import.meta.dirname, '..', '..', 'scripts', 'init-project.sh');
/** Not copied in: dependencies and build output, rebuilt on first start. */
export const SKIP = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', 'dist', 'build', 'target', '.gradle', 'Pods', 'DerivedData', '.dart_tool', '.trees', '.DS_Store']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.dart', '.rb', '.php', '.cs', '.c', '.cpp', '.h', '.vue', '.svelte']);
const MANIFESTS = ['package.json', 'pubspec.yaml', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'Package.swift', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle'];

export interface Inspection {
  dir: string;
  name: string;
  /** a guess; the user confirms */
  type: ProjectType;
  files: number;
  bytes: number;
  truncated: boolean;
  git: { repo: boolean; branch: string | null; remote: string | null; dirty: number; commits: number } | null;
  risks: {
    /** Claude Code settings files with hooks or other settings that run or allow things */
    claudeSettings: { file: string; hooks: string[]; permissions: boolean }[];
    mcpServers: string[];
    installScripts: string[];
    envFiles: string[];
  };
  registered: boolean;
}

function walk(dir: string, cap = 20_000) {
  let files = 0;
  let bytes = 0;
  let code = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        try {
          bytes += statSync(p).size;
        } catch {
          /* vanished */
        }
        if (CODE_EXT.has(extname(e.name))) code++;
        if (files >= cap) {
          truncated = true;
          return { files, bytes, code, truncated };
        }
      }
    }
  }
  return { files, bytes, code, truncated };
}

const readJson = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** What a folder holds and what in it could run on its own, before anything is imported. */
export async function inspect(db: DB, dir: string): Promise<Inspection> {
  const w = walk(dir);
  const type: ProjectType = MANIFESTS.some((m) => existsSync(join(dir, m))) || w.code >= 5 || readdirSync(dir).some((f) => f.endsWith('.xcodeproj')) ? 'software' : 'general';
  let git: Inspection['git'] = null;
  if (existsSync(join(dir, '.git'))) {
    const g = async (...a: string[]) => (await run('git', ['-C', dir, ...a]).catch(() => ({ stdout: '' }))).stdout.trim();
    git = {
      repo: true,
      branch: (await g('rev-parse', '--abbrev-ref', 'HEAD')) || null,
      remote: (await g('remote', 'get-url', 'origin')) || null,
      dirty: (await g('status', '--porcelain')).split('\n').filter(Boolean).length,
      commits: Number(await g('rev-list', '--count', 'HEAD')) || 0,
    };
  }
  const claudeSettings = ['settings.json', 'settings.local.json']
    .map((f) => ({ f, j: readJson(join(dir, '.claude', f)) }))
    .filter((x) => x.j && (x.j.hooks || x.j.permissions || x.j.env || x.j.apiKeyHelper))
    .map((x) => ({ file: `.claude/${x.f}`, hooks: Object.keys(x.j.hooks ?? {}), permissions: Boolean(x.j.permissions?.allow?.length) }));
  const mcp = readJson(join(dir, '.mcp.json'));
  const pkg = readJson(join(dir, 'package.json'));
  return {
    dir,
    name: basename(dir),
    type,
    files: w.files,
    bytes: w.bytes,
    truncated: w.truncated,
    git,
    risks: {
      claudeSettings,
      mcpServers: Object.keys(mcp?.mcpServers ?? {}).filter((n) => n !== 'kanban' && n !== 'kankan'),
      installScripts: Object.entries(pkg?.scripts ?? {}).filter(([k]) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(k)).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`),
      envFiles: readdirSync(dir).filter((f) => /^\.env(\..+)?$/.test(f) && !f.endsWith('.example') && !f.endsWith('.sample')),
    },
    registered: Boolean(db.prepare('SELECT 1 FROM brain_projects b JOIN projects p ON p.id = b.project_id WHERE p.root_path = ?').get(dir)),
  };
}

function projectsDir(): string {
  const ws = currentWorkspace();
  if (!ws) throw new Error('set up a workspace first');
  mkdirSync(ws.projects, { recursive: true });
  return ws.projects;
}

/** A direct child of projects/, resolved. */
function workspaceFolder(dir: string): string {
  const root = projectsDir();
  const full = resolve(root, dir);
  if (dirname(full) !== root || !existsSync(full) || !statSync(full).isDirectory()) throw new Error('choose a folder directly inside projects/');
  return full;
}

/** Folders in projects/ that Drydock does not manage yet (including ones only the board kit knows). */
export function candidates(db: DB): { dir: string; name: string; boardOnly: boolean }[] {
  const root = projectsDir();
  const known = db.prepare('SELECT p.root_path, b.project_id AS brain FROM projects p LEFT JOIN brain_projects b ON b.project_id = p.id').all() as { root_path: string; brain: string | null }[];
  const byRoot = new Map(known.map((k) => [k.root_path, k.brain]));
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(root, e.name))
    .filter((d) => byRoot.get(d) == null)
    .map((d) => ({ dir: d, name: basename(d), boardOnly: byRoot.has(d) }));
}

/** Where a copy or clone goes: projects/<slug>, which must not exist yet. */
function target(name: string): string {
  const slug = slugify(name);
  if (!slug) throw new Error('give the project a name');
  const t = join(projectsDir(), slug);
  if (existsSync(t)) throw new Error(`projects/${slug} already exists; choose another name`);
  return t;
}

/** A folder elsewhere on this Mac: allowed sources and what copying it would take. */
export function checkSource(path: string): string {
  if (!path.startsWith('/')) throw new Error('enter the full path, starting with /');
  const full = realpathSync(path);
  if (!statSync(full).isDirectory()) throw new Error('that is not a folder');
  const ws = currentWorkspace()!;
  if (isInside(ws.root, full)) throw new Error('that folder is already inside the workspace');
  if (full === '/' || full === homedir() || ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/private/var/db', '/private/var/root', '/Volumes/Recovery'].some((p) => full === p || full.startsWith(p + '/'))) throw new Error('choose a project folder, not a system or home folder');
  return full;
}

/** Copy a folder in (dependencies and build output left out; links that point outside it dropped). */
export function copyIn(path: string, name: string): string {
  const src = checkSource(path);
  const dst = target(name || basename(src));
  cpSync(src, dst, {
    recursive: true,
    filter: (from) => {
      if (SKIP.has(basename(from))) return false;
      try {
        if (lstatSync(from).isSymbolicLink()) return isInside(src, realpathSync(from));
      } catch {
        return false; // dangling link
      }
      return true;
    },
  });
  return dst;
}

/** Clone a git repository (https or ssh) with the user's own git credentials; never prompts. */
export async function cloneIn(url: string, name: string): Promise<string> {
  if (!/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~+-]+$/.test(url)) throw new Error('use an https:// or git@ address');
  const dst = target(name || basename(url).replace(/\.git$/, ''));
  try {
    await run('git', ['clone', '--', url, dst], { timeout: 15 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const msg = String((e as any).stderr ?? (e as Error).message).trim().split('\n').pop() ?? 'clone failed';
    throw new Error(/Authentication|could not read Username|Permission denied/i.test(msg) ? `Git could not sign in to that repository. For private GitHub repos, run "gh auth login" in a terminal first. (${msg})` : msg);
  }
  return dst;
}

/** Commit everything uncommitted as a snapshot, so card branches start from a clean state. */
export async function snapshot(dir: string): Promise<void> {
  const full = workspaceFolder(dir);
  // never sweep secrets into the snapshot
  ignoreEnv(full, readdirSync(full).filter((f) => /^\.env(\..+)?$/.test(f) && !/\.(example|sample)$/.test(f)));
  await run('git', ['-C', full, 'add', '-A']);
  await run('git', ['-C', full, '-c', 'user.name=Drydock', '-c', 'user.email=ai-brain@localhost', 'commit', '-qm', 'Snapshot before Drydock import']).catch(() => undefined);
}

/** Move the project's own Claude settings and MCP servers aside (restorable), so none of them run. */
function quarantine(dir: string): string[] {
  const moved: string[] = [];
  const q = join(dir, '.ai-brain', 'quarantine');
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']) {
    const f = join(dir, rel);
    if (!existsSync(f)) continue;
    mkdirSync(q, { recursive: true });
    renameSync(f, join(q, rel.replace(/\//g, '__')));
    moved.push(rel);
  }
  if (moved.length && existsSync(join(dir, '.git'))) appendFileSync(join(dir, '.git', 'info', 'exclude'), '\n.ai-brain/quarantine/\n');
  return moved;
}

/** Keep secrets out of git: .env files go into .gitignore before the kit commits anything. */
function ignoreEnv(dir: string, envFiles: string[]): void {
  if (!envFiles.length) return;
  const gi = join(dir, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const missing = ['.env', '.env.*', '!.env.example'].filter((l) => !cur.split('\n').includes(l));
  if (missing.length) appendFileSync(gi, `${cur && !cur.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/**
 * Import a folder in projects/: safety first, then the kit (merged into what
 * is there), registration, and the as-is onboarding by the agents.
 */
export async function importProject(db: DB, dir: string, opts: { type: ProjectType; name?: string; trust: boolean }): Promise<{ ref: ProjectRef; quarantined: string[]; channel: string }> {
  const full = workspaceFolder(dir);
  const info = await inspect(db, full);
  if (info.registered) throw new Error('this folder is already an Drydock project');
  if (info.git?.dirty) throw new Error(`it has ${info.git.dirty} uncommitted change(s); commit them, or let Drydock commit a snapshot first`);
  const type = isType(opts.type) ? opts.type : info.type;
  const name = (opts.name ?? '').trim() || info.name;
  const quarantined = opts.trust ? [] : quarantine(full);
  ignoreEnv(full, info.risks.envFiles);
  await run('sh', [INIT, full, name], { env: { ...process.env, DAEMON_URL: getBus().daemonUrl }, timeout: 120_000 });
  const project = board.getOrCreateProject(db, full, name);
  setStage(db, project.id, 'requirements', null);
  db.prepare('UPDATE brain_projects SET type = ?, origin = ? WHERE project_id = ?').run(type, 'imported', project.id);
  const ref = projectRef(db, project.id);
  for (const d of ['requirements', 'design', 'roles', 'notes']) mkdirSync(join(ref.vault, d), { recursive: true });
  saveRequirements(db, project.id, `# ${name} — What exists today\n\n_The Main agent is reading the project and will describe it here._\n`, 'main');

  // onboarding: the Main agent (and for software, the Architect) describe what is there
  const channel = `ch:${slugify(`${ref.slug}-onboarding`)}`;
  const members = ['main', ...(type === 'software' && db.prepare("SELECT 1 FROM roles WHERE id = 'architect'").get() ? ['architect'] : [])];
  if (!getConversation(db, channel)) createChannel(db, 'onboarding', members, ref.id, ref.slug);
  const facts = [
    info.git ? `git: ${info.git.commits} commits on ${info.git.branch ?? 'HEAD'}${info.git.remote ? `, remote ${info.git.remote} (never push)` : ''}` : 'it had no git history; Drydock started one',
    `${info.files}${info.truncated ? '+' : ''} files`,
    quarantined.length ? `its own ${quarantined.join(', ')} were moved to .ai-brain/quarantine/ (untrusted) and replaced by Drydock's` : '',
    info.risks.envFiles.length ? `.env files found: ${info.risks.envFiles.join(', ')}` : '',
  ].filter(Boolean);
  const steps =
    type === 'software'
      ? [
          'Read it (README, manifests, the folder structure, `git log --oneline -20`, TODO/FIXME comments). Search as you go; do not read everything.',
          'Write requirements v1 as what exists today with save_requirements: What it is, Users, Features that exist (and how complete they look), Known gaps and TODOs, Non-functional (stack, hosting hints), Open questions for me.',
          'Find how to run and check it: save_run_recipe with install, services, needs (databases) and verify (its tests, lint, typecheck). Do not run anything yet.',
          info.risks.envFiles.length ? 'Ask me before moving the values in its .env files into my password manager (save_secret from_file), one file at a time.' : '',
          members.includes('architect') ? 'Then ask @Architect to draw the system design from the code with the design tools (containers first, components only where it helps).' : 'There is no Architect on my team yet; say so, so I can add one for the design.',
          'Finish with a short list of suggested backlog items (bugs, gaps, TODOs). Do not create cards: the PM plans once I approve the requirements.',
        ]
      : [
          'Read it (its documents, structure and history). Search as you go; do not read everything.',
          'Write requirements v1 as what exists today with save_requirements: What it is, Audience, What is done (and how complete it looks), Gaps and open threads, Style and constraints, Open questions for me.',
          info.risks.envFiles.length ? 'Ask me before moving the values in its .env files into my password manager (save_secret from_file).' : '',
          'Finish with a short list of suggested next pieces of work. Do not create cards: the PM plans once I approve the brief.',
        ];
  const text = `@Main agent I imported **${name}** (project_id ${ref.id}, ${TYPES[type].name.toLowerCase()} project, folder projects/${basename(full)}). ${facts.join('; ')}.\n\nPlease onboard it:\n${steps.filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  const m = addMessage(db, channel, 'user', text);
  getBus().emit({ type: 'chat', conversation: channel, message: m });
  respond(channel, '@Main agent');
  getBus().emit({ type: 'brain_project', project_id: project.id });
  getBus().emit({ type: 'conversations' });
  return { ref, quarantined, channel };
}
