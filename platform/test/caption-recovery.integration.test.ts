import { createYouTubeClient } from '../../packages/all-things-youtube/src/youtube-client';
import { runYouTubeOperation } from '../src/lib/youtube-processor-client';
import { YouTubeCacheCoordinatorCore } from '../src/lib/youtube-cache-coordinator';
import { getTranscriptWithCache } from '../src/lib/youtube';
import { createYouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import type { ExtractionAttempt } from '../src/lib/extraction-diagnostics';
// The processor is a JavaScript service; exercise its real HTTP error normalization.
// @ts-expect-error No declaration file for the container's ESM application.
import { createProcessorApp } from '../youtube-processor/app.mjs';

function environment(alwaysMalformed = false) {
  const slots: string[] = [];
  const captionRequests: string[] = [];
  const retryEvents: unknown[] = [];
  const env = {
    YOUTUBE_PROCESSOR_INSTANCE_COUNT: '2', YOUTUBE_PROCESSOR_VERSION: 'caption-test',
    YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '3', YOUTUBE_PROCESSOR_RETRY_BASE_MS: '0', YOUTUBE_PROCESSOR_TIMEOUT_MS: '5000',
    YOUTUBE_CACHE: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    YOUTUBE_PROCESSOR: {
      idFromName: (name: string) => name,
      get: (id: string) => ({ fetch: async (request: Request) => {
        const malformed = alwaysMalformed || slots.length === 0;
        slots.push(id);
        const client = createYouTubeClient({ retry: { policy: { maxAttempts: 2 }, wait: async () => {}, onRetry: event => retryEvents.push(event) },
          fetch: async input => {
            const url = String(input);
            if (url.includes('/youtubei/v1/player')) return Response.json({ playabilityStatus: { status: 'OK' }, captions: {
              playerCaptionsTracklistRenderer: { captionTracks: [
                { baseUrl: malformed ? 'broken?token=secret' : 'https://captions.test/en', languageCode: 'en', vssId: '.en' },
                { baseUrl: 'https://captions.test/fr', languageCode: 'fr', vssId: '.fr' },
              ] },
            } });
            if (url.includes('/watch?')) return new Response('', { status: 404 });
            captionRequests.push(url);
            return Response.json({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Recovered' }] }] });
          } });
        const app = createProcessorApp({ run: async (operation: { id: string; lang: string }, diagnostics: { onDiagnostic: (value: unknown) => void }) => {
          try {
            const result = await client.getTranscript({ videoId: operation.id, translateTo: operation.lang });
            diagnostics.onDiagnostic({ stage: 'complete', outcome: 'success' });
            return result;
          } catch (error) {
            diagnostics.onDiagnostic({ stage: 'caption_metadata', outcome: 'error', code: (error as { code: string }).code });
            throw error;
          }
        } });
        return app.fetch(request);
      } }),
    },
  } as unknown as Env;
  const coordinator = new YouTubeCacheCoordinatorCore(env);
  env.YOUTUBE_REQUEST_COORDINATOR = { getByName: () => ({ getOrLoad: async (wire: string) => JSON.stringify(await coordinator.getOrLoad(JSON.parse(wire))) }) } as unknown as Env['YOUTUBE_REQUEST_COORDINATOR'];
  return { env, slots, captionRequests, retryEvents };
}

describe('caption recovery through processor and cache coordinator', () => {
  test('recovers on a different slot and retains safe diagnostics across the cache RPC', async () => {
    const f = environment();
    const diagnostics: ExtractionAttempt[] = [];
    const provider = createYouTubeAgentProvider(f.env);
    const result = await provider.transcript('AR1Gi3RHanE', 'en', undefined, event => diagnostics.push(event));
    expect(result.value.segments[0]?.text).toBe('Recovered');
    expect(f.slots).toHaveLength(2);
    expect(f.slots[0]).not.toBe(f.slots[1]);
    expect(f.captionRequests).toEqual(['https://captions.test/en?fmt=json3']);
    expect(diagnostics.map(d => [d.attempt, d.outcome])).toEqual([[1, 'fallback'], [2, 'success']]);
    expect(diagnostics[0]).toMatchObject({ kind: 'transcript', events: [{ stage: 'caption_metadata', code: 'INVALID_RESPONSE' }] });
    expect(JSON.stringify(diagnostics)).not.toContain('token');
    expect(JSON.stringify(diagnostics)).not.toContain('captions.test');
    expect(JSON.stringify(vi.mocked(f.env.YOUTUBE_CACHE.put).mock.calls)).not.toContain('extractionId');
    const hit = vi.fn();
    await getTranscriptWithCache(f.env, 'AR1Gi3RHanE', 'en', hit);
    expect(hit).not.toHaveBeenCalled();
    expect(f.slots).toHaveLength(2);
  });

  test('explicit refresh also retains diagnostics without using the content cache', async () => {
    const f = environment();
    const diagnostics: ExtractionAttempt[] = [];
    const result = await createYouTubeAgentProvider(f.env).transcript('AR1Gi3RHanE', 'en', { refresh: true }, event => diagnostics.push(event));
    expect(result.value.segments).toHaveLength(1);
    expect(diagnostics.map(d => d.outcome)).toEqual(['fallback', 'success']);
    expect(f.env.YOUTUBE_CACHE.get).not.toHaveBeenCalled();
    expect(f.env.YOUTUBE_CACHE.put).not.toHaveBeenCalled();
  });

  test('permanent malformed metadata stops at the configured limits and emits failure diagnostics', async () => {
    const f = environment(true);
    const diagnostics: ExtractionAttempt[] = [];
    await expect(getTranscriptWithCache(f.env, 'AR1Gi3RHanE', 'en', event => diagnostics.push(event))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(f.slots).toHaveLength(3);
    expect(f.retryEvents).toHaveLength(3); // One local retry per slot attempt, two local attempts each.
    expect(diagnostics.map(d => d.outcome)).toEqual(['fallback', 'fallback', 'failed']);
    expect(f.captionRequests).toHaveLength(0);
  });

  test('invalid video IDs remain terminal at the processor boundary', async () => {
    const f = environment();
    await expect(runYouTubeOperation(f.env, { kind: 'transcript', id: 'invalid', granularity: 'word' })).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    expect(f.slots).toHaveLength(1);
    expect(f.retryEvents).toHaveLength(0);
  });
});
