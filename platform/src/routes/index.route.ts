import { createRouter } from '../lib/create-app';

const indexRoutes = createRouter();

indexRoutes.get('/', (c) => c.json({
  service: 'video2ctx-platform',
  version: 'v1',
  status: 'ok',
  capabilities: ['providers', 'discover', 'inspect', 'save', 'search', 'compare', 'monitor', 'synthesize'],
}));

indexRoutes.get('/health', (c) => c.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

export default indexRoutes;
