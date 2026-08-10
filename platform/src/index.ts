import app from './app';
import type { MonitorPayload } from './types';
import { queueDigests } from './lib/digests';
import { handleQueue } from './queues';

export { ImportWorkflow, MonitorWorkflow } from './workflows';
export { app } from './app';
export { ContainerProxy } from '@cloudflare/containers';
export { YouTubeProcessorContainer } from './youtube-processor-container';
export { YouTubeRequestCoordinator } from './durable-objects/youtube-cache-coordinator';

export default {
  fetch: app.fetch,
  queue: handleQueue,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') {
      const params: MonitorPayload = { scheduledAt: controller.scheduledTime };
      await env.MONITOR_WORKFLOW.create({
        id: `monitor-${new Date(controller.scheduledTime).toISOString().slice(0, 13)}`,
        params,
      });
    } else if (controller.cron === '0 8 * * *') {
      await queueDigests(env, 'daily');
    } else if (controller.cron === '0 8 * * 1') {
      await queueDigests(env, 'weekly');
    }
  },
} satisfies ExportedHandler<Env>;
