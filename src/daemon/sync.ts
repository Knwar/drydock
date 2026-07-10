import type { DB } from '../core/db.js';
import { getTask, listSyncLinks, taskContentHash, updateSyncLink } from '../core/board.js';
import type { SyncLink, Task } from '../core/types.js';

// ── bridge sync engine (Phase 5 foundations, LOCAL-ONLY) ────────────────────
//
// Phase 5 proves the bridge MACHINERY without any real provider: no Jira/Linear
// HTTP, no field mapping, no two-way import — that is Phase 9. `push` here just
// RECORDS the outbound sync operation (returns it) and reconciles the sync_link
// so the local/remote hashes converge. It reads board state + outbox and writes
// ONLY sync_links (via updateSyncLink).

/** A sync link whose local card's content hash no longer matches its stored local_hash. */
export interface ChangedEntry {
  link: SyncLink;
  task: Task;
  hash: string;
}

/** The outbound op recorded when a locally-originated change is pushed to a provider. */
export interface PushedOp {
  link_id: string;
  local_id: string;
  provider: string;
  external_id: string | null;
  hash: string;
}

/** A change that was reconciled but NOT pushed (its latest outbox origin was 'remote'). */
export interface SkippedOp {
  link_id: string;
  local_id: string;
  provider: string;
  external_id: string | null;
  hash: string;
}

export interface PushResult {
  pushed: PushedOp[];
  skipped: SkippedOp[];
}

/**
 * For every sync link of `provider`, load its local card, compute the current
 * content hash, and return the entries whose hash != the link's stored
 * local_hash. A null local_hash (never synced) counts as changed. Defensive
 * against a missing local card: if getTask throws (card gone), that link is
 * skipped rather than crashing the sweep.
 */
export function detectChanges(db: DB, provider: string): ChangedEntry[] {
  const changed: ChangedEntry[] = [];
  for (const link of listSyncLinks(db, { provider })) {
    let task: Task;
    try {
      task = getTask(db, link.local_id);
    } catch {
      // local card is gone — skip this link, don't crash the sweep.
      continue;
    }
    const hash = taskContentHash(task);
    if (hash !== link.local_hash) changed.push({ link, task, hash });
  }
  return changed;
}

/**
 * Push locally-changed cards of `provider` to the (mock) remote, with
 * loop-prevention. For each changed entry we inspect the CHANGE ORIGIN — the
 * latest outbox row for that card:
 *
 *   - origin === 'remote' → the change came in FROM a remote import, so pushing
 *     it back would echo it into an export→import→export loop. We do NOT push;
 *     we only reconcile (local_hash := current, WITHOUT last_synced_at) so the
 *     link converges, and record it in `skipped`.
 *   - otherwise ('local') → a genuine local edit: record the outbound op in
 *     `pushed` and reconcile (local_hash := current, last_synced_at := now).
 *
 * This latest-outbox-origin check is the Phase-5 DEMONSTRATION of breaking the
 * export→import→export loop. Phase 9's real bridge refines reconciliation
 * (remote_hash, field mapping, delta polling) against a live provider.
 *
 * `now` is injectable for deterministic tests.
 */
export function pushLocalToRemote(db: DB, provider: string, now = Date.now()): PushResult {
  const latestOrigin = db.prepare(
    'SELECT origin FROM outbox WHERE task_id = ? ORDER BY id DESC LIMIT 1',
  );
  const pushed: PushedOp[] = [];
  const skipped: SkippedOp[] = [];

  for (const { link, hash } of detectChanges(db, provider)) {
    const row = latestOrigin.get(link.local_id) as { origin: string } | undefined;
    const origin = row?.origin ?? 'local';

    if (origin === 'remote') {
      // Loop prevention: a remote-imported change must not be echoed back.
      // Reconcile the hash so it converges, but leave last_synced_at untouched.
      updateSyncLink(db, link.id, { local_hash: hash });
      skipped.push({
        link_id: link.id,
        local_id: link.local_id,
        provider: link.provider,
        external_id: link.external_id,
        hash,
      });
      continue;
    }

    // Local-originated change → record the outbound op and mark it synced.
    pushed.push({
      link_id: link.id,
      local_id: link.local_id,
      provider: link.provider,
      external_id: link.external_id,
      hash,
    });
    updateSyncLink(db, link.id, { local_hash: hash, last_synced_at: now });
  }

  return { pushed, skipped };
}
