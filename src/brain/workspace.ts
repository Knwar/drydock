// The workspace: the one folder the user picks at onboarding (D9). Everything
// Drydock creates lives inside it, and agents are kept inside it by the
// boundary hook. The only file outside it is the pointer in BRAIN_HOME
// (~/.ai-brain/config.json), which records where the workspace is.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BrainConfig {
  workspace?: string;
}

export interface WorkspacePaths {
  root: string;
  vault: string;
  projects: string;
  data: string;
  db: string;
}

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOUNDARY_HOOK = join(APP_ROOT, '.claude', 'hooks', 'boundary.js');

/** Folders created inside a new workspace. */
const LAYOUT = [
  'vault/projects',
  'vault/roles',
  'vault/personal/notes',
  'vault/personal/daily',
  'vault/inbox',
  'projects',
  '.ai-brain',
];

export const brainHome = (env: NodeJS.ProcessEnv = process.env): string => env.BRAIN_HOME ?? join(homedir(), '.ai-brain');

const configFile = (env: NodeJS.ProcessEnv) => join(brainHome(env), 'config.json');

export function readConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  try {
    const parsed = JSON.parse(readFileSync(configFile(env), 'utf8'));
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    vault: join(root, 'vault'),
    projects: join(root, 'projects'),
    data: join(root, '.ai-brain'),
    db: join(root, '.ai-brain', 'board.db'),
  };
}

/** The configured workspace, if its folder still exists. */
export function currentWorkspace(env: NodeJS.ProcessEnv = process.env): WorkspacePaths | null {
  const root = readConfig(env).workspace;
  return root && existsSync(root) ? workspacePaths(root) : null;
}

/**
 * Where the board database lives: an explicit DB_PATH wins (tests, power users),
 * then the workspace, then a bootstrap DB used only until onboarding finishes.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DB_PATH) return env.DB_PATH;
  const ws = currentWorkspace(env);
  return ws ? ws.db : join(brainHome(env), 'bootstrap.db');
}

/** True when `target` is `root` or inside it, after resolving symlinks on both. */
export function isInside(root: string, target: string): boolean {
  const r = realish(root);
  const t = realish(target);
  const rel = relative(r, t);
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/** realpath of the longest existing prefix, with the missing tail re-appended. */
function realish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(head.slice(parent.length + 1));
    head = parent;
  }
  try {
    head = realpathSync(head);
  } catch {
    /* keep the resolved path */
  }
  return join(head, ...tail);
}

/** Settings for agent sessions started at the workspace root (the main agent and shared roles). */
function rootSettings(): object {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|LS|Bash',
          hooks: [{ type: 'command', command: `node "${BOUNDARY_HOOK}"` }],
        },
      ],
    },
  };
}

/**
 * Create (or adopt) a workspace folder, lay out its structure and point the
 * config at it. Idempotent: existing files are never overwritten.
 */
export function setupWorkspace(folder: string, env: NodeJS.ProcessEnv = process.env): WorkspacePaths {
  if (!folder || !isAbsolute(folder)) throw new Error('workspace path must be absolute');
  const home = resolve(homedir());
  const target = resolve(folder);
  if (target === '/' || target === home) throw new Error('pick a dedicated folder, not / or your home folder');
  mkdirSync(target, { recursive: true });
  const root = realpathSync(target);
  for (const dir of LAYOUT) mkdirSync(join(root, dir), { recursive: true });

  const settings = join(root, '.claude', 'settings.json');
  if (!existsSync(settings)) {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify(rootSettings(), null, 2) + '\n');
  }
  const readme = join(root, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      '# Drydock workspace\n\nEverything Drydock creates lives in this folder, and its agents cannot read or write outside it.\n\n' +
        '- `vault/`: documents, notes, decisions and the Daily\n- `projects/`: one folder per project\n- `.ai-brain/`: database, logs and settings\n',
    );
  }

  mkdirSync(brainHome(env), { recursive: true });
  writeFileSync(configFile(env), JSON.stringify({ ...readConfig(env), workspace: root }, null, 2) + '\n');
  return workspacePaths(root);
}
