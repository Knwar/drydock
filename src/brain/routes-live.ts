// /api routes for apps running on this Mac and the local services they use.
import type { DB } from '../core/db.js';
import { appLogs, appStatus, checkApp, liveSettings, pauseApp, readRecipe, resumeApp, runningApps, saveRecipe, startApp, stopApp } from './live.js';
import { projectRef } from './pipeline.js';
import { HttpError, on } from './router.js';
import { SecretError } from './secrets.js';
import { backupDatabase, DEFAULT_PORT, dockerAvailable, dropProjectDatabase, getService, listServices, removeService, saveService, SERVICE_TYPES, testService } from './services.js';
import { putSetting } from './settings.js';

const STATUS: Record<SecretError['code'], number> = { not_configured: 409, locked: 423, not_found: 404, denied: 403, invalid: 400, cli: 502 };
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SecretError) throw new HttpError(STATUS[e.code], e.message, { code: e.code });
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
}

const ref = (db: DB, id: string) => {
  try {
    return projectRef(db, id);
  } catch {
    throw new HttpError(404, 'unknown project');
  }
};

// ── a project's app ───────────────────────────────────────────────

on('GET', '/api/projects/:id/live', (_q, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  ctx.json(res, 200, appStatus(ctx.db(), p.id));
});

/** Body: { approve?: string[] } — the user's Start, approving secrets the app may use. Agents send { by: 'agent' }. */
on('POST', '/api/projects/:id/live/start', async (req, res, _u, ctx, p) => {
  ref(ctx.db(), p.id);
  const b = await ctx.readBody(req);
  const by = b?.by === 'agent' ? 'agent' : 'user';
  const r = await guard(() => startApp(ctx.db(), p.id, { by, approve: by === 'user' && Array.isArray(b?.approve) ? b.approve.map(String) : undefined }));
  ctx.json(res, 200, { ...r, app: appStatus(ctx.db(), p.id) });
});

on('POST', '/api/projects/:id/live/stop', async (_q, res, _u, ctx, p) => {
  await stopApp(ctx.db(), p.id);
  ctx.json(res, 200, appStatus(ctx.db(), p.id));
});

on('POST', '/api/projects/:id/live/pause', async (_q, res, _u, ctx, p) => {
  await guard(() => pauseApp(ctx.db(), p.id));
  ctx.json(res, 200, appStatus(ctx.db(), p.id));
});

on('POST', '/api/projects/:id/live/resume', async (_q, res, _u, ctx, p) => {
  await guard(() => resumeApp(ctx.db(), p.id));
  ctx.json(res, 200, appStatus(ctx.db(), p.id));
});

on('POST', '/api/projects/:id/live/check', async (req, res, _u, ctx, p) => {
  const b = await ctx.readBody(req);
  const paths = Array.isArray(b?.paths) && b.paths.length ? b.paths.map(String) : ['/'];
  ctx.json(res, 200, await checkApp(p.id, paths, b?.service ? String(b.service) : undefined));
});

on('GET', '/api/projects/:id/live/logs', (_q, res, url, ctx, p) => {
  ctx.json(res, 200, { log: appLogs(p.id, url.searchParams.get('service') ?? undefined, Math.min(2000, Number(url.searchParams.get('lines')) || 300)) });
});

/** The developer agent's save_run_recipe: validated, then written to <project>/.drydock/run.json. */
on('POST', '/api/projects/:id/live/recipe', async (req, res, _u, ctx, p) => {
  const root = ref(ctx.db(), p.id).root;
  const b = await ctx.readBody(req);
  await guard(() => saveRecipe(root, b?.recipe));
  ctx.broadcast({ type: 'live', project_id: p.id });
  ctx.json(res, 200, { saved: true, recipe: readRecipe(root).recipe });
});

/** Reset a database Drydock made: back it up, drop it (it is recreated empty on the next start). The app confirms first. */
on('POST', '/api/projects/:id/databases/:db/reset', async (_q, res, _u, ctx, p) => {
  const db = ctx.db();
  await stopApp(db, p.id);
  const backup = await guard(() => backupDatabase(db, Number(p.db)));
  await guard(() => dropProjectDatabase(db, Number(p.db)));
  ctx.broadcast({ type: 'live', project_id: p.id });
  ctx.json(res, 200, { backup });
});

// ── all apps ──────────────────────────────────────────────────────

on('GET', '/api/live', (_q, res, _u, ctx) => ctx.json(res, 200, { apps: runningApps(), settings: liveSettings(ctx.db()) }));

on('POST', '/api/live/settings', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const s = { maxRunning: Math.min(30, Math.max(1, Number(b?.maxRunning) || 6)), idleHours: Math.min(72, Math.max(0, Number(b?.idleHours) || 0)) };
  putSetting(ctx.db(), 'brain.live', s);
  ctx.json(res, 200, s);
});

// ── local services ────────────────────────────────────────────────

on('GET', '/api/local-services', async (_q, res, _u, ctx) => {
  ctx.json(res, 200, { services: listServices(ctx.db()), types: SERVICE_TYPES, ports: DEFAULT_PORT, docker: await dockerAvailable() });
});

/** For agents: what exists, without logins. */
on('GET', '/api/local-services/names', (_q, res, _u, ctx) => {
  ctx.json(res, 200, listServices(ctx.db()).map((s) => ({ name: s.name, type: s.type, host: s.host, ok: s.check?.ok ?? null })));
});

on('POST', '/api/local-services', async (req, res, _u, ctx) => {
  const b = await ctx.readBody(req);
  const s = await guard(() => saveService(ctx.db(), { ...b, projects: Array.isArray(b?.projects) && b.projects.length ? b.projects.map(String) : null }));
  const tested = await guard(() => testService(ctx.db(), s.id));
  ctx.broadcast({ type: 'local_services' });
  ctx.json(res, 200, tested);
});

on('POST', '/api/local-services/:id/test', async (_q, res, _u, ctx, p) => {
  const s = await guard(() => testService(ctx.db(), p.id));
  ctx.broadcast({ type: 'local_services' });
  ctx.json(res, 200, s);
});

on('DELETE', '/api/local-services/:id', async (_q, res, _u, ctx, p) => {
  if (!getService(ctx.db(), p.id)) throw new HttpError(404, 'no such service');
  await guard(() => removeService(ctx.db(), p.id));
  ctx.broadcast({ type: 'local_services' });
  ctx.json(res, 200, { deleted: p.id });
});
