import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './test/auth/wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, 'migrations')),
        },
      },
    })),
  ],
  test: {
    include: [
      'test/auth-worker.integration.test.ts',
      'test/billing.integration.test.ts',
      'test/credits.integration.test.ts',
    ],
    setupFiles: ['./test/apply-auth-migrations.ts'],
  },
});
