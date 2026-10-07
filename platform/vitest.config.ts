import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: ['test/landing-samples.integration.test.ts', 'test/session-catalog.integration.test.ts', 'test/session-owners.integration.test.ts', 'test/video-catalog.integration.test.ts', 'test/session-evidence.integration.test.ts', 'test/admission-queue.integration.test.ts',
      'test/auth-worker.integration.test.ts',
      'test/admin-access.integration.test.ts',
      'test/billing.integration.test.ts',
      'test/credits.integration.test.ts',
      'test/user-account-do.integration.test.ts',
      'test/project-item-open.integration.test.ts',
      'test/agent-runtime-do.integration.test.ts', 'test/agent-evidence-billing.integration.test.ts',
      'test/agent-memory-updater.integration.test.ts',
      'test/proxy-health-do.integration.test.ts', 'test/media-frame-capacity.integration.test.ts', 'test/frame-media-source.integration.test.ts',
    ],
    setupFiles: ['./test/setup.ts'],
  },
});
