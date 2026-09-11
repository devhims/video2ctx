import { serve } from '@hono/node-server';
import { createFrameApp } from './app.mjs';

serve({ fetch: createFrameApp().fetch, hostname: '0.0.0.0', port: 8080 });
