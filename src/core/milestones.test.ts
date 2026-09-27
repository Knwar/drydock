import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createPhase, createVertical, deleteProject, getOrCreateProject, mergeVerticals } from './board.js';
import { openDb } from './db.js';
import { GovernanceError } from './decisions.js';
import { createMilestone, deleteMilestone, getMilestone, listMilestones, updateMilestone } from './milestones.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kankan-milestones-'));
  for (const sub of ['web', 'api', 'other']) mkdirSync(join(dir, sub), { recursive: true });
  const db = openDb();
  const ws = getOrCreateProject(db, dir, 'Shop');
  const web = createVertical(db, ws.id, 'web', join(dir, 'web'));
  const api = createVertical(db, ws.id, 'api', join(dir, 'api'));
  const other = getOrCreateProject(db, join(dir, 'other'), 'Other');
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, ws, web, api, other, cleanup };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GovernanceError, String(err));
    return err.code;
  }
  assert.fail('expected a GovernanceError');
};

describe('milestones', () => {
  it('create / update / delete, with validation', (t) => {
    const { db, ws, web, other, cleanup } = setup();
    t.after(cleanup);
    const ph = createPhase(db, web.id, 'Launch');
    const m = createMilestone(db, { project_id: ws.id, title: ' Beta ', date: '2026-11-01', phase_id: ph.id });
    assert.deepEqual([m.title, m.date, m.phase_id], ['Beta', '2026-11-01', ph.id]);
    const u = updateMilestone(db, m.id, { date: '2026-11-15', phase_id: null });
    assert.deepEqual([u.title, u.date, u.phase_id], ['Beta', '2026-11-15', null]);
    assert.equal(updateMilestone(db, m.id, { title: 'GA' }).title, 'GA');

    assert.equal(code(() => createMilestone(db, { project_id: ws.id, title: 'x', date: '2026-02-30' })), 'invalid');
    assert.equal(code(() => createMilestone(db, { project_id: ws.id, title: ' ', date: '2026-02-01' })), 'invalid');
    assert.equal(code(() => createMilestone(db, { project_id: 'nope', title: 'x', date: '2026-02-01' })), 'not_found');
    assert.equal(code(() => createMilestone(db, { project_id: ws.id, title: 'x', date: '2026-02-01', phase_id: 'nope' })), 'not_found');
    const foreign = createPhase(db, other.id, 'Else');
    assert.equal(code(() => createMilestone(db, { project_id: ws.id, title: 'x', date: '2026-02-01', phase_id: foreign.id })), 'invalid');
    assert.equal(code(() => createMilestone(db, [])), 'invalid');
    assert.equal(code(() => updateMilestone(db, 'nope', {})), 'not_found');
    assert.equal(code(() => updateMilestone(db, m.id, { date: 'soon' })), 'invalid');

    assert.equal(deleteMilestone(db, m.id).id, m.id);
    assert.equal(code(() => getMilestone(db, m.id)), 'not_found');
    assert.equal(code(() => deleteMilestone(db, m.id)), 'not_found');
  });

  it('lists: a workspace includes its verticals, a vertical its workspace; soonest first', (t) => {
    const { db, ws, web, api, cleanup } = setup();
    t.after(cleanup);
    createMilestone(db, { project_id: web.id, title: 'web', date: '2026-12-01' });
    createMilestone(db, { project_id: ws.id, title: 'ws', date: '2026-11-01' });
    createMilestone(db, { project_id: api.id, title: 'api', date: '2026-10-01' });
    assert.deepEqual(
      listMilestones(db, ws.id).map((m) => [m.title, m.scope]),
      [['api', 'vertical'], ['ws', 'own'], ['web', 'vertical']],
    );
    assert.deepEqual(
      listMilestones(db, web.id).map((m) => [m.title, m.scope]),
      [['ws', 'workspace'], ['web', 'own']],
    );
    assert.equal(code(() => listMilestones(db, 'nope')), 'not_found');
  });

  it('mergeVerticals re-points them; the fold nulls phase_id of deleted phases', (t) => {
    const { db, ws, web, api, cleanup } = setup();
    t.after(cleanup);
    const apiPhase = createPhase(db, api.id, 'API v1');
    const onApi = createMilestone(db, { project_id: api.id, title: 'a', date: '2026-10-01', phase_id: apiPhase.id });
    const onWs = createMilestone(db, { project_id: ws.id, title: 'w', date: '2026-10-02', phase_id: apiPhase.id });
    mergeVerticals(db, api.id, web.id, { phases: 'fold' });
    assert.deepEqual([getMilestone(db, onApi.id).project_id, getMilestone(db, onApi.id).phase_id], [web.id, null]);
    assert.equal(getMilestone(db, onWs.id).phase_id, null);
  });

  it('mergeVerticals append keeps the phase link', (t) => {
    const { db, web, api, cleanup } = setup();
    t.after(cleanup);
    const apiPhase = createPhase(db, api.id, 'API v1');
    const m = createMilestone(db, { project_id: api.id, title: 'a', date: '2026-10-01', phase_id: apiPhase.id });
    mergeVerticals(db, api.id, web.id, { phases: 'append' });
    assert.deepEqual([getMilestone(db, m.id).project_id, getMilestone(db, m.id).phase_id], [web.id, apiPhase.id]);
  });

  it('deleteProject removes its milestones and unlinks others from its phases', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const webPhase = createPhase(db, web.id, 'Web v1');
    const own = createMilestone(db, { project_id: web.id, title: 'own', date: '2026-10-01' });
    const pointing = createMilestone(db, { project_id: ws.id, title: 'ws', date: '2026-10-01', phase_id: webPhase.id });
    deleteProject(db, web.id);
    assert.equal(code(() => getMilestone(db, own.id)), 'not_found');
    assert.equal(getMilestone(db, pointing.id).phase_id, null);
  });
});
