import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bgRoutes, publicBgRoutes } from '../routes/bg';
import { ludusRoutes, versionBody } from '../routes/ludus';
import { pocketbaseRoutes } from '../routes/pocketbase';
import type { World } from '../world';
import { type Env, authenticate } from './context';
import { ApiError } from './errors';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const UI_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const NO_UI = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Battleground</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1b2230}code{background:#eef1f5;padding:.1em .35em;border-radius:4px}</style></head>
<body><h1>Battleground is running</h1><p>The API is available at <code>/api/v2</code>, but the web UI has not been built.</p><p>Build it with <code>npm run build</code> and restart the server.</p></body></html>`;

/** Serves the built web UI from `root`, falling back to `index.html`. */
function serveUi(root: string | null) {
  const base = root ? resolve(root) : null;
  return (path: string): Response => {
    if (!base || !existsSync(join(base, 'index.html'))) {
      return new Response(NO_UI, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...UI_HEADERS } });
    }
    const relative = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    let file = resolve(base, relative);
    if (file !== base && !file.startsWith(base + sep)) file = join(base, 'index.html');
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(base, 'index.html');
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return new Response(readFileSync(file), { headers: { 'Content-Type': type, 'Cache-Control': cache, ...UI_HEADERS } });
  };
}

export function createApp(world: World, options: { publicDir: string | null }): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json((err.body as object | undefined) ?? { error: err.message }, err.status);
    if (err instanceof HTTPException) return c.json({ error: err.message || 'Bad request' }, err.status);
    console.error('[battleground] Unhandled error:', err);
    return c.json({ error: `Internal server error: ${err instanceof Error ? err.message : String(err)}` }, 500);
  });

  app.get('/', (c) => c.redirect('/ui/', 307));
  app.get('/ui', (c) => c.redirect('/ui/', 301));
  const ui = serveUi(options.publicDir);
  app.get('/ui/*', (c) => ui(c.req.path.slice('/ui/'.length)));

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.route('/api/bg', publicBgRoutes(world));
  for (const prefix of ['/api/v2', '/api/bg', '/api/collections']) app.use(`${prefix}/*`, authenticate(world));
  app.use('/api/v2', authenticate(world));
  // `ludus version` asks for /api/v2/ (with the slash); routes mounted at '/' only match /api/v2.
  app.get('/api/v2/', (c) => c.json(versionBody()));
  app.route('/api/v2', ludusRoutes(world));
  app.route('/api/bg', bgRoutes(world));
  app.route('/api/collections', pocketbaseRoutes(world));

  app.notFound((c) => {
    // Matches the shape of a Ludus server's catch-all 404 for non-GET requests.
    if (c.req.path.startsWith('/api/')) return c.json({ data: {}, message: "The requested resource wasn't found.", status: 404 }, 404);
    return c.json({ error: 'not found' }, 404);
  });

  return app;
}
