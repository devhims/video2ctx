import app from './app';
import { queueDigests } from './lib/digests';
import { handleQueue } from './queues';
import { reconcileMonitorSchedules } from './lib/monitor-scheduler';

export { ImportWorkflow, MonitorWorkflow } from './workflows';
export { app } from './app';
export { ContainerProxy } from '@cloudflare/containers';
export { YouTubeProcessorContainer } from './youtube-processor-container';
export { YouTubeRequestCoordinator } from './durable-objects/youtube-cache-coordinator';
export { MonitorScheduler } from './durable-objects/monitor-scheduler';

export default {
  fetch: app.fetch,
  queue: handleQueue,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') {
      await reconcileMonitorSchedules(env, controller.scheduledTime);
    } else if (controller.cron === '0 8 * * *') {
      await queueDigests(env, 'daily');
    } else if (controller.cron === '0 8 * * 1') {
      await queueDigests(env, 'weekly');
    }
  },
} satisfies ExportedHandler<Env>;
