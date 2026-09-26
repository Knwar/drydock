// `kankan recount-lines [--dry-run] [--db <path>]`: recompute every card's line
// counts from git history (merge commits, else live card branches) and flag the
// rest `estimated`. Explicit and idempotent; --dry-run opens the database
// read-only and prints what would change without writing anything.
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { applyRecount, planRecount, type Lines } from './lines.js';

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const dbFlag = argv.indexOf('--db');
  const path = dbFlag >= 0 ? argv[dbFlag + 1] : process.env.DB_PATH;
  if (!path) throw new Error('no database: pass --db <path> or set DB_PATH');
  // dry run opens read-only and skips migrations: it never writes to the file
  const db = dryRun ? new Database(path, { readonly: true, fileMustExist: true }) : openDb(path);
  const rows = await planRecount(db);
  const sum = (xs: (Lines | null)[]) =>
    xs.reduce<Lines>((a, x) => ({ added: a.added + (x?.added ?? 0), removed: a.removed + (x?.removed ?? 0) }), {
      added: 0,
      removed: 0,
    });
  for (const r of rows) {
    const after = r.after ? `+${r.after.added} -${r.after.removed}` : '(estimated, excluded)';
    console.log(`${r.project}\t${r.task_id}\t+${r.before.added} -${r.before.removed}\t→ ${after}\t[${r.source}]`);
  }
  const counts = { merge: 0, branch: 0, estimated: 0 };
  for (const r of rows) counts[r.source]++;
  const before = sum(rows.map((r) => r.before));
  const after = sum(rows.map((r) => r.after));
  console.log(
    `\n${rows.length} cards: ${counts.merge} from merge commits, ${counts.branch} from branches, ${counts.estimated} estimated` +
      `\nlines before: +${before.added} -${before.removed}   after: +${after.added} -${after.removed}`,
  );
  if (dryRun) console.log('dry run: nothing written');
  else {
    applyRecount(db, rows);
    console.log(`written to ${path}`);
  }
  db.close();
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
