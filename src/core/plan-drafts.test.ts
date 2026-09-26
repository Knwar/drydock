import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createVertical, deleteProject, getOrCreateProject } from './board.js';
import { openDb } from './db.js';
import {
  DraftError,
  applyDraftOps,
  createDraft,
  deleteDraft,
  draftContext,
  getDraft,
  listDrafts,
  renameDraft,
} from './plan-drafts.js';
import type { PlanNode } from './types.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kankan-drafts-'));
  for (const sub of ['apps/web', 'mobile']) mkdirSync(join(dir, sub), { recursive: true });
  const db = openDb();
  const ws = getOrCreateProject(db, dir, 'Shop');
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, dir, ws, cleanup };
}

const node = (id: string, extra: Partial<PlanNode> = {}): PlanNode => ({ id, title: `T ${id}`, board_id: 'b', ...extra });

describe('plan drafts', () => {
  it('create / get / list / rename / delete', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const d = createDraft(db, ws.id, 'Launch');
    assert.equal(d.version, 1);
    assert.deepEqual(d.data, { nodes: [], edges: [], committed: {} });
    assert.equal(d.committed_version, null);
    assert.deepEqual(getDraft(db, d.id), d);

    const d2 = createDraft(db, ws.id, 'Seeded', { nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] });
    const list = listDrafts(db, ws.id);
    assert.equal(list.length, 2);
    const seeded = list.find((x) => x.id === d2.id)!;
    assert.equal(seeded.node_count, 2);
    assert.equal(seeded.edge_count, 1);
    assert.ok(!('data' in seeded));

    const renamed = renameDraft(db, d.id, 'Launch v2');
    assert.equal(renamed.title, 'Launch v2');
    assert.equal(renamed.version, 2);
    assert.equal(getDraft(db, d.id)!.title, 'Launch v2');
    assert.throws(() => renameDraft(db, d.id, '  '), DraftError);

    assert.equal(deleteDraft(db, d.id), true);
    assert.equal(deleteDraft(db, d.id), false);
    assert.equal(getDraft(db, d.id), null);
    assert.deepEqual(
      listDrafts(db, ws.id).map((x) => x.id),
      [d2.id],
    );
  });

  it('applies ops and bumps version once per batch', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const d = createDraft(db, ws.id, 'Plan');
    const out = applyDraftOps(db, d.id, [
      { op: 'add_node', node: node('a') },
      { op: 'add_node', node: node('b', { tag: 'api', touches: ['src/x.ts'] }) },
      { op: 'add_edge', from: 'a', to: 'b' },
      { op: 'update_node', id: 'a', patch: { title: 'Alpha', requirements: 'r', subtasks: ['s'] } },
      { op: 'set_title', title: 'Renamed' },
    ]);
    assert.equal(out.version, 2);
    assert.equal(out.title, 'Renamed');
    assert.deepEqual(out.data.edges, [{ from: 'a', to: 'b' }]);
    assert.deepEqual(out.data.nodes[0], { id: 'a', title: 'Alpha', board_id: 'b', requirements: 'r', subtasks: ['s'] });
    assert.deepEqual(getDraft(db, d.id), out);

    const next = applyDraftOps(db, d.id, [
      { op: 'update_node', id: 'b', patch: { tag: null } as unknown as Partial<PlanNode> },
      { op: 'remove_edge', from: 'a', to: 'b' },
      // cycles are allowed while editing
      { op: 'add_edge', from: 'b', to: 'a' },
      { op: 'add_edge', from: 'a', to: 'b' },
    ]);
    assert.equal(next.version, 3);
    assert.equal(next.data.nodes[1].tag, undefined);
    assert.deepEqual(next.data.edges, [
      { from: 'b', to: 'a' },
      { from: 'a', to: 'b' },
    ]);
  });

  it('an invalid op rolls back the whole batch', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const d = createDraft(db, ws.id, 'Plan', { nodes: [node('a')] });
    const bad: Parameters<typeof applyDraftOps>[2][] = [
      [{ op: 'add_node', node: node('x') }, { op: 'add_node', node: node('a') }],
      [{ op: 'add_node', node: node('x') }, { op: 'add_edge', from: 'x', to: 'ghost' }],
      [{ op: 'add_node', node: node('x') }, { op: 'add_edge', from: 'x', to: 'x' }],
      [{ op: 'set_title', title: 'New' }, { op: 'remove_node', id: 'ghost' }],
      [{ op: 'remove_edge', from: 'a', to: 'a' }],
      [{ op: 'update_node', id: 'a', patch: { tag: 'nope' as never } }],
      [{ op: 'update_node', id: 'a', patch: { id: 'z' } as never }],
      [{ op: 'add_node', node: { id: 'y', title: 'Y' } as never }],
      [{ op: 'explode' } as never],
    ];
    for (const ops of bad) {
      assert.throws(() => applyDraftOps(db, d.id, ops), DraftError, JSON.stringify(ops));
    }
    assert.deepEqual(getDraft(db, d.id), d);
    assert.throws(() => applyDraftOps(db, 'nope', []), (e: unknown) => e instanceof DraftError && e.code === 'not_found');
  });

  it('remove_node drops its edges', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const d = createDraft(db, ws.id, 'Plan', {
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c' },
      ],
    });
    const out = applyDraftOps(db, d.id, [{ op: 'remove_node', id: 'b' }]);
    assert.deepEqual(
      out.data.nodes.map((n) => n.id),
      ['a', 'c'],
    );
    assert.deepEqual(out.data.edges, [{ from: 'a', to: 'c' }]);
  });

  it('rejects a vertical (or unknown project) as workspace_id', (t) => {
    const { db, dir, ws, cleanup } = setup();
    t.after(cleanup);
    const v = createVertical(db, ws.id, 'Web', join(dir, 'apps/web'));
    assert.throws(() => createDraft(db, v.id, 'Plan'), (e: unknown) => e instanceof DraftError && e.code === 'vertical');
    assert.throws(() => createDraft(db, 'nope', 'Plan'), (e: unknown) => e instanceof DraftError && e.code === 'not_found');
    assert.deepEqual(listDrafts(db, v.id), []);
  });

  it('draftContext lists the workspace + verticals with relative roots', (t) => {
    const { db, dir, ws, cleanup } = setup();
    t.after(cleanup);
    const web = createVertical(db, ws.id, 'Web', join(dir, 'apps/web'));
    const mob = createVertical(db, ws.id, 'Mobile', join(dir, 'mobile'));
    assert.deepEqual(draftContext(db, ws.id), {
      boards: [
        { id: ws.id, name: 'Shop', root: '' },
        { id: web.id, name: 'Web', root: 'apps/web' },
        { id: mob.id, name: 'Mobile', root: 'mobile' },
      ],
    });
  });

  it('deleting a project deletes its drafts', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const other = getOrCreateProject(db, '/tmp/other-drafts-proj', 'Other');
    createDraft(db, ws.id, 'One');
    createDraft(db, ws.id, 'Two');
    const keep = createDraft(db, other.id, 'Keep');
    deleteProject(db, ws.id);
    assert.deepEqual(listDrafts(db, ws.id), []);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM plan_drafts').get() as { n: number }).n, 1);
    assert.ok(getDraft(db, keep.id));
  });

  it('parses stored data defensively: corrupt → DraftError, missing keys default', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const d = createDraft(db, ws.id, 'Plan');
    const setData = (data: string) => db.prepare('UPDATE plan_drafts SET data = ? WHERE id = ?').run(data, d.id);
    const corrupt = (e: unknown) => e instanceof DraftError && e.code === 'corrupt';
    for (const bad of ['{not json', 'null', '[]', '{"nodes":{}}', '{"edges":"x"}', '{"committed":[]}']) {
      setData(bad);
      assert.throws(() => getDraft(db, d.id), corrupt, bad);
      assert.throws(() => applyDraftOps(db, d.id, [{ op: 'set_title', title: 'X' }]), corrupt, bad);
    }
    setData('{}');
    assert.deepEqual(getDraft(db, d.id)!.data, { nodes: [], edges: [], committed: {} });
    setData(JSON.stringify({ nodes: [node('a')] }));
    assert.deepEqual(getDraft(db, d.id)!.data, { nodes: [node('a')], edges: [], committed: {} });
  });

  it('createDraft ignores a provided committed map', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const seed = { nodes: [node('a')], committed: { a: 'card1' } } as Parameters<typeof createDraft>[3];
    const d = createDraft(db, ws.id, 'Plan', seed);
    assert.deepEqual(d.data.committed, {});
    assert.deepEqual(getDraft(db, d.id)!.data.committed, {});
  });
});
