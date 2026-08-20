import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/auth-worker.integration.test.ts',
      'test/billing.integration.test.ts',
      'test/credits.integration.test.ts',
    ],
    setupFiles: ['./test/setup.ts'],
  },
});
