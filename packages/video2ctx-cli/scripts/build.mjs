import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const outfile = resolve(packageRoot, 'dist/cli.mjs');

await mkdir(dirname(outfile), { recursive: true });
await build({
  absWorkingDir: packageRoot,
  entryPoints: ['src/entry.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { __VIDEO2CTX_VERSION__: JSON.stringify(packageJson.version) },
  charset: 'utf8',
  legalComments: 'eof',
  minify: false,
  sourcemap: false,
});
await chmod(outfile, 0o755);

