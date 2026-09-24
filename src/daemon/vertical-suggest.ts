import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/** A folder in a repo that looks like its own app/service (a vertical candidate). */
export interface VerticalSuggestion {
  name: string;
  /** relative to the scanned root, '/' separators */
  folder: string;
  stack: string | null;
}

/** Folders whose children are candidates (depth 2). */
const CONTAINERS = ['apps', 'packages', 'services', 'clients', 'projects'];
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

/** Suggest verticals for a repo: manifest-bearing folders in container dirs and known top-level
 *  names, at most 2 levels deep. Returns [] unless there are at least 2 candidates. */
export function suggestVerticals(rootPath: string): VerticalSuggestion[] {
  const found: { folder: string; parent: string | null; base: string; stack: string | null }[] = [];
  for (const top of subdirs(rootPath)) {
    if (CONTAINERS.includes(top)) {
      for (const child of subdirs(join(rootPath, top))) {
        const stack = detectStack(join(rootPath, top, child));
        if (stack !== undefined) found.push({ folder: `${top}/${child}`, parent: top, base: child, stack });
      }
    } else if (KNOWN_TOP.has(top)) {
      const stack = detectStack(join(rootPath, top));
      if (stack !== undefined) found.push({ folder: top, parent: null, base: top, stack });
    }
  }

  // Heuristic: in a monorepo that has deployables under apps/ or services/, packages/* are
  // usually shared libraries rather than their own product sides — drop them.
  const hasApps = found.some((c) => c.parent === 'apps' || c.parent === 'services');
  const candidates = hasApps ? found.filter((c) => c.parent !== 'packages') : found;
  if (candidates.length < 2) return [];

  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.base, (counts.get(c.base) ?? 0) + 1);
  return candidates
    .map((c) => ({
      // collisions get the parent folder as a prefix (apps-web vs packages-web); a top-level
      // folder has no parent and keeps its plain name
      name: counts.get(c.base)! > 1 && c.parent ? `${c.parent}-${c.base}` : c.base,
      folder: c.folder,
      stack: c.stack,
    }))
    .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}
