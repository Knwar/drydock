// /api routes for the project pipeline: create, requirements, design, gates, files.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as board from '../core/board.js';
import { listDecisions } from './chat.js';
import {
  createProject,
  designChanged,
  finalizeDesign,
  finalizeRequirements,
  getDesign,
  listRequirements,
  projectRef,
  removeDesignItem,
  reopenRequirements,
  saveRequirements,
  startBuilding,
  upsertElement,
  upsertRelation,
} from './pipeline.js';
import { listProjects } from './projects.js';
import { HttpError, on } from './router.js';
import { activeRuns } from './runner.js';
import { currentWorkspace, isInside } from './workspace.js';

const ref = (db: any, id: string) => {
  try {
    return projectRef(db, id);
  } catch {
    throw new HttpError(404, 'unknown project');
  }
};
const bad = (err: unknown) => new HttpError(400, (err as Error).message);

on('POST', '/api/projects', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  if (!b?.name) throw new HttpError(400, 'name required');
  try {
    const p = await createProject(ctx.db(), String(b.name), String(b.description ?? ''));
    ctx.json(res, 200, p);
  } catch (err) {
    throw bad(err);
  }
});

on('GET', '/api/projects/:id', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  const r = ref(db, p.id);
  const summary = listProjects(db, null).find((s) => s.id === p.id);
  const phases = board.getPhases(db, p.id);
  const channels = db.prepare(`SELECT id, name FROM conversations WHERE project_id = ? ORDER BY created_at`).all(p.id);
  ctx.json(res, 200, { ...summary, ...r, phases, channels, decisions: listDecisions(db, p.id, 20) });
});

// ── requirements ──

on('GET', '/api/projects/:id/requirements', (_q, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  ctx.json(res, 200, listRequirements(ctx.db(), p.id));
});

on('POST', '/api/projects/:id/requirements', async (req, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  if (typeof b?.markdown !== 'string' || !b.markdown.trim()) throw new HttpError(400, 'markdown required');
  try {
    ctx.json(res, 200, saveRequirements(ctx.db(), p.id, b.markdown, b.author ?? 'user'));
  } catch (err) {
    throw bad(err);
  }
});

on('POST', '/api/projects/:id/requirements/final', (_q, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  try {
    ctx.json(res, 200, { channel: finalizeRequirements(ctx.db(), p.id) });
  } catch (err) {
    throw bad(err);
  }
});

on('POST', '/api/projects/:id/requirements/reopen', (_q, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  reopenRequirements(ctx.db(), p.id);
  ctx.json(res, 200, { ok: true });
});

// ── design ──

on('GET', '/api/projects/:id/design', (_q, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  ctx.json(res, 200, getDesign(ctx.db(), p.id));
});

on('POST', '/api/projects/:id/design/elements', async (req, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  try {
    upsertElement(ctx.db(), p.id, b);
  } catch (err) {
    throw bad(err);
  }
  designChanged(ctx.db(), p.id);
  ctx.json(res, 200, getDesign(ctx.db(), p.id));
});

on('POST', '/api/projects/:id/design/relations', async (req, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  try {
    upsertRelation(ctx.db(), p.id, b);
  } catch (err) {
    throw bad(err);
  }
  designChanged(ctx.db(), p.id);
  ctx.json(res, 200, getDesign(ctx.db(), p.id));
});

on('DELETE', '/api/projects/:id/design/:item', (_q, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  removeDesignItem(ctx.db(), p.id, p.item);
  designChanged(ctx.db(), p.id);
  ctx.json(res, 200, getDesign(ctx.db(), p.id));
});

on('POST', '/api/projects/:id/design/final', async (_q, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  try {
    ctx.json(res, 200, { channel: await finalizeDesign(ctx.db(), p.id) });
  } catch (err) {
    throw bad(err);
  }
});

on('POST', '/api/projects/:id/start', (_q, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  if (!board.getPhases(ctx.db(), p.id).length) throw new HttpError(400, 'no phases yet: wait for the PM to propose the roadmap');
  ctx.json(res, 200, { channel: startBuilding(ctx.db(), p.id) });
});

// ── live agents for a project ──

on('GET', '/api/projects/:id/agents', (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  ref(db, p.id);
  const convs = new Set((db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(p.id) as { id: string }[]).map((r) => r.id));
  const runs = activeRuns().filter((r) => convs.has(r.conversation));
  const ids = [p.id, ...(db.prepare('SELECT id FROM projects WHERE parent_id = ?').all(p.id) as { id: string }[]).map((r) => r.id)];
  const cards = db
    .prepare(`SELECT id, title, lane, assigned_agent, project_id, subtasks FROM tasks WHERE project_id IN (${ids.map(() => '?').join(',')}) AND lane IN ('in_progress', 'in_review') ORDER BY updated_at DESC`)
    .all(...ids);
  const recent = db
    .prepare(`SELECT conversation_id, author, body, created_at FROM messages WHERE kind = 'tool' AND conversation_id IN (${[...convs].map(() => '?').join(',') || "''"}) ORDER BY id DESC LIMIT 40`)
    .all(...convs);
  ctx.json(res, 200, { runs, cards, recent });
});

// ── files (vault folder + project folder), read-only, never outside the workspace ──

on('GET', '/api/files', (_q, res, url, ctx) => {
  const ws = currentWorkspace();
  if (!ws) throw new HttpError(400, 'no workspace');
  const target = resolve(ws.root, url.searchParams.get('path') ?? '');
  if (!isInside(ws.root, target) || !existsSync(target)) throw new HttpError(404, 'not found');
  const st = statSync(target);
  if (st.isDirectory()) {
    const entries = readdirSync(target, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => ({ name: e.name, dir: e.isDirectory(), path: relative(ws.root, join(target, e.name)) }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return ctx.json(res, 200, { kind: 'dir', path: relative(ws.root, target), entries });
  }
  if (st.size > 1_000_000) throw new HttpError(413, 'file too large to preview');
  ctx.json(res, 200, { kind: 'file', path: relative(ws.root, target), content: readFileSync(target, 'utf8'), modified: st.mtimeMs });
});
