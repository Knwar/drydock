import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/** A folder in a repo that looks like its own app/service (a vertical candidate). */
export interface VerticalSuggestion {
  name: string;
  /** relative to the scanned root, '/' separators */
  folder: string;
  stack: string | null;
}

/** Folders whose children are candidates (depth 2). packages/ is deliberately absent: its
 *  children are almost always shared libraries/plugins, not their own product sides. */
const CONTAINERS = ['apps', 'services', 'clients', 'projects'];
/** A container with more than this many candidates is suggested as ONE vertical (itself). */
const MAX_CHILDREN = 3;
/** Platform folders of a single app (Flutter / React Native / Capacitor / Ionic). */
const PLATFORM_DIRS = new Set(['android', 'ios', 'macos', 'windows', 'linux', 'web']);
const APP_DEPS = ['react-native', 'expo', '@capacitor/core'];
/** Top-level folders that are candidates themselves (depth 1). */
const KNOWN_TOP = new Set([
  'mobile', 'web', 'api', 'backend', 'frontend', 'server', 'client', 'ios', 'android',
  'app', 'site', 'docs', 'admin', 'dashboard', 'infra', 'worker', 'cli',
]);
const IGNORED = new Set(['node_modules', '.git', '.trees', 'dist', 'build', 'out', 'vendor', '.next', 'coverage', 'target', 'Pods']);
/** Manifest file → stack label, checked in this order (first match wins). */
const MANIFESTS: [string, string][] = [
  ['package.json', 'node'],
  ['pubspec.yaml', 'flutter'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['Gemfile', 'ruby'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'java'],
  ['composer.json', 'php'],
];

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Real (non-symlink) subdirectories worth scanning. Dirent.isDirectory() is false for symlinks. */
function subdirs(dir: string): string[] {
  return list(dir)
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED.has(e.name))
    .map((e) => e.name);
}

/** The stack label when `dir` directly contains a manifest, else undefined (not a candidate). */
function detectStack(dir: string): string | null | undefined {
  const entries = list(dir);
  const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  for (const [file, stack] of MANIFESTS) if (files.has(file)) return stack;
  if (entries.some((e) => e.isFile() && e.name.endsWith('.csproj'))) return 'dotnet';
  if (entries.some((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'))) return 'ios';
  return undefined;
}

/** True when the root itself is a (cross-platform) app, whose top-level platform folders
 *  are parts of that one app rather than verticals. */
function rootIsApp(rootPath: string): boolean {
  const files = new Set(list(rootPath).filter((e) => e.isFile()).map((e) => e.name));
  if (files.has('pubspec.yaml')) return true;
  if (!files.has('package.json')) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies });
    return deps.some((d) => APP_DEPS.includes(d) || d.startsWith('@ionic/'));
  } catch {
    return false;
  }
}

/** The most common stack among children (first seen wins a tie). */
function commonStack(stacks: (string | null)[]): string | null {
  const counts = new Map<string | null, number>();
  for (const st of stacks) counts.set(st, (counts.get(st) ?? 0) + 1);
  let best: string | null = null;
  let max = 0;
  for (const [st, n] of counts) if (n > max) [best, max] = [st, n];
  return best;
}

/** Suggest verticals for a repo: manifest-bearing folders in container dirs and known top-level
 *  names, at most 2 levels deep. Returns [] unless there are at least 2 candidates. */
export function suggestVerticals(rootPath: string): VerticalSuggestion[] {
  const candidates: { folder: string; parent: string | null; base: string; stack: string | null }[] = [];
  const skipPlatforms = rootIsApp(rootPath);
  for (const top of subdirs(rootPath)) {
    if (CONTAINERS.includes(top)) {
      const children: { folder: string; parent: string; base: string; stack: string | null }[] = [];
      for (const child of subdirs(join(rootPath, top))) {
        const stack = detectStack(join(rootPath, top, child));
        if (stack !== undefined) children.push({ folder: `${top}/${child}`, parent: top, base: child, stack });
      }
      // too granular (e.g. 6 microservices) → the container itself is one vertical
      if (children.length > MAX_CHILDREN)
        candidates.push({ folder: top, parent: null, base: top, stack: commonStack(children.map((c) => c.stack)) });
      else candidates.push(...children);
    } else if (KNOWN_TOP.has(top) && !(skipPlatforms && PLATFORM_DIRS.has(top))) {
      const stack = detectStack(join(rootPath, top));
      if (stack !== undefined) candidates.push({ folder: top, parent: null, base: top, stack });
    }
  }
  if (candidates.length < 2) return [];

  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.base, (counts.get(c.base) ?? 0) + 1);
  return candidates
    .map((c) => ({
      // collisions get the parent folder as a prefix (apps-web vs clients-web); a top-level
      // folder has no parent and keeps its plain name
      name: counts.get(c.base)! > 1 && c.parent ? `${c.parent}-${c.base}` : c.base,
      folder: c.folder,
      stack: c.stack,
    }))
    .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}
