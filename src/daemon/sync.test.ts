import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendEvent,
  createSyncLink,
  createTask,
  getOrCreateProject,
  getSyncLink,
  taskContentHash,
  updateSyncLink,
  updateTask,
} from '../core/board.js';
import { openDb, type DB } from '../core/db.js';
import { detectChanges, pushLocalToRemote } from './sync.js';

const PROVIDER = 'jira';

function setup() {
  const db = openDb();
  const project = getOrCreateProject(db, '/tmp/sync-app', 'Sync App');
  return { db, project };
}

/** Seed a linked card and immediately reconcile its link to the current hash → "already synced". */
function linkedInSync(db: DB, projectId: string, title: string) {
  const task = createTask(db, projectId, title);
  const link = createSyncLink(db, { project_id: projectId, local_id: task.id, provider: PROVIDER });
  updateSyncLink(db, link.id, { local_hash: taskContentHash(task) });
  return { task, linkId: link.id };
}

describe('detectChanges', () => {
  it('finds a never-synced link (null local_hash counts as changed)', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'brand new');
    createSyncLink(db, { project_id: project.id, local_id: task.id, provider: PROVIDER });

    const changed = detectChanges(db, PROVIDER);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].link.local_id, task.id);
    assert.equal(changed[0].hash, taskContentHash(task));
  });

  it('omits a link already in sync (local_hash == current hash)', () => {
    const { db, project } = setup();
    linkedInSync(db, project.id, 'settled');

    assert.deepEqual(detectChanges(db, PROVIDER), []);
  });

  it('finds a link whose local card changed after last sync', () => {
    const { db, project } = setup();
    const { task } = linkedInSync(db, project.id, 'will change');
    assert.deepEqual(detectChanges(db, PROVIDER), []); // baseline: in sync

    updateTask(db, task.id, { requirements: 'now with new requirements' });

    const changed = detectChanges(db, PROVIDER);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].link.local_id, task.id);
    assert.equal(changed[0].hash, taskContentHash(changed[0].task));
    assert.notEqual(changed[0].hash, taskContentHash(task)); // hash moved off the old content
  });

  it('is scoped to the requested provider', () => {
    const { db, project } = setup();
    const task = createTask(db, project.id, 'multi-provider');
    createSyncLink(db, { project_id: project.id, local_id: task.id, provider: PROVIDER });
    createSyncLink(db, { project_id: project.id, local_id: task.id, provider: 'linear' });

    assert.equal(detectChanges(db, PROVIDER).length, 1);
    assert.equal(detectChanges(db, 'linear').length, 1);
  });

  it('skips (does not crash on) a link whose local card is gone', () => {
    const { db, project } = setup();
    // a link pointing at a task id that was never created
    createSyncLink(db, { project_id: project.id, local_id: 'ghost-card', provider: PROVIDER });
    // plus one real changed link, to prove the sweep continues past the missing one
    const real = createTask(db, project.id, 'real');
    createSyncLink(db, { project_id: project.id, local_id: real.id, provider: PROVIDER });

    const changed = detectChanges(db, PROVIDER);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].link.local_id, real.id);
  });
});

describe('pushLocalToRemote', () => {
  it('(a) a locally-changed link → pushed, local_hash updated, last_synced_at set', () => {
    const { db, project } = setup();
    const { task, linkId } = linkedInSync(db, project.id, 'local edit');
    updateTask(db, task.id, { requirements: 'edited locally' });
    const newHash = taskContentHash(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as never);

    const NOW = 1_720_000_000_000;
    const { pushed, skipped } = pushLocalToRemote(db, PROVIDER, NOW);

    assert.equal(skipped.length, 0);
    assert.equal(pushed.length, 1);
    assert.deepEqual(pushed[0], {
      link_id: linkId,
      local_id: task.id,
      provider: PROVIDER,
      external_id: null,
      hash: newHash,
    });

    const link = getSyncLink(db, linkId)!;
    assert.equal(link.local_hash, newHash);
    assert.equal(link.last_synced_at, NOW);

    // idempotent: a second push after the reconcile finds nothing to do.
    assert.deepEqual(pushLocalToRemote(db, PROVIDER, NOW + 1), { pushed: [], skipped: [] });
  });

  it('(b) an unchanged link → no-op (nothing pushed, nothing skipped, link untouched)', () => {
    const { db, project } = setup();
    const { linkId } = linkedInSync(db, project.id, 'unchanged');
    const before = getSyncLink(db, linkId)!;

    const result = pushLocalToRemote(db, PROVIDER, 1_720_000_000_000);

    assert.deepEqual(result, { pushed: [], skipped: [] });
    const after = getSyncLink(db, linkId)!;
    assert.equal(after.local_hash, before.local_hash);
    assert.equal(after.last_synced_at, null); // never synced (was reconciled at seed, not pushed)
  });

  it("(c) latest outbox origin 'remote' → SKIPPED not pushed, local_hash reconciled, last_synced_at NOT set", () => {
    const { db, project } = setup();
    const { task, linkId } = linkedInSync(db, project.id, 'remote import');

    // Simulate a remote import: the card's content changes AND the change lands
    // in the outbox tagged origin='remote' (the latest row for this card).
    updateTask(db, task.id, { requirements: 'imported from the provider' });
    appendEvent(db, {
      project_id: project.id,
      task_id: task.id,
      type: 'note',
      payload: { imported: true },
      origin: 'remote',
    });
    const newHash = taskContentHash(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as never);

    // detectChanges still SEES the hash diff...
    const changed = detectChanges(db, PROVIDER);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].hash, newHash);

    // ...but pushLocalToRemote must NOT push it back (loop prevention).
    const NOW = 1_720_000_000_000;
    const { pushed, skipped } = pushLocalToRemote(db, PROVIDER, NOW);

    assert.equal(pushed.length, 0); // not echoed back to the remote
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].link_id, linkId);
    assert.equal(skipped[0].hash, newHash);

    const link = getSyncLink(db, linkId)!;
    assert.equal(link.local_hash, newHash); // reconciled so it converges
    assert.equal(link.last_synced_at, null); // NOT marked as an outbound sync

    // and now that it's reconciled, it no longer shows as changed.
    assert.deepEqual(detectChanges(db, PROVIDER), []);
  });

  it("defaults origin to 'local' when the card has no outbox rows → pushes", () => {
    const { db, project } = setup();
    // A link on a card whose content differs but that has no outbox history at
    // all: the LATEST-row lookup returns nothing → default 'local' → push.
    const task = createTask(db, project.id, 'no history');
    // clear the create-event outbox row so this card truly has none
    db.prepare('DELETE FROM outbox WHERE task_id = ?').run(task.id);
    createSyncLink(db, { project_id: project.id, local_id: task.id, provider: PROVIDER });

    const NOW = 1_720_000_000_000;
    const { pushed, skipped } = pushLocalToRemote(db, PROVIDER, NOW);
    assert.equal(skipped.length, 0);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].local_id, task.id);
  });

  it("a 'remote' event followed by a later 'local' event → the LATEST origin wins → pushes", () => {
    const { db, project } = setup();
    const { task } = linkedInSync(db, project.id, 'remote then local');
    // remote import first...
    appendEvent(db, { project_id: project.id, task_id: task.id, type: 'note', origin: 'remote' });
    // ...then a genuine local edit lands afterwards (higher outbox id).
    updateTask(db, task.id, { requirements: 'local edit after the import' });
    appendEvent(db, { project_id: project.id, task_id: task.id, type: 'note', origin: 'local' });

    const { pushed, skipped } = pushLocalToRemote(db, PROVIDER, 1_720_000_000_000);
    assert.equal(skipped.length, 0);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].local_id, task.id);
  });
});
