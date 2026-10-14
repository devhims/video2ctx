import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './test/auth/wrangler.jsonc' },
      miniflare: {
        d1Databases: { CREDIT_MIGRATION_DB: 'credit-migration-test' },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, 'migrations')),
        },
        // Checkout is the only path here that calls Polar. Answer it with a server
        // error so no test depends on the live API; pass anything else through.
        outboundService: (request: Request) => /(^|\.)polar\.sh$/.test(new URL(request.url).hostname)
          ? new Response(JSON.stringify({ error: 'TestPolarUnavailable', detail: 'Polar is stubbed in tests.' }), { status: 500, headers: { 'content-type': 'application/json' } })
          : fetch(request),
      },
    })),
  ],
  test: {
    include: [
      'test/auth-worker.integration.test.ts',
      'test/admin-access.integration.test.ts',
      'test/billing.integration.test.ts',
      'test/credits.integration.test.ts',
    ],
    setupFiles: ['./test/apply-auth-migrations.ts'],
  },
});
