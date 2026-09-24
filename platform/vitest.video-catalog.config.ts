import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './test/video-catalog.wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_VIDEO_MIGRATIONS: await readD1Migrations(
            resolve(import.meta.dirname, 'video-catalog-migrations'),
          ),
        },
      },
    })),
  ],
  test: { include: ['test/video-catalog.integration.test.ts'] },
});
