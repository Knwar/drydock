import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

// The daemon's code version: its checkout's HEAD short sha plus the newest
// mtime under src/daemon and src/core (test files excluded). Recorded at
// startup and re-read on disk by GET /version, so the overlay can tell when the
// running daemon is older than the code it serves.

const execFileAsync = promisify(execFile);

export interface CodeVersion {
  sha: string | null; // null outside a git checkout (e.g. an npm install)
  mtime: number; // ms since epoch; 0 when the folders are missing
}

const DIRS = ['src/daemon', 'src/core'];

async function newestMtime(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, await newestMtime(path));
    else if (e.isFile() && !e.name.includes('.test.')) {
      try {
        newest = Math.max(newest, Math.floor((await stat(path)).mtimeMs));
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return newest;
}

/** The code version of the checkout at `root`, as it is on disk now. */
export async function readCodeVersion(root: string): Promise<CodeVersion> {
  let sha: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
    sha = stdout.trim() || null;
  } catch {
    /* not a git checkout */
  }
  const mtimes = await Promise.all(DIRS.map((d) => newestMtime(join(root, d))));
  return { sha, mtime: Math.max(0, ...mtimes) };
}

/** readCodeVersion, cached for `ttlMs` so a polled route stays cheap. */
export function cachedCodeVersion(root: string, ttlMs = 5000): () => Promise<CodeVersion> {
  let at = 0;
  let pending: Promise<CodeVersion> | null = null;
  return () => {
    if (!pending || Date.now() - at > ttlMs) {
      at = Date.now();
      pending = readCodeVersion(root);
    }
    return pending;
  };
}
