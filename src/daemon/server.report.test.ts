import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../core/db.js';
import { startDaemon } from './test-daemon.js';

// GET /report, /report.md and the /report.html page against the REAL daemon (temp DB, random port).

const DAY = 86_400_000;
const dayUTC = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('/report', () => {
  it('JSON shape, RAG vs /metrics/schedule, Markdown, the page, 400/404', async (t) => {
    const daemon = await startDaemon();
    t.after(() => daemon.stop());
    const base = daemon.base;
    const send = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* markdown / html */
      }
      return { status: r.status, type: r.headers.get('content-type') ?? '', body: parsed, text };
    };
    const ok = async (method: string, path: string, body?: unknown) => {
      const r = await send(method, path, body);
      assert.equal(r.status, 200, `${method} ${path}: ${r.text}`);
      return r.body;
    };

    const root = join(daemon.dbDir, 'shop');
    mkdirSync(join(root, 'web'), { recursive: true });
    const wsId = (await ok('GET', `/project?root=${encodeURIComponent(root)}`)).project_id as string;
    const webId = (await ok('POST', '/vertical', { workspace_id: wsId, name: 'web', root: join(root, 'web') })).project_id as string;
    const phase = async (project_id: string, title: string) => {
      const id = (await ok('POST', '/phase', { project_id, title })).phase_id as string;
      await ok('POST', `/phase/${id}`, { status: 'active' });
      return id;
    };
    const task = async (project_id: string, title: string, extra: Record<string, unknown> = {}) =>
      (await ok('POST', '/task', { project_id, title, ...extra })).task_id as string;

    const late = await phase(wsId, 'Checkout');
    const open = await phase(webId, 'Web UI');
    await ok('PUT', `/phase/${late}/target`, { target_date: dayUTC(-2) });
    // shipped: 2 done now (in range), 1 done 20 days ago (out of range)
    const shipped = [await task(wsId, 'Pay button', { phase_id: late }), await task(webId, 'Cart page', { phase_id: open })];
    const old = await task(wsId, 'Old thing', { phase_id: late });
    for (const id of [...shipped, old]) await ok('POST', `/task/${id}/move`, { lane: 'done' });
    const db = openDb(join(daemon.dbDir, 'board.db'));
    try {
      const shift = 20 * DAY;
      db.prepare('UPDATE tasks SET created_at = created_at - ?, updated_at = updated_at - ? WHERE id = ?').run(shift, shift, old);
      db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(shift, old);
    } finally {
      db.close();
    }
    const queued = await task(webId, 'Search', { phase_id: open });
    await ok('POST', `/task/${queued}/move`, { lane: 'queued' });
    const doing = await task(wsId, 'Refunds', { phase_id: late });
    await ok('POST', `/task/${doing}/move`, { lane: 'in_progress' });
    await ok('POST', `/task/${doing}/block`, { reason: 'Stripe or Adyen?' });
    const reviewing = await task(webId, 'Filters', { phase_id: open });
    await ok('POST', `/task/${reviewing}/move`, { lane: 'in_review' });
    await ok('POST', '/milestones', { project_id: wsId, title: 'Beta', date: dayUTC(3), phase_id: late });
    await ok('POST', '/milestones', { project_id: wsId, title: 'GA', date: dayUTC(40) });
    await ok('POST', '/decisions', { project_id: wsId, title: 'Use Stripe', decision: 'Stripe for payments' });
    await ok('POST', '/risks', { project_id: webId, title: 'Flaky CI', likelihood: 3, impact: 4 });
    await ok('POST', '/risks', { project_id: wsId, title: 'Vendor slip', likelihood: 5, impact: 5 });

    // ── JSON ──
    const r = await ok('GET', `/report?project=${wsId}&tz=UTC`);
    for (const k of ['project', 'workspace', 'boards', 'range', 'today', 'generated_at', 'overall', 'phases', 'blockers', 'shipped', 'next', 'metrics', 'risks', 'decisions'])
      assert.ok(k in r, k);
    assert.deepEqual(r.boards.map((b: any) => b.id), [wsId, webId], 'a workspace includes its verticals');
    assert.equal(r.workspace, null);
    assert.equal(r.range.to_day, dayUTC(0));
    assert.equal(r.range.from_day, dayUTC(-6), 'default: the last 7 days');
    const s = await ok('GET', `/metrics/schedule?project=${wsId}&tz=UTC`);
    assert.deepEqual(
      r.phases.map((p: any) => [p.id, p.schedule_status]),
      s.phases.map((p: any) => [p.id, p.status]),
      'phase statuses come from /metrics/schedule',
    );
    const byTitle = Object.fromEntries(r.phases.map((p: any) => [p.title, p]));
    assert.equal(byTitle.Checkout.rag, 'red');
    assert.match(byTitle.Checkout.reason, /has passed/);
    assert.deepEqual(byTitle.Checkout.blockers.map((b: any) => b.task_id), [doing]);
    assert.equal(byTitle['Web UI'].rag, 'grey', 'no target → unknown → grey');
    assert.equal(r.overall.rag, 'red');
    assert.equal(r.shipped.total, 2);
    assert.deepEqual(r.shipped.boards.map((b: any) => b.board), ['shop', 'web']);
    assert.deepEqual(r.next.queued.map((c: any) => c.id), [queued]);
    assert.deepEqual(r.next.in_progress.map((c: any) => c.id), [doing]);
    assert.deepEqual(r.next.in_review.map((c: any) => c.id), [reviewing]);
    assert.ok(r.metrics.cost.notes.every((n: string) => !/\/settings|PUT /.test(n)), 'plain-language notes');
    assert.deepEqual(r.next.milestones.map((m: any) => m.title), ['Beta']);
    assert.equal(r.metrics.throughput, 2);
    assert.ok(Array.isArray(r.metrics.cost.caveats) && r.metrics.cost.caveats.length > 0);
    assert.deepEqual(r.risks.open.map((x: any) => [x.title, x.board]), [['Vendor slip', 'shop'], ['Flaky CI', 'web']]);
    assert.deepEqual(r.decisions.made.map((d: any) => d.title), ['Use Stripe']);

    // an explicit range: 30 days back catches the old card
    const wide = await ok('GET', `/report?project=${wsId}&tz=UTC&from=${dayUTC(-29)}&to=${dayUTC(0)}`);
    assert.equal(wide.shipped.total, 3);
    // only `to`: the 7 days ending that day
    const back = await ok('GET', `/report?project=${wsId}&tz=UTC&to=${dayUTC(-18)}`);
    assert.deepEqual([back.range.from_day, back.range.to_day], [dayUTC(-24), dayUTC(-18)]);
    assert.equal(back.shipped.total, 1, 'the card done 20 days ago');

    // a vertical: its own phases, the workspace named
    const v = await ok('GET', `/report?project=${webId}&tz=UTC`);
    assert.deepEqual(v.phases.map((p: any) => p.title), ['Web UI']);
    assert.deepEqual(v.workspace, { id: wsId, name: r.project.name });
    assert.equal(v.shipped.total, 1);

    // ── Markdown ──
    const md = await send('GET', `/report.md?project=${wsId}&tz=UTC`);
    assert.equal(md.status, 200);
    assert.match(md.type, /^text\/markdown/);
    assert.match(md.text, /^# Status report: /);
    assert.match(md.text, /Overall: \*\*Red\*\*/);
    assert.match(md.text, /\| shop \| Checkout \| Red \|/);
    assert.match(md.text, /## Shipped \(2\)/);
    assert.match(md.text, /- Pay button/);
    assert.match(md.text, /\*\*In review \(1\)\*\*\n\n- Filters \[web · Web UI\]/);
    assert.match(md.text, /- Blocked in Checkout: Refunds \(Stripe or Adyen\?\)/);
    assert.match(md.text, /## Decisions\n\n- \d{4}-\d\d-\d\d: \*\*Use Stripe\*\*/);

    // ── the page ──
    const page = await send('GET', '/report.html');
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    assert.match(page.text, /<script src="report.js"><\/script>/);
    for (const [path, type] of [['/report.js', /javascript/], ['/report.css', /css/]] as const) {
      const a = await send('GET', path);
      assert.equal(a.status, 200, path);
      assert.match(a.type, type);
    }

    // ── errors ──
    for (const path of ['/report', '/report.md']) {
      assert.equal((await send('GET', path)).status, 400, `${path} without project`);
      assert.equal((await send('GET', `${path}?project=nope`)).status, 404);
      assert.equal((await send('GET', `${path}?project=${wsId}&tz=Not/AZone`)).status, 400);
      assert.equal((await send('GET', `${path}?project=${wsId}&from=garbage`)).status, 400);
      assert.equal((await send('GET', `${path}?project=${wsId}&from=${dayUTC(0)}&to=${dayUTC(-3)}`)).status, 400, 'from > to');
    }
  });
});
