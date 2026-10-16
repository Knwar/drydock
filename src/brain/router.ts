// Tiny /api router: feature modules register routes with on(); the daemon
// calls handleApi for every /api/ request.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from '../core/db.js';
import { ensureSchema } from './schema.js';

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
  ensureSchema(ctx.db());
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

