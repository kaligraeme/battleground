#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './http/app';
import { USAGE, VERSION, parseCli } from './options';
import { World } from './world';

function defaultPublicDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/battleground.mjs next to dist/public. Development: the repository's dist/public.
  for (const candidate of [join(here, 'public'), resolve(here, '../../../dist/public')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2), process.env, { publicDir: defaultPublicDir() });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const { command, options } = parsed;
  if (command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (command === 'version') {
    process.stdout.write(`Battleground ${VERSION}\n`);
    return;
  }

  const world = new World({ dataDir: options.dataDir, speed: options.speed, templatesPrebuilt: options.templatesPrebuilt });

  if (command === 'reset-admin') {
    const admin = Object.values(world.state.users).find((u) => u.isAdmin);
    if (!admin) {
      console.error('No admin account exists yet. Start the server once to create one.');
      process.exit(1);
    }
    const password = options.admin.password ?? (await import('./ids')).randomPassword(16);
    await world.setPassword(admin, password);
    const apiKey = world.rotateApiKey(admin);
    world.store.flushSync();
    process.stdout.write(`Admin ${admin.userID} (${admin.email})\n  Password: ${password}\n  API key:  ${apiKey}\n`);
    return;
  }

  let firstRun: { userID: string; email: string; password: string; apiKey: string } | undefined;
  if (Object.keys(world.state.users).length === 0) {
    const created = await world.createUser({ ...options.admin, isAdmin: true });
    firstRun = { userID: created.user.userID, email: created.user.email, password: created.password, apiKey: created.apiKey };
    world.store.flushSync();
  }

  const app = createApp(world, { publicDir: options.publicDir });
  const tls = options.tls ? { key: readFileSync(options.tls.keyFile), cert: readFileSync(options.tls.certFile) } : undefined;
  const server = serve(
    tls
      ? { fetch: app.fetch, port: options.port, hostname: options.host, createServer, serverOptions: tls }
      : { fetch: app.fetch, port: options.port, hostname: options.host },
    (info) => {
      if (options.quiet) return;
      const scheme = tls ? 'https' : 'http';
      const shownHost = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;
      const url = `${scheme}://${shownHost}:${info.port}`;
      const lines = [
        '',
        `  Battleground ${VERSION} - portable cyber range simulator`,
        '',
        `  Web UI:   ${url}/ui/`,
        `  API:      ${url}/api/v2  (Ludus compatible: ludus --url ${url} ...)`,
        `  Data:     ${options.dataDir ?? '(in memory)'}`,
        `  Speed:    ${world.state.settings.speed === 0 ? 'instant' : `${world.state.settings.speed}x real time`}`,
        '',
      ];
      if (firstRun) {
        lines.push(
          '  First run: an admin account was created. Save these now; they are not shown again.',
          `    Sign in:   ${firstRun.email} (or ${firstRun.userID})`,
          `    Password:  ${firstRun.password}`,
          `    API key:   ${firstRun.apiKey}`,
          '',
          `    export LUDUS_URL=${url}`,
          `    export LUDUS_API_KEY='${firstRun.apiKey}'`,
          '',
        );
      }
      if (!options.publicDir) lines.push('  Note: the web UI is not built. Run `npm run build` to include it.', '');
      process.stdout.write(`${lines.join('\n')}\n`);
    },
  );

  const shutdown = () => {
    server.close();
    world.store.flushSync();
    void world.logs.idle().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
