// PreToolUse (Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|LS|Bash):
// keep every agent inside the Drydock workspace (D9). A tool call that names
// a path outside it is blocked (exit 2); Claude sees the reason and adjusts.
//
// Workspace root: $BRAIN_WORKSPACE, else the pointer in $BRAIN_HOME/config.json
// (~/.ai-brain by default). No workspace configured → nothing to enforce.
//
// Bash is checked heuristically (paths that are absolute, start with ~ or
// $HOME, or climb with ..). It is a guard rail for honest agents, not a
// sandbox against hostile code.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE_KEYS = { Read: ['file_path'], Edit: ['file_path'], Write: ['file_path'], MultiEdit: ['file_path'], NotebookEdit: ['notebook_path'], Glob: ['path', 'pattern'], Grep: ['path', 'glob'], LS: ['path'] };

// Absolute paths a shell command may name without leaving the workspace:
// the null/std devices and the usual binary folders (running a tool, not reading data).
const ALLOWED_ABS = [/^\/dev\/(null|stdout|stderr|stdin|tty)$/, /^\/(usr\/)?(local\/)?s?bin(\/|$)/, /^\/opt\/homebrew\/s?bin(\/|$)/, /^\/usr\/bin\/env$/];

function realish(p) {
  let head = resolve(p);
  const tail = [];
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

export function isInside(root, target) {
  const rel = relative(realish(root), realish(target));
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

const expandHome = (p, home) => (p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p.replace(/^\$\{?HOME\}?(?=\/|$)/, home));

/** Path-like words in a shell command, with the cwd each one is relative to (cd is followed). */
function shellPaths(command, cwd, home) {
  const words = command
    .split(/[\s;&|()<>`]+/)
    .map((w) => w.replace(/^['"]|['"]$/g, '').replace(/^-[-\w]*=/, '').replace(/^\d?>>?/, ''))
    .filter(Boolean);
  const out = [];
  let dir = cwd;
  for (let i = 0; i < words.length; i++) {
    const w = expandHome(words[i], home);
    const pathy = w.startsWith('/') || w === '..' || w.startsWith('../') || w.includes('/../') || w.endsWith('/..');
    if (words[i - 1] === 'cd' && !w.startsWith('-')) {
      if (pathy || !w.includes('$')) {
        const next = resolve(dir, w);
        out.push({ path: next, word: words[i] });
        dir = next;
      }
      continue;
    }
    if (pathy && !w.includes('://')) out.push({ path: resolve(dir, w), word: words[i] });
  }
  return out;
}

/**
 * Decide one tool call. Returns null when it is allowed, or the reason it is
 * blocked.
 */
export function checkToolCall({ root, cwd, tool, input, home = homedir() }) {
  if (!root) return null;
  const base = cwd && isAbsolute(cwd) ? cwd : root;
  const outside = (p) => `"${p}" is outside the Drydock workspace (${root}). Agents may only read and write inside it. Use a path inside the workspace, or ask the user to copy what you need into it.`;

  // Only sessions running inside the workspace are Drydock's agents; anything
  // else (e.g. developing Drydock itself) is not ours to restrict.
  if (!isInside(root, base)) return null;

  if (tool === 'Bash') {
    const command = typeof input?.command === 'string' ? input.command : '';
    for (const { path, word } of shellPaths(command, base, home)) {
      if (ALLOWED_ABS.some((re) => re.test(path))) continue;
      if (!isInside(root, path)) return outside(word);
    }
    return null;
  }

  for (const key of FILE_KEYS[tool] ?? []) {
    const raw = input?.[key];
    if (typeof raw !== 'string' || raw === '') continue;
    const value = expandHome(raw, home);
    // a glob pattern is a path only when it is absolute or climbs out
    if ((key === 'pattern' || key === 'glob') && !value.startsWith('/') && !value.split('/').includes('..')) continue;
    const target = resolve(base, value.replace(/[*?[{].*$/, '') || '.');
    if (!isInside(root, target)) return outside(raw);
  }
  return null;
}

export function workspaceRoot(env = process.env) {
  if (env.BRAIN_WORKSPACE) return env.BRAIN_WORKSPACE;
  try {
    const cfg = JSON.parse(readFileSync(join(env.BRAIN_HOME ?? join(homedir(), '.ai-brain'), 'config.json'), 'utf8'));
    return typeof cfg.workspace === 'string' && existsSync(cfg.workspace) ? cfg.workspace : null;
  } catch {
    return null;
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return; // nothing to judge
  }
  const reason = checkToolCall({ root: workspaceRoot(), cwd: data.cwd, tool: data.tool_name, input: data.tool_input });
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
