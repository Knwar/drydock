// /api/* — AI Brain's routes, kept out of the kankanban daemon file. Each
// feature module registers handlers here; the daemon calls handleApi first
// for every /api/ request.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError, on, type ApiCtx } from './router.js';
import { listProjects } from './projects.js';
import { getSetting, putSetting } from './settings.js';
import { currentWorkspace, setupWorkspace } from './workspace.js';

import './routes-chat.js';
import './routes-projects.js';
import './routes-personal.js';
import './routes-teamwork.js';
import './search.js';
import './routes-secrets.js';
import './routes-live.js';
import './routes-import.js';
import { restoreApps, startLiveWatcher } from './live.js';
import { startCheckins } from './checkins.js';
import { resumeInterruptedRuns } from './runner.js';
import { ensureSchema } from './schema.js';
import { startDailyScheduler } from './daily.js';
import { listServers } from './integrations.js';

/** Background work the daemon starts once: the Daily scheduler and the MCP server list. */
export function startBrain(db: () => import('../core/db.js').DB, schedulers = true): NodeJS.Timeout[] {
  // resume agent runs a restart cut off (after the DB schema exists)
  setTimeout(() => {
    try {
      ensureSchema(db());
      const n = resumeInterruptedRuns();
      if (n) console.log(`resumed ${n} interrupted agent run(s)`);
      void restoreApps(db());
    } catch (err) {
      console.error(`resume: ${(err as Error).message}`);
    }
  }, 1500);
  const watcher = startLiveWatcher();
  if (!schedulers) return [watcher];
  void listServers();
  return [startDailyScheduler(), startCheckins(), watcher];
}

export { handleApi } from './router.js';

const execFileAsync = promisify(execFile);
// ── workspace ──────────────────────────────────────────────────────

function workspaceView(ctx: ApiCtx) {
  const ws = currentWorkspace();
  return { configured: Boolean(ws), root: ws?.root ?? null, db: ctx.dbPath() };
}

on('GET', '/api/workspace', (_req, res, _url, ctx) => ctx.json(res, 200, workspaceView(ctx)));

on('POST', '/api/workspace', async (req, res, _url, ctx) => {
  const body = await ctx.readBody(req);
  let ws;
  try {
    ws = setupWorkspace(String(body?.path ?? ''));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  if (!ctx.explicitDb) ctx.switchDb(ws.db);
  const view = workspaceView(ctx);
  ctx.broadcast({ type: 'workspace', workspace: view });
  ctx.json(res, 200, view);
});

/** Native folder picker (macOS). The daemon is loopback-only, so this runs on the user's own Mac. */
on('POST', '/api/workspace/pick', async (_req, res, _url, ctx) => {
  if (process.platform !== 'darwin') throw new HttpError(501, 'folder picker is macOS only: type the path instead');
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose or create the folder AI Brain will work in")']);
    ctx.json(res, 200, { path: stdout.trim().replace(/\/$/, '') });
  } catch {
    ctx.json(res, 200, { path: null }); // cancelled
  }
});

// ── projects ───────────────────────────────────────────────────────

on('GET', '/api/projects', (_req, res, _url, ctx) => {
  const ws = currentWorkspace();
  ctx.json(res, 200, listProjects(ctx.db(), ws ? ws.projects : null));
});

// ── profile (kept in kankanban's settings table) ───────────────────

on('GET', '/api/profile', (_req, res, _url, ctx) => ctx.json(res, 200, getSetting(ctx.db(), 'brain.profile', { name: null })));

on('POST', '/api/profile', async (req, res, _url, ctx) => {
  const body = await ctx.readBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : null;
  putSetting(ctx.db(), 'brain.profile', { name });
  ctx.broadcast({ type: 'profile' });
  ctx.json(res, 200, { name });
});
