#!/usr/bin/env node
// git worktree helpers: one isolated worktree per card.
//   add    <task_id>            create .trees/<id> on branch card/<id>
//   remove <task_id> [--force]  drop the worktree (+ branch if merged; -D with --force)
//   merge  <task_id>            merge card/<id> into the current branch, then clean up
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [cmd, taskId, flag] = process.argv.slice(2);
if (!['add', 'remove', 'merge'].includes(cmd ?? '') || !taskId) {
  console.error('usage: node scripts/worktree.js <add|remove|merge> <task_id> [--force]');
  process.exit(1);
}

const tree = join('.trees', taskId);
const branch = `card/${taskId}`;

function git(...args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

/** Keep .trees/ out of git status via the local-only exclude file. */
function excludeTrees() {
  const exclude = join(git('rev-parse', '--git-common-dir'), 'info', 'exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('.trees/')) appendFileSync(exclude, '.trees/\n');
}

/** Sync sleep for the lock retry loop. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Owner pid is gone (ESRCH) → the lock is stale. Missing/unreadable owner → held. */
function isStale(lock) {
  let pid;
  try {
    pid = Number(readFileSync(join(lock, 'owner'), 'utf8').split('\n')[0]);
  } catch {
    return false; // another process may be mid-acquire
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

/** Exclusive per-repo merge lock: atomic mkdir in the git common dir. */
function acquireLock() {
  const lock = join(resolve(git('rev-parse', '--git-common-dir')), 'kankan-merge.lock');
  const deadline = Date.now() + 60_000;
  let waited = false;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), `${process.pid}\n${taskId}\n`);
      return lock;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (isStale(lock)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      console.error(`timed out after 60s waiting for the merge lock: ${lock} (remove it if no merge is running)`);
      process.exit(1);
    }
    if (!waited) console.log('waiting for another merge to finish…');
    waited = true;
    sleep(250);
  }
}

if (cmd === 'add') {
  excludeTrees();
  git('worktree', 'add', tree, '-b', branch);
  console.log(`${tree} on ${branch}`);
} else if (cmd === 'remove') {
  git('worktree', 'remove', ...(flag === '--force' ? ['--force'] : []), tree);
  try {
    git('branch', flag === '--force' ? '-D' : '-d', branch);
  } catch {
    // unmerged branch without --force: keep it, the worktree is gone
  }
  console.log(`removed ${tree}`);
} else {
  const lock = acquireLock();
  let conflicted = false;
  try {
    try {
      git('merge', '--no-ff', branch, '-m', `Merge ${branch}`);
    } catch {
      conflicted = true;
    }
    if (!conflicted) {
      git('worktree', 'remove', tree);
      git('branch', '-d', branch);
      console.log(`merged ${branch}, removed ${tree}`);
    }
  } finally {
    rmSync(lock, { recursive: true, force: true }); // release before any exit
  }
  if (conflicted) {
    console.error(`merge of ${branch} conflicted — resolve and commit, or run: git merge --abort`);
    process.exit(1);
  }
}
