import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = resolve(packageRoot, 'skill/entry.ts');
const committedBundle = resolve(
  packageRoot,
  '../../.agents/skills/youtube-direct/scripts/youtube.mjs',
);

async function bundle(outfile) {
  const licenses = await Promise.all([
    ['all-things-youtube', resolve(packageRoot, 'LICENSE')],
    ['he', resolve(packageRoot, 'node_modules/he/LICENSE-MIT.txt')],
    ['striptags', resolve(packageRoot, 'node_modules/striptags/LICENSE')],
    ['undici', resolve(packageRoot, 'node_modules/undici/LICENSE')],
  ].map(async ([name, path]) => {
    const notice = `${name}\n${await readFile(path, 'utf8')}`;
    return notice.replaceAll('*/', '* /');
  }));
  const licenseFooter = [
    '/* Bundled license notices',
    '',
    licenses.join('\n---\n'),
    '*/',
  ].join('\n');

  await build({
    absWorkingDir: packageRoot,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node18.17',
    format: 'esm',
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __createRequire } from 'node:module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
    footer: { js: licenseFooter },
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
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'all-things-youtube-skill-'));
  const candidate = join(temporaryDirectory, 'youtube.mjs');
  try {
    await bundle(candidate);
    const [actual, expected] = await Promise.all([
      readFile(candidate),
      readFile(committedBundle).catch(() => undefined),
    ]);
    if (!expected || !actual.equals(expected)) {
      console.error('The youtube-direct skill bundle is stale.');
      console.error(`Generated: ${digest(actual)}`);
      console.error(`Committed: ${expected ? digest(expected) : 'missing'}`);
      console.error('Run: npm --prefix packages/all-things-youtube run skill:bundle');
      console.error('Then commit .agents/skills/youtube-direct/scripts/youtube.mjs');
      process.exitCode = 1;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function write() {
  await mkdir(dirname(committedBundle), { recursive: true });
  await bundle(committedBundle);
  await chmod(committedBundle, 0o755);
  console.log(`Wrote ${committedBundle}`);
}

if (process.argv.includes('--check')) {
  await check();
} else {
  await write();
}
