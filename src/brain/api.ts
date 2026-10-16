// /api/* — AI Brain's routes, kept out of the kankanban daemon file. Each
// feature module registers handlers here; the daemon calls handleApi first
// for every /api/ request.
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import type { DB } from '../core/db.js';
import { currentWorkspace, setupWorkspace } from './workspace.js';

const execFileAsync = promisify(execFile);

export interface ApiCtx {
  db: () => DB;
  dbPath: () => string;
  switchDb: (path: string) => void;
  /** DB_PATH was set explicitly (tests): never move the DB. */
  explicitDb: boolean;
  broadcast: (msg: unknown) => void;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<any>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiCtx, params: Record<string, string>) => Promise<void> | void;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

/** Register a route; `:name` segments become params. */
export function on(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler });
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiCtx): Promise<boolean> {
  const method = req.method ?? 'GET';
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      await r.handler(req, res, url, ctx, params);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) ctx.json(res, status, { error: (err as Error).message });
    }
    return true;
  }
  return false;
}

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
