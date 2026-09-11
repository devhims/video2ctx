import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Bundle the skill's extraction implementation, with the published library external.
// Docker copies only this source subtree, never the repository's credentials or artifacts.
const source = existsSync(new URL('./skill-source/watch/workflow.ts', import.meta.url))
  ? new URL('./skill-source/watch/workflow.ts', import.meta.url)
  : new URL('../../packages/youtube-skills/src/watch/workflow.ts', import.meta.url);
await build({
  entryPoints: [fileURLToPath(source)],
  outfile: fileURLToPath(new URL('./dist/extractor.mjs', import.meta.url)),
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node22',
  format: 'esm',
});
