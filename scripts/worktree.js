#!/usr/bin/env node
// git worktree helpers: one isolated worktree per card.
//   add    <task_id>            create .trees/<id> on branch card/<id>
//   remove <task_id> [--force]  drop the worktree (+ branch if merged; -D with --force)
//   merge  <task_id>            run the verify check, merge card/<id> into the current branch, clean up
//   verify <task_id|.>          run the project's verify check (tests, lint, typecheck) in the card's worktree
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [cmd, taskId, flag] = process.argv.slice(2);
if (!['add', 'remove', 'merge', 'verify'].includes(cmd ?? '') || !taskId) {
  console.error('usage: node scripts/worktree.js <add|remove|merge|verify> <task_id> [--force]');
  process.exit(1);
}

const tree = taskId === '.' ? '.' : join('.trees', taskId);
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

/**
 * The project's verify command: "verify" in .ai-brain/run.json, else the
 * package.json scripts that exist (lint, typecheck, test). null = none set.
 */
function verifyCommand(dir) {
  try {
    const r = JSON.parse(readFileSync(join(dir, '.ai-brain', 'run.json'), 'utf8'));
    if (typeof r.verify === 'string' && r.verify.trim()) return r.verify;
  } catch {
    /* no recipe */
  }
  try {
    const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {};
    const pm = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : 'npm';
    const steps = ['lint', 'typecheck'].filter((k) => scripts[k]).map((k) => `${pm} run ${k}`);
    if (scripts.test && !/no test specified/.test(scripts.test)) steps.push(`${pm} test`);
    return steps.length ? steps.join(' && ') : null;
  } catch {
    return null;
  }
}

/** Run the verify check in `dir`. Prints one line on success and only the tail of the output on failure. */
function verify(dir) {
  const command = verifyCommand(dir);
  if (!command) {
    console.log('verify: no check set (add "verify" to .ai-brain/run.json, e.g. "npm run lint && npm test")');
    return true;
  }
  const r = spawnSync('/bin/bash', ['-lc', command], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
  if (r.status === 0) {
    console.log(`verify passed: ${command}`);
    return true;
  }
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-60).join('\n');
  console.error(`verify FAILED (${r.signal ?? `exit ${r.status}`}): ${command}\n${tail}`);
  return false;
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
  // record the base (the branch we're on) so lines are counted as <base>...card/<id>,
  // not against main; git drops the key with the branch
  let base = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (base === 'HEAD') base = git('rev-parse', 'HEAD'); // detached: the commit itself
  git('worktree', 'add', tree, '-b', branch);
  try {
    git('config', `branch.${branch}.kankanbase`, base);
  } catch (err) {
    // the worktree and branch exist: only the lines base is missing (counted against the current branch)
    console.warn(`warning: couldn't record the base branch for ${branch}: ${err.message}`);
  }
  console.log(`${tree} on ${branch}`);
} else if (cmd === 'remove') {
  git('worktree', 'remove', ...(flag === '--force' ? ['--force'] : []), tree);
  try {
    git('branch', flag === '--force' ? '-D' : '-d', branch);
  } catch {
    // unmerged branch without --force: keep it, the worktree is gone
  }
  console.log(`removed ${tree}`);
} else if (cmd === 'verify') {
  process.exit(verify(tree) ? 0 : 1);
} else {
  // nothing merges until its checks pass
  if (!verify(tree)) {
    console.error(`not merged: ${branch} stays in ${tree}; fix it and run the merge again`);
    process.exit(1);
  }
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
