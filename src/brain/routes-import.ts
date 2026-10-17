// /api routes for importing existing projects (see importer.ts).
import { candidates, checkSource, cloneIn, copyIn, importProject, inspect, snapshot } from './importer.js';
import { isType } from './plugins.js';
import { HttpError, on } from './router.js';
import { currentWorkspace } from './workspace.js';
import { join, resolve } from 'node:path';

const fail = (e: unknown) => new HttpError(400, (e as Error).message);

/** Folders in projects/ that are not AI Brain projects yet. */
on('GET', '/api/import/candidates', (_q, res, _u, ctx) => {
  try {
    ctx.json(res, 200, { candidates: candidates(ctx.db()) });
  } catch (e) {
    throw fail(e);
  }
});

/** What a folder holds and what in it could run: { dir } inside projects/, or { path } elsewhere on this Mac. */
on('POST', '/api/import/inspect', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  try {
    const ws = currentWorkspace();
    if (!ws) throw new Error('set up a workspace first');
    const dir = b?.path ? checkSource(String(b.path)) : resolve(ws.projects, String(b?.dir ?? ''));
    if (!b?.path && !dir.startsWith(join(ws.projects, '/'))) throw new Error('choose a folder inside projects/');
    ctx.json(res, 200, await inspect(ctx.db(), dir));
  } catch (e) {
    throw fail(e);
  }
});

/** Copy a folder from elsewhere on this Mac into projects/ (the user confirmed the size). */
on('POST', '/api/import/copy', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  try {
    const dir = copyIn(String(b?.path ?? ''), String(b?.name ?? ''));
    ctx.json(res, 200, await inspect(ctx.db(), dir));
  } catch (e) {
    throw fail(e);
  }
});

/** Clone a git repository into projects/. */
on('POST', '/api/import/clone', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  try {
    const dir = await cloneIn(String(b?.url ?? '').trim(), String(b?.name ?? ''));
    ctx.json(res, 200, await inspect(ctx.db(), dir));
  } catch (e) {
    throw fail(e);
  }
});

/** Commit uncommitted changes as a snapshot (the user confirmed). */
on('POST', '/api/import/snapshot', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  try {
    await snapshot(String(b?.dir ?? ''));
    const ws = currentWorkspace()!;
    ctx.json(res, 200, await inspect(ctx.db(), resolve(ws.projects, String(b.dir))));
  } catch (e) {
    throw fail(e);
  }
});

/** Import: { dir, type, name?, trust } — trust keeps the project's own Claude settings and MCP servers. */
on('POST', '/api/import', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  try {
    const r = await importProject(ctx.db(), String(b?.dir ?? ''), { type: isType(b?.type) ? b.type : 'software', name: b?.name ? String(b.name) : undefined, trust: b?.trust === true });
    ctx.broadcast({ type: 'workspace' });
    ctx.json(res, 200, { id: r.ref.id, channel: r.channel, quarantined: r.quarantined });
  } catch (e) {
    throw fail(e);
  }
});
