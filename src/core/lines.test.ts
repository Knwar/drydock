import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assignCard,
  cardTotals,
  createTask,
  createTeamMember,
  getAgentBoard,
  getOrCreateProject,
  getStats,
  recordActivity,
  setCardLines,
} from './board.js';
import { openDb, type DB } from './db.js';
import { applyRecount, cardLines, isCountedPath, planRecount, sumNumstat } from './lines.js';

const WORKTREE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'worktree.js');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const wt = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, [WORKTREE, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
const write = (dir: string, file: string, content: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
};
const commitAll = (dir: string, msg: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', msg);
};

/**
 * Fixture repo shaped like this one: `main` far behind a feature branch the card
 * worktrees are created from (main...card would count the whole feature branch).
 */
function fixtureRepo(t: TestContext): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-lines-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  write(repo, 'README.md', 'hi\n');
  commitAll(repo, 'init');
  git(repo, 'checkout', '-b', 'feat');
  write(repo, 'big.ts', lines(1000, 'big')); // unrelated work already on the base branch
  commitAll(repo, 'feature work');
  return repo;
}

/** kankan worktree add <id>, then commit `files` in the card worktree. */
function buildCard(repo: string, id: string, files: Record<string, string>) {
  if (!git(repo, 'branch', '--list', `card/${id}`)) wt(repo, 'add', id);
  const tree = join(repo, '.trees', id);
  for (const [f, c] of Object.entries(files)) write(tree, f, c);
  commitAll(tree, `build ${id}`);
}

function boardFor(repo: string) {
  const db = openDb();
  const project = getOrCreateProject(db, repo);
  createTeamMember(db, 'Ada');
  return { db, project };
}

function card(db: DB, projectId: string, title: string) {
  const task = createTask(db, projectId, title);
  assignCard(db, task.id, 'Ada', `.trees/${task.id}`, `card/${task.id}`);
  return task;
}

const run = (db: DB, projectId: string, taskId: string, lines_added = 0, lines_removed = 0) =>
  recordActivity(db, { project_id: projectId, task_id: taskId, agent: 'Ada', tokens: 10, tokens_out: 1, lines_added, lines_removed, ms: 1000 });

describe('line counting', () => {
  it('counts paths: lockfiles, dist/, build/, node_modules/ and binaries are excluded', () => {
    assert.equal(isCountedPath('src/a.ts'), true);
    assert.equal(isCountedPath('src/build.ts'), true); // a file named build is fine
    for (const p of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'dist/a.js', 'pkg/build/x.js', 'node_modules/x/i.js'])
      assert.equal(isCountedPath(p), false, p);
    assert.equal(isCountedPath('mobile/pubspec.lock'), false);
    assert.deepEqual(
      sumNumstat(['3\t1\tsrc/a.ts', '-\t-\timg.png', '9\t9\tpackage-lock.json', '2\t0\t', 'old/x.ts', 'new/x.ts', '4\t0\t', 'a.js', 'dist/a.js', ''].join('\x00')),
      { added: 5, removed: 1 }, // rename judged by its destination: new/x.ts counts, dist/a.js doesn't
    );
  });

  it('card branch: only source lines, counted against the recorded base (not main)', async (t) => {
    const repo = fixtureRepo(t);
    const { db, project } = boardFor(repo);
    const task = card(db, project.id, 'feature');
    buildCard(repo, task.id, {
      'src/app.ts': lines(12),
      'package-lock.json': lines(5000, 'lock'),
      'dist/app.js': lines(800, 'dist'),
      'logo.png': Buffer.from([0, 1, 2, 0, 255]).toString('binary'),
    });
    const tree = join(repo, '.trees', task.id);
    git(tree, 'mv', 'big.ts', 'src/big.ts'); // a pure move counts nothing
    git(tree, 'commit', '-m', 'move');
    assert.equal(git(repo, 'config', '--get', `branch.card/${task.id}.kankanbase`), 'feat');
    git(repo, 'checkout', 'main'); // the root checkout moved: the recorded base still wins
    assert.deepEqual(await cardLines(repo, task.id), { added: 12, removed: 0, source: 'branch' });
  });

  it('a card built twice is counted once (the latest diff, not the sum of runs)', async (t) => {
    const repo = fixtureRepo(t);
    const { db, project } = boardFor(repo);
    const task = card(db, project.id, 'feature');
    buildCard(repo, task.id, { 'src/app.ts': lines(10) });
    run(db, project.id, task.id);
    let l = (await cardLines(repo, task.id))!;
    setCardLines(db, task.id, l.added, l.removed);
    buildCard(repo, task.id, { 'src/app.ts': lines(15) }); // second round: +5 more
    run(db, project.id, task.id);
    l = (await cardLines(repo, task.id))!;
    setCardLines(db, task.id, l.added, l.removed);
    assert.deepEqual(
      { a: cardTotals(db, task.id).lines_added, tok: cardTotals(db, task.id).tokens },
      { a: 15, tok: 20 },
    );
    assert.equal(getStats(db, project.id).agents[0].lines_added, 15);
    assert.equal(getAgentBoard(db, project.id).find((m) => m.name === 'Ada')!.lines_added, 15);
  });

  it('recount: merged cards from their merge commit, unrecoverable ones flagged estimated; idempotent', async (t) => {
    const repo = fixtureRepo(t);
    const { db, project } = boardFor(repo);
    const merged = card(db, project.id, 'merged');
    buildCard(repo, merged.id, { 'src/m.ts': lines(7), 'big.ts': lines(998, 'big'), 'yarn.lock': lines(300) });
    wt(repo, 'merge', merged.id); // on feat; branch deleted, only the merge commit remains
    const lost = card(db, project.id, 'lost'); // never got a branch or a merge
    // legacy rows: inflated, per-run cumulative counts (diffed against main)
    run(db, project.id, merged.id, 1300, 2);
    run(db, project.id, merged.id, 1310, 2);
    run(db, project.id, lost.id, 1000, 0);

    const plan = await planRecount(db);
    const byId = new Map(plan.map((r) => [r.task_id, r]));
    // merge commit vs first parent: +7 src, big.ts rewrote 2 lines (+0 -2), lockfile skipped
    assert.deepEqual(byId.get(merged.id), {
      task_id: merged.id,
      project: project.name,
      before: { added: 2610, removed: 4 },
      after: { added: 7, removed: 2 },
      source: 'merge',
    });
    assert.deepEqual(byId.get(lost.id)!.after, null);
    assert.equal(byId.get(lost.id)!.source, 'estimated');
    assert.equal(getStats(db, project.id).totals.lines_added, 3610); // planning writes nothing

    applyRecount(db, plan);
    applyRecount(db, await planRecount(db)); // second run: same result
    const stats = getStats(db, project.id);
    assert.deepEqual([stats.totals.lines_added, stats.totals.lines_removed, stats.totals.cards], [7, 2, 2]);
    assert.equal(stats.agents[0].lines_added, 7); // the estimated card's 1000 is excluded
    assert.equal(getAgentBoard(db, project.id).find((m) => m.name === 'Ada')!.lines_added, 7);
    const flags = db.prepare('SELECT task_id, estimated, lines_added FROM card_activity ORDER BY id').all();
    assert.deepEqual(
      flags.map((r) => ({ ...(r as object) })),
      [
        { task_id: merged.id, estimated: 0, lines_added: 0 },
        { task_id: merged.id, estimated: 0, lines_added: 7 },
        { task_id: lost.id, estimated: 1, lines_added: 1000 }, // raw value kept, just flagged
      ],
    );
  });

  it('recount: a project folder that is not a git repo → estimated, no throw', async (t) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kankan-nogit-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { db, project } = boardFor(dir);
    const task = card(db, project.id, 'x');
    run(db, project.id, task.id, 50, 5);
    const plan = await planRecount(db);
    assert.equal(plan[0].source, 'estimated');
    applyRecount(db, plan);
    assert.equal(getStats(db, project.id).totals.lines_added, 0);
  });
});
