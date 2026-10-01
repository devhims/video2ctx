import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(_ctx: unknown, public env: Env) {}
  },
}));

import { YouTubeFramesContainer } from '../src/youtube-frames-container';

describe('frames container proxy environment', () => {
  it('forwards a pool-only Worker secret to the container', () => {
    const pool = JSON.stringify(['http://user:password@proxy.test:8000']);
    const container = new YouTubeFramesContainer({} as ConstructorParameters<typeof YouTubeFramesContainer>[0], {
      OUTBOUND_PROXY_URLS: pool,
    } as Env);
    expect(container.envVars.OUTBOUND_PROXY_URLS).toBe(pool);
    expect(container.envVars.OUTBOUND_PROXY_URL).toBe('');
  });

  it('preserves legacy single-proxy configuration', () => {
    const container = new YouTubeFramesContainer({} as ConstructorParameters<typeof YouTubeFramesContainer>[0], {
      OUTBOUND_PROXY_URL: ' http://proxy.test:8000 ',
    } as Env);
    expect(container.envVars.OUTBOUND_PROXY_URLS).toBe('');
    expect(container.envVars.OUTBOUND_PROXY_URL).toBe('http://proxy.test:8000');
  });
});
