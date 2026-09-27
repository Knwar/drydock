import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createPhase, createTask, createVertical, deleteProject, getOrCreateProject, mergeVerticals } from './board.js';
import { openDb } from './db.js';
import {
  GovernanceError,
  createDecision,
  createRisk,
  getDecision,
  getRisk,
  listDecisions,
  listRisks,
  supersedeDecision,
  updateDecision,
  updateRisk,
} from './decisions.js';
import { createDraft } from './plan-drafts.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kankan-decisions-'));
  for (const sub of ['web', 'api', 'other']) mkdirSync(join(dir, sub), { recursive: true });
  const db = openDb();
  const ws = getOrCreateProject(db, dir, 'Shop');
  const web = createVertical(db, ws.id, 'web', join(dir, 'web'));
  const api = createVertical(db, ws.id, 'api', join(dir, 'api'));
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, dir, ws, web, api, cleanup };
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

describe('decision log', () => {
  it('create / get / update, with validation', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const d = createDecision(db, {
      project_id: ws.id,
      title: 'Autopilot skips Main',
      decision: 'Autopilot never prompts the workspace session',
      rationale: 'Main is the human’s seat',
      decided_by: 'user',
    });
    assert.equal(d.status, 'active');
    assert.equal(d.superseded_by, null);
    assert.equal(d.decided_at, d.created_at);
    assert.deepEqual(d.links, []);
    assert.deepEqual(getDecision(db, d.id), d);

    const u = updateDecision(db, d.id, { rationale: null, title: 'Autopilot skips the main session' });
    assert.equal(u.rationale, null);
    assert.equal(u.title, 'Autopilot skips the main session');
    assert.equal(u.decision, d.decision);

    assert.equal(code(() => createDecision(db, { project_id: ws.id, title: 'x' })), 'invalid');
    assert.equal(code(() => createDecision(db, { project_id: ws.id, title: ' ', decision: 'y' })), 'invalid');
    assert.equal(code(() => createDecision(db, { project_id: 'nope', title: 'x', decision: 'y' })), 'not_found');
    assert.equal(code(() => createDecision(db, null)), 'invalid');
    assert.equal(code(() => updateDecision(db, d.id, { status: 'superseded' })), 'invalid');
    assert.equal(code(() => updateDecision(db, d.id, { rationale: 3 })), 'invalid');
    assert.equal(code(() => updateDecision(db, 'nope', {})), 'not_found');
    assert.equal(code(() => getDecision(db, 'nope')), 'not_found');
  });

  it('links cards, phases and plans in the same workspace; unlink removes', (t) => {
    const { db, dir, ws, web, cleanup } = setup();
    t.after(cleanup);
    const card = createTask(db, web.id, 'Checkout page');
    const phase = createPhase(db, ws.id, 'Foundation');
    const plan = createDraft(db, ws.id, 'Launch');
    const d = createDecision(db, {
      project_id: ws.id,
      title: 't',
      decision: 'd',
      links: [
        { target_type: 'card', target_id: card.id },
        { target_type: 'phase', target_id: phase.id },
      ],
    });
    assert.deepEqual(d.links, [
      { target_type: 'card', target_id: card.id },
      { target_type: 'phase', target_id: phase.id },
    ]);
    const u = updateDecision(db, d.id, {
      link: [{ target_type: 'plan', target_id: plan.id }, { target_type: 'card', target_id: card.id }],
      unlink: [{ target_type: 'phase', target_id: phase.id }],
    });
    assert.deepEqual(u.links, [
      { target_type: 'card', target_id: card.id },
      { target_type: 'plan', target_id: plan.id },
    ]);

    // unknown target → not_found; another workspace → invalid; bad shape → invalid
    const other = getOrCreateProject(db, join(dir, 'other'), 'Other');
    const foreign = createTask(db, other.id, 'Elsewhere');
    const link = (target_type: string, target_id: unknown) => () =>
      updateDecision(db, d.id, { link: [{ target_type, target_id }] });
    assert.equal(code(link('card', 'nope')), 'not_found');
    assert.equal(code(link('card', foreign.id)), 'invalid');
    assert.equal(code(link('task', card.id)), 'invalid');
    assert.equal(code(link('card', 5)), 'invalid');
    assert.equal(code(() => updateDecision(db, d.id, { link: 'x' })), 'invalid');
    assert.equal(getDecision(db, d.id).links.length, 2, 'a rejected patch changes nothing');
  });

  it('supersede: new decision inherits links, old one points at it; only once', (t) => {
    const { db, web, cleanup } = setup();
    t.after(cleanup);
    const a = createTask(db, web.id, 'A');
    const b = createTask(db, web.id, 'B');
    const old = createDecision(db, {
      project_id: web.id,
      title: 'Drafts per board',
      decision: 'one draft per board',
      links: [{ target_type: 'card', target_id: a.id }],
    });
    const { superseded, decision } = supersedeDecision(db, old.id, {
      title: 'Drafts are workspace-wide',
      decision: 'one draft per workspace',
      links: [{ target_type: 'card', target_id: b.id }],
    });
    assert.equal(decision.project_id, web.id);
    assert.equal(decision.status, 'active');
    assert.deepEqual(
      decision.links.map((l) => l.target_id).sort(),
      [a.id, b.id].sort(),
    );
    assert.equal(superseded.status, 'superseded');
    assert.equal(superseded.superseded_by, decision.id);
    assert.equal(code(() => supersedeDecision(db, old.id, { title: 'x', decision: 'y' })), 'already_superseded');
    assert.equal(code(() => supersedeDecision(db, decision.id, { title: 'x' })), 'invalid');
    assert.equal(getDecision(db, decision.id).status, 'active', 'a failed supersede leaves the decision active');
    assert.equal(code(() => supersedeDecision(db, 'nope', { title: 'x', decision: 'y' })), 'not_found');
  });

  it('list: workspace includes verticals; filters by status, text, card, phase', (t) => {
    const { db, ws, web, api, cleanup } = setup();
    t.after(cleanup);
    const card = createTask(db, web.id, 'Card');
    const phase = createPhase(db, api.id, 'P1');
    const w = createDecision(db, { project_id: ws.id, title: 'Workspace one', decision: 'x', decided_at: 1000 });
    const v = createDecision(db, {
      project_id: web.id,
      title: 'Web one',
      decision: 'use SSR',
      rationale: 'SEO matters',
      decided_at: 3000,
      links: [{ target_type: 'card', target_id: card.id }],
    });
    const p = createDecision(db, {
      project_id: api.id,
      title: 'Api one',
      decision: 'REST',
      decided_at: 2000,
      links: [{ target_type: 'phase', target_id: phase.id }],
    });
    const ids = (list: { id: string }[]) => list.map((d) => d.id);
    assert.deepEqual(ids(listDecisions(db, ws.id)), [v.id, p.id, w.id], 'newest decided first');
    assert.deepEqual(ids(listDecisions(db, web.id)), [v.id], 'a vertical lists only its own');
    assert.deepEqual(ids(listDecisions(db, ws.id, { q: 'seo' })), [v.id], 'text search is case-insensitive over rationale');
    assert.deepEqual(ids(listDecisions(db, ws.id, { q: 'WORKSPACE' })), [w.id]);
    assert.deepEqual(ids(listDecisions(db, ws.id, { card: card.id })), [v.id]);
    assert.deepEqual(ids(listDecisions(db, ws.id, { phase: phase.id })), [p.id]);
    supersedeDecision(db, w.id, { title: 'Workspace two', decision: 'y', decided_at: 500 });
    assert.deepEqual(ids(listDecisions(db, ws.id, { status: 'superseded' })), [w.id]);
    assert.equal(listDecisions(db, ws.id, { status: 'active' }).length, 3);
    assert.equal(code(() => listDecisions(db, ws.id, { status: 'bogus' })), 'invalid');
    assert.equal(code(() => listDecisions(db, 'nope')), 'not_found');
  });
});

describe('risk register', () => {
  it('create / update with score, status and closed_at', (t) => {
    const { db, ws, cleanup } = setup();
    t.after(cleanup);
    const r = createRisk(db, { project_id: ws.id, title: 'Usage cap', likelihood: 3, impact: 4, owner: 'main' });
    assert.equal(r.score, 12);
    assert.equal(r.status, 'open');
    assert.equal(r.closed_at, null);
    assert.equal(r.description, null);
    assert.deepEqual(getRisk(db, r.id), r);

    const m = updateRisk(db, r.id, { status: 'mitigating', mitigation: 'pause autopilot at 80%', impact: 5 });
    assert.equal(m.score, 15);
    assert.equal(m.closed_at, null);
    const c = updateRisk(db, r.id, { status: 'closed' });
    assert.ok(c.closed_at !== null);
    const o = updateRisk(db, r.id, { status: 'occurred' });
    assert.equal(o.closed_at, c.closed_at, 'closed → occurred keeps the first close time');
    assert.equal(updateRisk(db, r.id, { status: 'open' }).closed_at, null, 'reopening clears closed_at');
    assert.ok(createRisk(db, { project_id: ws.id, title: 'x', likelihood: 1, impact: 1, status: 'closed' }).closed_at);

    for (const bad of [
      { project_id: ws.id, title: 'x', likelihood: 0, impact: 1 },
      { project_id: ws.id, title: 'x', likelihood: 6, impact: 1 },
      { project_id: ws.id, title: 'x', likelihood: 2.5, impact: 1 },
      { project_id: ws.id, title: 'x', likelihood: 2 },
      { project_id: ws.id, likelihood: 2, impact: 2 },
      { project_id: ws.id, title: 'x', likelihood: 2, impact: 2, status: 'gone' },
    ])
      assert.equal(code(() => createRisk(db, bad)), 'invalid', JSON.stringify(bad));
    assert.equal(code(() => createRisk(db, { project_id: 'nope', title: 'x', likelihood: 1, impact: 1 })), 'not_found');
    assert.equal(code(() => updateRisk(db, r.id, { impact: '5' })), 'invalid');
    assert.equal(code(() => updateRisk(db, r.id, { status: 'done' })), 'invalid');
    assert.equal(code(() => updateRisk(db, 'nope', {})), 'not_found');
  });

  it('list: sorted by score, filters by status, card and text; links/unlinks', (t) => {
    const { db, ws, web, cleanup } = setup();
    t.after(cleanup);
    const card = createTask(db, web.id, 'Card');
    const low = createRisk(db, { project_id: ws.id, title: 'Low', likelihood: 1, impact: 2 });
    const high = createRisk(db, {
      project_id: web.id,
      title: 'High',
      description: 'Flaky pty tests',
      likelihood: 4,
      impact: 4,
      links: [{ target_type: 'card', target_id: card.id }],
    });
    const mid = createRisk(db, { project_id: ws.id, title: 'Mid', likelihood: 3, impact: 2 });
    const ids = (list: { id: string }[]) => list.map((r) => r.id);
    assert.deepEqual(ids(listRisks(db, ws.id)), [high.id, mid.id, low.id]);
    updateRisk(db, mid.id, { status: 'closed' });
    assert.deepEqual(ids(listRisks(db, ws.id, { status: 'open' })), [high.id, low.id]);
    assert.deepEqual(ids(listRisks(db, ws.id, { card: card.id })), [high.id]);
    assert.deepEqual(ids(listRisks(db, ws.id, { q: 'pty' })), [high.id]);
    updateRisk(db, high.id, { unlink: [{ target_type: 'card', target_id: card.id }] });
    assert.deepEqual(listRisks(db, ws.id, { card: card.id }), []);
    assert.equal(code(() => listRisks(db, ws.id, { status: 'active' })), 'invalid');
  });
});

describe('decisions + risks follow the board', () => {
  it('mergeVerticals re-points them; fold drops links to the deleted phases', (t) => {
    const { db, web, api, cleanup } = setup();
    t.after(cleanup);
    const card = createTask(db, api.id, 'Endpoint');
    const phase = createPhase(db, api.id, 'API phase');
    const d = createDecision(db, {
      project_id: api.id,
      title: 't',
      decision: 'd',
      links: [
        { target_type: 'card', target_id: card.id },
        { target_type: 'phase', target_id: phase.id },
      ],
    });
    const r = createRisk(db, { project_id: api.id, title: 'r', likelihood: 2, impact: 2 });
    mergeVerticals(db, api.id, web.id, { phases: 'fold' });
    assert.equal(getDecision(db, d.id).project_id, web.id);
    assert.deepEqual(getDecision(db, d.id).links, [{ target_type: 'card', target_id: card.id }]);
    assert.equal(getRisk(db, r.id).project_id, web.id);
    assert.deepEqual(listDecisions(db, web.id).map((x) => x.id), [d.id]);
  });

  it('deleteProject removes its items and every link onto its cards/phases', (t) => {
    const { db, ws, web, api, cleanup } = setup();
    t.after(cleanup);
    const webCard = createTask(db, web.id, 'Web card');
    const apiCard = createTask(db, api.id, 'Api card');
    const wsDecision = createDecision(db, {
      project_id: ws.id,
      title: 't',
      decision: 'd',
      links: [
        { target_type: 'card', target_id: webCard.id },
        { target_type: 'card', target_id: apiCard.id },
      ],
    });
    const webDecision = createDecision(db, {
      project_id: web.id,
      title: 't',
      decision: 'd',
      links: [{ target_type: 'card', target_id: webCard.id }],
    });
    const webRisk = createRisk(db, { project_id: web.id, title: 'r', likelihood: 1, impact: 1 });
    deleteProject(db, web.id);
    assert.equal(code(() => getDecision(db, webDecision.id)), 'not_found');
    assert.equal(code(() => getRisk(db, webRisk.id)), 'not_found');
    assert.deepEqual(getDecision(db, wsDecision.id).links, [{ target_type: 'card', target_id: apiCard.id }]);
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM governance_links WHERE item_id IN (?, ?)')
      .get(webDecision.id, webRisk.id) as { n: number };
    assert.equal(orphans.n, 0);
  });
});
