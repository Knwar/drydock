import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../core/db.js';
import { startDaemon, type TestDaemon } from './test-daemon.js';

// Daily snapshots (startup + debounced after phase changes), GET /metrics/history,
// usage samples surviving a restart, and workType on /metrics/wait and /report,
// against the REAL daemon. Restarts reuse one DB file via startDaemon({dbPath}).

const client = (d: TestDaemon) => {
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${d.base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async (path: string) => {
    const res = await fetch(`${d.base}${path}`);
    return { status: res.status, body: (await res.json()) as any };
  };
  const ok = async (path: string) => {
    const r = await get(path);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const project = async (root: string) => {
    mkdirSync(root, { recursive: true });
    return ((await (await fetch(`${d.base}/project?root=${encodeURIComponent(root)}`)).json()) as { project_id: string }).project_id;
  };
  const phase = async (projectId: string, title: string) =>
    ((await (await send('POST', '/phase', { project_id: projectId, title })).json()) as { phase_id: string }).phase_id;
  const task = async (projectId: string, title: string, extra: Record<string, unknown> = {}) =>
    ((await (await send('POST', '/task', { project_id: projectId, title, ...extra })).json()) as { task_id: string }).task_id;
  return { send, get, ok, project, phase, task };
};

async function until<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; ) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('daemon snapshots + /metrics/history + usage persistence', () => {
  it('snapshots top-level projects on start, refreshes after a target change, serves history', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-snapshots-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'board.db');

    // first run: a workspace with one vertical, plus a standalone board
    let daemon = await startDaemon({ dbPath });
    let c = client(daemon);
    const wsRoot = join(dir, 'ws');
    mkdirSync(wsRoot, { recursive: true });
    writeFileSync(join(wsRoot, '.mcp.json'), '{}');
    const ws = await c.project(wsRoot);
    mkdirSync(join(wsRoot, 'api'));
    const vres = await c.send('POST', '/vertical', { workspace_id: ws, name: 'api', root: join(wsRoot, 'api') });
    const vbody = (await vres.json()) as { project_id: string };
    assert.equal(vres.status, 200, JSON.stringify(vbody));
    const v = vbody.project_id;
    const solo = await c.project(join(dir, 'solo'));
    const wsPhase = await c.phase(ws, 'WS1');
    const vPhase = await c.phase(v, 'V1');
    const soloPhase = await c.phase(solo, 'S1');
    await c.task(v, 'a', { phase_id: vPhase });
    await daemon.stop();

    // second run on the same DB: the startup snapshot covers all three boards' phases
    daemon = await startDaemon({ dbPath });
    t.after(() => daemon.stop());
    c = client(daemon);
    const h = await until(async () => {
      const b = await c.ok(`/metrics/history?project=${ws}`);
      return b.phases.length >= 2 ? b : undefined;
    });
    // only the top-level projects (the workspace + the standalone board) were processed
    assert.match(daemon.output(), /snapshots: 2 top-level project\(s\), 2 taken/);
    assert.deepEqual(h.phases.map((p: any) => p.phase_id).sort(), [wsPhase, vPhase].sort());
    const vRow = h.phases.find((p: any) => p.phase_id === vPhase);
    assert.equal(vRow.project_id, v);
    assert.equal(vRow.scope, 1);
    assert.equal(vRow.target_date, null);
    assert.ok(Array.isArray(h.milestones));
    assert.equal(h.deltas, null);
    const solo1 = await c.ok(`/metrics/history?project=${solo}`);
    assert.deepEqual(solo1.phases.map((p: any) => p.phase_id), [soloPhase]);
    const today = vRow.date;

    // a target change refreshes today's row (debounced, off the request path)
    assert.equal((await c.send('PUT', `/phase/${vPhase}/target`, { target_date: '2031-01-15' })).status, 200);
    const refreshed = await until(async () => {
      const b = await c.ok(`/metrics/history?project=${ws}&phase=${vPhase}`);
      return b.phases[0]?.target_date === '2031-01-15' ? b : undefined;
    });
    assert.equal(refreshed.phases.length, 1);
    assert.equal(refreshed.phases[0].date, today);
    assert.equal(refreshed.deltas.phase_id, vPhase);
    assert.equal(refreshed.deltas.from, today);
    assert.equal(refreshed.deltas.to, today);
    assert.deepEqual(Object.keys(refreshed.deltas).sort(), [
      'budgetChange', 'from', 'milestoneMoves', 'phase_id', 'riskScoreChange', 'scopeChange', 'slipDays', 'spendChange', 'to',
    ]);

    // any phase status change (here back to planned) forces a refresh, bypassing the staleness skip
    const before = refreshed.phases[0].created_at;
    assert.equal((await c.send('POST', `/phase/${vPhase}`, { status: 'planned' })).status, 200);
    await until(async () => {
      const b = await c.ok(`/metrics/history?project=${ws}&phase=${vPhase}`);
      return b.phases[0].created_at > before ? b : undefined;
    });

    // range + validation
    assert.equal((await c.ok(`/metrics/history?project=${ws}&phase=${vPhase}&to=2000-01-01`)).deltas, null, 'no snapshot on/before to');
    assert.equal((await c.ok(`/metrics/history?project=${ws}&from=2000-01-01&to=2000-01-02`)).phases.length, 0);
    assert.equal((await c.get(`/metrics/history?project=nope`)).status, 404);
    assert.equal((await c.get(`/metrics/history`)).status, 400);
    assert.equal((await c.get(`/metrics/history?project=${ws}&phase=nope`)).status, 404);
    assert.equal((await c.get(`/metrics/history?project=${ws}&phase=${soloPhase}`)).status, 400);
    assert.equal((await c.get(`/metrics/history?project=${ws}&from=yesterday`)).status, 400);
    assert.equal((await c.get(`/metrics/history?project=${ws}&from=2026-13-45`)).status, 400);
    assert.equal((await c.get(`/metrics/history?project=${ws}&to=2026-02-30`)).status, 400);
    assert.equal((await c.get(`/metrics/history?project=${ws}&from=2026-02-02&to=2026-02-01`)).status, 400);
    await daemon.stop();

    // third run, nothing changed since today's rows: the startup sweep skips both projects
    daemon = await startDaemon({ dbPath });
    await until(async () => (/snapshots: /.test(daemon.output()) ? true : undefined));
    assert.match(daemon.output(), /snapshots: 2 top-level project\(s\), 0 taken/);
  });

  it('usage samples survive a daemon restart; same-millisecond pushes are all kept', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-usage-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'board.db');
    let daemon = await startDaemon({ dbPath });
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    const push = (used: number) => client(daemon).send('POST', '/usage', { five_hour: { used_percentage: used, resets_at: resetsAt } });
    const burst = await Promise.all([30, 31, 32, 33, 34].map(push)); // concurrent: likely to share a millisecond
    for (const r of burst) assert.equal(r.status, 200);
    assert.equal((await push(42)).status, 200);
    await daemon.stop();
    const db = openDb(dbPath);
    try {
      const ats = (db.prepare('SELECT at FROM usage_samples ORDER BY at').all() as { at: number }[]).map((r) => r.at);
      assert.equal(ats.length, 6, 'every push persisted');
      assert.equal(new Set(ats).size, 6);
    } finally {
      db.close();
    }

    daemon = await startDaemon({ dbPath });
    t.after(() => daemon.stop());
    const burn = await client(daemon).ok('/metrics/usage-burn');
    assert.equal(burn.status, 'ok');
    assert.equal(burn.limits.five_hour.usedPct, 42);
    assert.equal(burn.limits.seven_day, null);
  });

  it('workType filters /metrics/wait and /report; unknown → 400', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const c = client(daemon);
    const p = await c.project(join(daemon.dbDir, 'app'));
    const defect = await c.task(p, 'Defect', { work_type: 'defect' });
    const plain = await c.task(p, 'Plain');
    for (const id of [defect, plain]) assert.equal((await c.send('POST', `/task/${id}/block`, { reason: 'q' })).status, 200);

    const blockers = async (q: string) =>
      (await c.ok(`/metrics/wait?project=${p}${q}`)).waiting.blockers.map((b: any) => b.task_id);
    assert.deepEqual((await blockers('')).sort(), [defect, plain].sort());
    assert.deepEqual(await blockers('&workType=defect'), [defect]);
    assert.deepEqual(await blockers('&workType=none'), [plain]);
    assert.deepEqual(await blockers('&workType=feature'), []);
    assert.equal((await c.get(`/metrics/wait?project=${p}&workType=bogus`)).status, 400);

    const reportBlockers = async (q: string) => (await c.ok(`/report?project=${p}${q}`)).blockers.map((b: any) => b.id);
    assert.deepEqual((await reportBlockers('')).sort(), [defect, plain].sort());
    assert.deepEqual(await reportBlockers('&workType=defect'), [defect]);
    assert.deepEqual(await reportBlockers('&workType=none'), [plain]);
    assert.equal((await c.get(`/report?project=${p}&workType=bogus`)).status, 400);
    assert.equal((await fetch(`${daemon.base}/report.md?project=${p}&workType=bogus`)).status, 400);
  });

  it('budgets stay unfiltered under workType on /metrics/cost and /report', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const c = client(daemon);
    const M = 1_000_000;
    assert.equal(
      (
        await c.send('PUT', '/settings/prices', {
          models: { 'claude-opus-5-5': { input: 10, output: 50, cache_read: 1, cache_creation: 12 } },
          default: { input: 100, output: 100, cache_read: 100, cache_creation: 100 },
        })
      ).status,
      200,
    );
    const p = await c.project(join(daemon.dbDir, 'app'));
    const ph = await c.phase(p, 'P1');
    const defect = await c.task(p, 'Defect', { phase_id: ph, work_type: 'defect' });
    const plain = await c.task(p, 'Plain', { phase_id: ph });
    const run = (id: string, model: string) => c.send('POST', `/task/${id}/activity`, { agent: 'builder', usage: { [model]: { input: M } } });
    assert.equal((await run(defect, 'claude-opus-5-5')).status, 200); // $10
    assert.equal((await run(plain, 'mystery-1')).status, 200); // $100
    assert.equal((await c.send('PUT', `/phase/${ph}/budget`, { budget_usd: 50 })).status, 200);

    // /metrics/cost: totals filtered, budget over the whole phase
    const all = await c.ok(`/metrics/cost?project=${p}&tz=UTC`);
    assert.equal(all.budgetsUnfiltered, false);
    const cost = await c.ok(`/metrics/cost?project=${p}&tz=UTC&workType=defect`);
    assert.equal(cost.totals.cost, 10);
    assert.equal(cost.budgetsUnfiltered, true);
    assert.deepEqual(
      [cost.budgets[0].actual, cost.budgets[0].remainingCards, cost.budgets[0].overBudget],
      [all.budgets[0].actual, all.budgets[0].remainingCards, true],
    );
    assert.equal(cost.budgets[0].actual, 110);
    assert.equal(cost.budgets[0].remainingCards, 2);

    // /report: same
    const r = await c.ok(`/report?project=${p}&tz=UTC&workType=defect`);
    assert.equal(r.metrics.cost.total_usd, 10);
    assert.equal(r.metrics.cost.budgets_unfiltered, true);
    assert.deepEqual([r.metrics.cost.budgets[0].actual_usd, r.metrics.cost.budgets[0].status], [110, 'over']);
    assert.equal((await c.ok(`/report?project=${p}&tz=UTC`)).metrics.cost.budgets_unfiltered, false);
    const md = await (await fetch(`${daemon.base}/report.md?project=${p}&tz=UTC&workType=defect`)).text();
    assert.match(md, /Budget P1: \$110\.00 of \$50\.00.*over budget/);
    assert.match(md, /\(budget status covers all work in the phase\)/);
    const plainMd = await (await fetch(`${daemon.base}/report.md?project=${p}&tz=UTC`)).text();
    assert.doesNotMatch(plainMd, /budget status covers all work/);
  });
});
