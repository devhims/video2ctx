import { afterEach, expect, test, vi } from 'vitest';

const containerFetch = vi.hoisted(() => vi.fn(async (_request: Request) => new Response('ok')));
vi.mock('@cloudflare/containers', () => ({ Container: class {
  constructor(public ctx: unknown, public env: Env) {}
  fetch(request: Request) { return containerFetch(request); }
} }));
import { YouTubeProcessorContainer } from '../src/youtube-processor-container';

afterEach(() => { vi.restoreAllMocks(); containerFetch.mockClear(); });

test.each([false, true])('logs actual container state before a direct request when running=%s', async running => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const ctx = { id: { toString: () => 'container-id' }, container: { running } };
  const instance = new YouTubeProcessorContainer(ctx as unknown as ConstructorParameters<typeof YouTubeProcessorContainer>[0], {} as Env);
  const request = new Request('http://processor/operations', {
    headers: { 'x-processor-egress': 'direct', 'x-extraction-id': 'extraction-id' },
  });
  await instance.fetch(request);
  expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'youtube_direct_container_state',
    containerId: 'container-id', extractionId: 'extraction-id', coldStart: !running, sleepAfter: '30m' }));
  expect(containerFetch).toHaveBeenCalledWith(request);
  instance.onStart();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('youtube_processor_started'));
});
