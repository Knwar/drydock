// Serves the built React app (dist/web) at /app, with SPA fallback to index.html.
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

export async function serveApp(res: ServerResponse, pathname: string): Promise<void> {
  const rel = normalize(pathname.replace(/^\/app\/?/, '')).replace(/^(\.\.(\/|$))+/, '');
  const file = join(WEB_DIR, rel);
  const send = async (path: string, cache: boolean) => {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'cache-control': cache ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  };
  try {
    if (rel && rel !== '.' && file.startsWith(WEB_DIR + '/') && extname(rel)) return await send(file, rel.startsWith('assets/'));
    await send(join(WEB_DIR, 'index.html'), false);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Drydock web app not built — run: npm run build:web');
  }
}
