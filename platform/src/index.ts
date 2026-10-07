export { MediaFrameCapacity } from './durable-objects/media-frame-capacity';
export { YouTubeFramesContainer } from './youtube-frames-container';
import app from './app';
import { queueDigests } from './lib/digests';
import { handleQueue } from './queues';
import { reconcileMonitorSchedules } from './lib/monitor-scheduler';
import { backfillSessionOwners } from './lib/session-owners';
import { videoCatalog } from './lib/video-catalog';

export { ImportWorkflow, MonitorWorkflow } from './workflows';
export { app } from './app';
export { ContainerProxy } from '@cloudflare/containers';
export { YouTubeProcessorContainer } from './youtube-processor-container';
export { YouTubeRequestCoordinator } from './durable-objects/youtube-cache-coordinator';
export { MonitorScheduler } from './durable-objects/monitor-scheduler';
export { UserAccountDO } from './durable-objects/user-account';
export { ProxyHealth } from './durable-objects/proxy-health';
export { AgentRuntimeDO } from './agents/agent-runtime-do';

export default {
  fetch: app.fetch,
  queue: handleQueue,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') {
      await Promise.all([
        videoCatalog(env)?.reconcile(),
        reconcileMonitorSchedules(env, controller.scheduledTime),
        backfillSessionOwners(env).catch(() => console.error({ event: 'agent_session_owner_backfill_failed' })),
      ]);
    } else if (controller.cron === '0 8 * * *') {
      await queueDigests(env, 'daily');
    } else if (controller.cron === '0 8 * * 1') {
      await queueDigests(env, 'weekly');
    }
  },
} satisfies ExportedHandler<Env>;
