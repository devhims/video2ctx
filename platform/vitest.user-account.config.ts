import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const watercolorLive = process.env.AGENT_WATERCOLOR_LIVE === '1';
const savedReplaysLive = process.env.AGENT_SAVED_REPLAYS_LIVE === '1';
const replayKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
if ((watercolorLive || savedReplaysLive) && !replayKey) throw new Error('Live saved-evidence replays require FIREWORKS_API_KEY.');

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: './test/user-account.wrangler.jsonc' },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, 'migrations')), TEST_VIDEO_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, 'video-catalog-migrations')),
      ...(watercolorLive ? { WATERCOLOR_LIVE: true } : {}),
      ...(savedReplaysLive ? { SAVED_REPLAYS_LIVE: true } : {}),
      ...((watercolorLive || savedReplaysLive) ? { FIREWORKS_API_KEY: replayKey! } : {}),
    } },
  }))],
  test: {
    include: ['test/saved-session-replays.integration.test.ts', 'test/session-catalog.integration.test.ts', 'test/session-owners.integration.test.ts', 'test/session-evidence.integration.test.ts', 'test/admission-queue.integration.test.ts', 'test/user-account-do.integration.test.ts', 'test/project-item-open.integration.test.ts', 'test/agent-runtime-do.integration.test.ts', 'test/agent-evidence-billing.integration.test.ts', 'test/agent-memory-updater.integration.test.ts', 'test/proxy-health-do.integration.test.ts', 'test/media-frame-capacity.integration.test.ts', 'test/frame-media-source.integration.test.ts'],
    setupFiles: ['./test/apply-auth-migrations.ts','./test/apply-video-catalog-migrations.ts'],
  },
});
