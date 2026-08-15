/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
