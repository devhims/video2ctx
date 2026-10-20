import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
const vars = process.env.AGENT_REPLAY_ENV_FILE ? parseEnv(readFileSync(process.env.AGENT_REPLAY_ENV_FILE, 'utf8')) : process.env;
export default defineConfig({ test: { root: import.meta.dirname, environment: 'node', globals: true,
  include: ['visual-inspection.live.test.ts'], setupFiles: [resolve(import.meta.dirname, '../../test/setup.ts')],
  testTimeout: 900_000, env: { FIREWORKS_API_KEY: vars.FIREWORKS_API_KEY ?? vars.FIREWORKS_API_KEY_1 ?? '' } } });
