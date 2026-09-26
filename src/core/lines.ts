// Lines written per card, counted from git: the card's own change, not the
// worktree's view of everything since `main`.
//
// Source of truth, in order:
//   1. the card's merge commit ("Merge card/<id>"): diff against its first parent
//      is exactly what the card brought in (final numbers);
//   2. the unmerged card branch: `<base>...card/<id>`, where <base> is the branch
//      the worktree was created from (recorded by `kankan worktree add` in the
//      git config key branch.card/<id>.kankanbase; falls back to the repo's
//      current branch for worktrees created before it was recorded).
// Lockfiles, dist/, build/, node_modules/ and binary files are not counted.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { flagLinesEstimated, setCardLines } from './board.js';
import type { DB } from './db.js';

const execFileAsync = promisify(execFile);

export interface Lines {
  added: number;
  removed: number;
}

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml']);
const GENERATED_DIRS = new Set(['dist', 'build', 'node_modules']);

/** Whether a changed path counts as written code (not a lockfile / build output / dependency).
 *  Lockfiles: the npm/pnpm ones plus any `*.lock` (yarn.lock, pubspec.lock, Cargo.lock, ...). */
export function isCountedPath(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  if (LOCKFILES.has(name) || name.endsWith('.lock')) return false;
  return !parts.slice(0, -1).some((p) => GENERATED_DIRS.has(p));
}

/**
 * Sum `git diff --numstat -z` output, skipping binaries ("-") and uncounted
 * paths. Renames stay detected (a moved file counts only its edits, not a full
 * delete + add); a rename record is "a\td\t\0<src>\0<dst>\0", judged by <dst>.
 */
export function sumNumstat(out: string): Lines {
  let added = 0;
  let removed = 0;
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]) continue;
    let [a, d, path] = tokens[i].split('\t');
    if (path === '') {
      path = tokens[i + 2];
      i += 2;
    }
    if (a === '-' || d === '-' || !path || !isCountedPath(path)) continue;
    added += Number(a) || 0;
    removed += Number(d) || 0;
  }
  return { added, removed };
}

/** Each git call is killed after this long, so a stuck repo can't hang a recount. */
export const GIT_TIMEOUT_MS = 20_000;

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
}

async function numstat(repo: string, ...revs: string[]): Promise<Lines> {
  return sumNumstat(await git(repo, 'diff', '--numstat', '-z', '-M', ...revs));
}

const MERGE_SUBJECT = /^Merge (?:branch ')?card\/([\w-]+)'?/;

/** card id → sha of its (most recent) merge commit, across all refs of the repo. */
export async function mergeCommits(repo: string): Promise<Map<string, string>> {
  const out = await git(repo, 'log', '--all', '--merges', '--format=%H %s');
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    const m = MERGE_SUBJECT.exec(line.slice(sp + 1));
    if (m && !map.has(m[1])) map.set(m[1], line.slice(0, sp)); // newest first
  }
  return map;
}

/** Sha of one card's (most recent) merge commit across all refs, or null. Searches
 *  for that card only; the subject must name exactly this id (not a longer one). */
export async function mergeCommit(repo: string, taskId: string): Promise<string | null> {
  const out = await git(repo, 'log', '--all', '--merges', '--fixed-strings', '--grep', `card/${taskId}`, '--format=%H %s');
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    if (MERGE_SUBJECT.exec(line.slice(sp + 1))?.[1] === taskId) return line.slice(0, sp); // newest first
  }
  return null;
}

/** The branch a card worktree was created from, as recorded by `kankan worktree add`. */
async function recordedBase(repo: string, branch: string): Promise<string | null> {
  try {
    return (await git(repo, 'config', '--get', `branch.${branch}.kankanbase`)).trim() || null;
  } catch {
    return null;
  }
}

export type LinesSource = 'merge' | 'branch';

/**
 * A card's lines from git: its merge commit if merged, else its branch vs its
 * base. Null when neither exists (or `repo` isn't a git repo). Pass `merges`
 * (from mergeCommits) when counting many cards; otherwise only this card's merge is searched.
 */
export async function cardLines(
  repo: string,
  taskId: string,
  merges?: Map<string, string>,
): Promise<(Lines & { source: LinesSource }) | null> {
  try {
    const sha = merges ? merges.get(taskId) : await mergeCommit(repo, taskId);
    if (sha) return { ...(await numstat(repo, `${sha}^1`, sha)), source: 'merge' };
    const branch = `card/${taskId}`;
    try {
      await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    } catch {
      return null; // no merge, no branch: nothing left to count from
    }
    let base = await recordedBase(repo, branch);
    if (!base) {
      base = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
      if (base === branch || base === 'HEAD') return null;
    }
    return { ...(await numstat(repo, `${base}...${branch}`)), source: 'branch' };
  } catch {
    return null;
  }
}

// ── history recount (`kankan recount-lines`) ────────────────────────

export interface RecountRow {
  task_id: string;
  project: string;
  before: Lines; // raw sum over the card's activity rows
  after: Lines | null; // null → unrecoverable, flagged estimated
  source: LinesSource | 'estimated';
}

/** Read-only: what a recount would set for every card that has activity rows. */
export async function planRecount(db: DB): Promise<RecountRow[]> {
  const cards = db
    .prepare(
      `SELECT c.task_id, p.name AS project, p.root_path AS root,
              SUM(c.lines_added) AS added, SUM(c.lines_removed) AS removed
         FROM card_activity c JOIN projects p ON p.id = c.project_id
        GROUP BY c.task_id ORDER BY p.name, c.task_id`,
    )
    .all() as { task_id: string; project: string; root: string; added: number; removed: number }[];
  const mergesByRoot = new Map<string, Map<string, string>>();
  const rows: RecountRow[] = [];
  for (const c of cards) {
    if (!mergesByRoot.has(c.root)) {
      let merges = new Map<string, string>();
      try {
        merges = await mergeCommits(c.root);
      } catch {
        /* not a git repo (or gone): every card here is unrecoverable */
      }
      mergesByRoot.set(c.root, merges);
    }
    const lines = await cardLines(c.root, c.task_id, mergesByRoot.get(c.root));
    rows.push({
      task_id: c.task_id,
      project: c.project,
      before: { added: c.added, removed: c.removed },
      after: lines && { added: lines.added, removed: lines.removed },
      source: lines ? lines.source : 'estimated',
    });
  }
  return rows;
}

/** Apply a plan in one transaction. Idempotent: re-running sets the same numbers/flags. */
export function applyRecount(db: DB, rows: RecountRow[]): void {
  db.transaction(() => {
    for (const r of rows) {
      if (r.after) setCardLines(db, r.task_id, r.after.added, r.after.removed);
      else flagLinesEstimated(db, r.task_id);
    }
  })();
}
