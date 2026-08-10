import { serve } from '@hono/node-server';
import { createProcessorApp } from './app.mjs';
import { createYouTubeRuntime } from './runtime.mjs';

const port = Number(process.env.PORT ?? 8080);
const app = createProcessorApp(createYouTubeRuntime(), {
  maxConcurrentOperations: process.env.MAX_CONCURRENT_OPERATIONS,
});

serve({
  fetch: app.fetch,
  hostname: '0.0.0.0',
  port: Number.isFinite(port) ? port : 8080,
}, (info) => {
  console.log(JSON.stringify({ event: 'youtube_processor_started', port: info.port }));
});
