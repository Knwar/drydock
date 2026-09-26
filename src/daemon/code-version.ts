import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

// The daemon's code version: a fingerprint of its own code (src/daemon and
// src/core, test files excluded): a hash of the sorted path:mtime:size list.
// Recorded at startup and re-read on disk by GET /version, so the overlay can
// tell when the running daemon is older than its code on disk. Commits that
// don't touch that code (overlay, docs) don't change it.

const execFileAsync = promisify(execFile);

export interface CodeVersion {
  fingerprint: string; // what the overlay compares
  files: number;
  /** Informational only (never compared): HEAD short sha, when the daemon's root is
   *  itself a git checkout's toplevel (not e.g. a project it's installed inside). */
  sha: string | null;
}

const DIRS = ['src/daemon', 'src/core'];

async function listFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) await listFiles(path, root, out);
    else if (e.isFile() && !e.name.includes('.test.')) {
      try {
        const s = await stat(path);
        out.push(`${relative(root, path)}:${Math.floor(s.mtimeMs)}:${s.size}`);
      } catch {
        /* removed meanwhile */
      }
    }
  }
}

async function ownSha(root: string): Promise<string | null> {
  try {
    const git = (...args: string[]) => execFileAsync('git', ['-C', root, ...args], { timeout: 5000 });
    const top = (await git('rev-parse', '--show-toplevel')).stdout.trim();
    if (!top || (await realpath(top)) !== (await realpath(root))) return null;
    return (await git('rev-parse', '--short', 'HEAD')).stdout.trim() || null;
  } catch {
    return null; // not a git checkout
  }
}

/** The code version of the daemon checkout at `root`, as it is on disk now. */
export async function readCodeVersion(root: string): Promise<CodeVersion> {
  const entries: string[] = [];
  for (const d of DIRS) await listFiles(join(root, d), root, entries);
  entries.sort();
  const fingerprint = createHash('sha1').update(entries.join('\n')).digest('hex').slice(0, 16);
  return { fingerprint, files: entries.length, sha: await ownSha(root) };
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
