/**
 * Lumenfall game server: serves the built browser client and runs the lobby and dungeon
 * simulations over a WebSocket at /ws.
 *
 *   node dist/server.mjs [--port 8787] [--host 127.0.0.1] [--quick]
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_RATE } from '../shared/constants.js';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import { cleanName, Lobby, type LobbyOptions } from './lobby.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const port = Number(arg('port') ?? process.env.PORT ?? 8787);
const host = arg('host') ?? process.env.HOST ?? '127.0.0.1';
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(arg('public') ?? join(here, 'public'));

const lobbyOpts: LobbyOptions = {
  instance: {
    // --quick makes monsters frail, for trying things out and for browser tests.
    ...(flag('quick') ? { enemyHp: 0.25 } : {}),
    ...(arg('countdown') !== undefined ? { countdown: Number(arg('countdown')) } : {}),
  },
};
const lobby = new Lobby(lobbyOpts);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: lobby.players.size, instances: lobby.instances.size }));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target);
    const cache = target.includes(`${join(publicDir, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': cache });
    res.end(body);
  } catch {
    // Unknown paths fall back to the app shell.
    try {
      const body = await readFile(join(publicDir, 'index.html'));
      res.writeHead(200, { 'content-type': TYPES['.html'] as string });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('The client is not built. Run `npm run build`, or use `npm run dev` during development.');
    }
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws: WebSocket) => {
  let playerId: string | null = null;
  const conn = {
    send(msg: ServerMsg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (msg.t === 'hello') {
      if (playerId) return;
      const name = cleanName(msg.name);
      if (!name) {
        conn.send({ t: 'error', message: 'Pick a name of 2 to 16 characters.' });
        return;
      }
      playerId = lobby.connect(conn, name, typeof msg.token === 'string' ? msg.token : undefined);
      return;
    }
    if (playerId) lobby.handle(playerId, msg);
  });
  ws.on('close', () => {
    if (playerId) lobby.disconnect(playerId, Date.now(), conn);
  });
});

// Fixed-step simulation loop that catches up if the timer runs late.
const stepMs = 1000 / TICK_RATE;
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += now - last;
  last = now;
  let steps = 0;
  while (acc >= stepMs && steps < 5) {
    lobby.tick();
    acc -= stepMs;
    steps++;
  }
  if (steps === 5) acc = 0;
}, stepMs / 2);

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`Lumenfall server running at http://${shown}:${port}/`);
  if (host === '127.0.0.1') console.log('Only this machine can connect. Start with --host 0.0.0.0 to let friends on your network join.');
});
