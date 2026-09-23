// Opt-in entrypoint for the isolated benchmark deployment. Same extraction app/library.
import { serve } from '@hono/node-server';
import { createProcessorApp } from './app.mjs';
import { createYouTubeRuntime } from './runtime.mjs';
import { measure } from './benchmark-metrics.mjs';

if (process.env.CONTAINER_BENCHMARK !== 'true') throw new Error('Benchmark entrypoint requires explicit opt-in.');
const app = createProcessorApp(createYouTubeRuntime(), { maxConcurrentOperations: 4 });
let active = 0;
serve({ hostname: '0.0.0.0', port: 8080, fetch: async request => {
  const activeAtStart = ++active;
  try {
    const { response, body, metrics } = await measure(() => app.fetch(request));
    return new Response(body, { status: response.status, headers: {
      'content-type': 'application/json', 'x-benchmark-metrics': JSON.stringify({ ...metrics, activeAtStart }),
    } });
  } finally { active--; }
} });
