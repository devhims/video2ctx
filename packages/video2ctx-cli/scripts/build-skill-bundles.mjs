import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = resolve(packageRoot, 'src/entry.ts');
const committedBundles = [
  resolve(packageRoot, '../../.agents/skills/video2ctx-api/scripts/video2ctx.mjs'),
  resolve(packageRoot, '../../.agents/skills/video2ctx-monitoring/scripts/video2ctx.mjs'),
];

async function bundle(outfile) {
  await build({
    absWorkingDir: packageRoot,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: '#!/usr/bin/env node' },
    charset: 'utf8',
    legalComments: 'eof',
    minify: false,
    sourcemap: false,
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

async function check() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'video2ctx-hosted-skills-'));
  const candidate = join(temporaryDirectory, 'video2ctx.mjs');
  try {
    await bundle(candidate);
    const generated = await readFile(candidate);
    let stale = false;
    for (const committedBundle of committedBundles) {
      const committed = await readFile(committedBundle).catch(() => undefined);
      if (!committed || !generated.equals(committed)) {
        stale = true;
        console.error(`The hosted skill bundle is stale: ${committedBundle}`);
        console.error(`Generated: ${digest(generated)}`);
        console.error(`Committed: ${committed ? digest(committed) : 'missing'}`);
      }
    }
    if (stale) {
      console.error('Run: npm --prefix packages/video2ctx-cli run skill:bundle');
      console.error('Then commit both hosted skill scripts.');
      process.exitCode = 1;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function write() {
  for (const committedBundle of committedBundles) {
    await mkdir(dirname(committedBundle), { recursive: true });
    await bundle(committedBundle);
    await chmod(committedBundle, 0o755);
    console.log(`Wrote ${committedBundle}`);
  }
}

if (process.argv.includes('--check')) await check();
else await write();
