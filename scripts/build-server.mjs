// Bundles the API server (and the shared core library) into one file, dist/battleground.mjs,
// that runs with plain `node` and serves the web UI from dist/public next to it.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

await build({
  entryPoints: [join(root, 'packages/server/src/main.ts')],
  outfile: join(root, 'dist/battleground.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: false,
  sourcemap: false,
  legalComments: 'inline',
  banner: {
    // Some bundled CommonJS dependencies call require(); give them one.
    js: [
      `// Battleground ${version}: a portable, Ludus-compatible cyber range simulator.`,
      "import { createRequire as __bgCreateRequire } from 'node:module';",
      'const require = __bgCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
