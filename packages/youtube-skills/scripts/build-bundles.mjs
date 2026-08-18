import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(skillRoot, '../..');
const bundles = [
  {
    entryPoint: resolve(skillRoot, 'src/direct/entry.ts'),
    committedBundle: resolve(repositoryRoot, '.agents/skills/youtube-direct/scripts/youtube.mjs'),
  },
  {
    entryPoint: resolve(skillRoot, 'src/watch/entry.ts'),
    committedBundle: resolve(repositoryRoot, '.agents/skills/youtube-watch/scripts/watch.mjs'),
  },
];

async function bundle(entryPoint, outfile) {
  const licenses = await Promise.all([
    ['all-things-youtube', resolve(skillRoot, '../all-things-youtube/LICENSE')],
    ['he', resolve(skillRoot, 'node_modules/he/LICENSE-MIT.txt')],
    ['striptags', resolve(skillRoot, 'node_modules/striptags/LICENSE')],
    ['undici', resolve(skillRoot, 'node_modules/undici/LICENSE')],
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
    absWorkingDir: skillRoot,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    alias: {
      'all-things-youtube': resolve(skillRoot, '../all-things-youtube/src/index.ts'),
    },
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
  try {
    for (const [index, definition] of bundles.entries()) {
      const candidate = join(temporaryDirectory, `skill-${index}.mjs`);
      await bundle(definition.entryPoint, candidate);
      const [actual, expected] = await Promise.all([
        readFile(candidate),
        readFile(definition.committedBundle).catch(() => undefined),
      ]);
      if (!expected || !actual.equals(expected)) {
        console.error(`The ${definition.committedBundle.split('/').at(-3)} skill bundle is stale.`);
        console.error(`Generated: ${digest(actual)}`);
        console.error(`Committed: ${expected ? digest(expected) : 'missing'}`);
        console.error('Run: npm --prefix packages/youtube-skills run bundle');
        process.exitCode = 1;
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function write() {
  for (const definition of bundles) {
    await mkdir(dirname(definition.committedBundle), { recursive: true });
    await bundle(definition.entryPoint, definition.committedBundle);
    await chmod(definition.committedBundle, 0o755);
    console.log(`Wrote ${definition.committedBundle}`);
  }
}

if (process.argv.includes('--check')) {
  await check();
} else {
  await write();
}
