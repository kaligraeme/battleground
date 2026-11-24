// Bundles the game server into a single file, dist/server.mjs, next to the built client in dist/public.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
