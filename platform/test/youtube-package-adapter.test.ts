import {
  browseYouTube,
  getAllComments,
  getCaptionTracks,
  getChannel,
  getChannelPlaylists,
  getChannelVideos,
  getComments,
  getEndscreen,
  getPlaylist,
  getTranscript,
  getVideo,
  getVideoSignals,
  getVideoWithCache,
  searchYouTube,
} from '../src/lib/youtube';
import { YouTubeProcessorError, type YouTubeOperation } from '../src/lib/youtube-processor-client';
import { YouTubeCacheCoordinatorCore } from '../src/lib/youtube-cache-coordinator';

const meta = {
  source: 'allthingsyoutube' as const,
  fetchedAt: '2026-08-07T00:00:00.000Z',
  partial: false,
  warnings: [],
};

function valueFor(operation: YouTubeOperation): unknown {
  switch (operation.kind) {
    case 'video': return { type: 'video', id: operation.id, meta };
    case 'transcript': return { videoId: operation.id, segments: [], text: '', meta };
    case 'comments': return { videoId: operation.id, comments: [], meta };
    case 'all-comments': return { videoId: operation.id, comments: [], complete: true, meta };
    case 'channel': return { type: 'channel', id: operation.id, meta };
    case 'channel-videos': return { channelId: operation.id, videos: [], meta };
    case 'channel-playlists': return { channelId: operation.id, playlists: [], meta };
    case 'playlist': return { type: 'playlist', id: operation.id, videos: [], meta };
    case 'caption-tracks': return { tracks: [], sourceTracks: [], translationLanguages: [], meta };
    case 'endscreen': return [];
    default: return { meta };
  }
}

function processorBinding(run: (operation: YouTubeOperation) => unknown | Promise<unknown>) {
  const fetch = vi.fn(async (request: Request) => {
    const operation = await request.json<YouTubeOperation>();
    try {
      return Response.json({ value: await run(operation) });
    } catch (error) {
      if (error instanceof YouTubeProcessorError) {
        return Response.json({ error: {
          code: error.code,
          message: error.message,
          status: error.status,
          retryable: error.retryable,
        } }, { status: error.code === 'NOT_FOUND' ? 404 : 503 });
      }
      throw error;
    }
  });
  return {
    binding: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch })),
    },
    fetch,
  };
}

function environment(
  run = vi.fn(async (operation: YouTubeOperation) => valueFor(operation)),
  cache: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  },
): Env {
  const processor = processorBinding(run);
  let env: Env;
  const coordinators = new Map<string, YouTubeCacheCoordinatorCore>();
  const coordinatorBinding = {
    getByName(name: string) {
      let coordinator = coordinators.get(name);
      if (!coordinator) {
        coordinator = new YouTubeCacheCoordinatorCore(env);
        coordinators.set(name, coordinator);
      }
      return {
        getOrLoad: async (requestJson: string) => JSON.stringify(
          await coordinator.getOrLoad(JSON.parse(requestJson)),
        ),
      };
    },
  };
  env = {
    YOUTUBE_CACHE: cache,
    YOUTUBE_PROCESSOR: processor.binding,
    YOUTUBE_PROCESSOR_INSTANCE_COUNT: '2',
    YOUTUBE_PROCESSOR_VERSION: 'test',
    YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '2',
    YOUTUBE_PROCESSOR_RETRY_BASE_MS: '0',
    YOUTUBE_PROCESSOR_TIMEOUT_MS: '5000',
    YOUTUBE_REQUEST_COORDINATOR: coordinatorBinding,
  } as unknown as Env;
  return env;
}

describe('platform YouTube container adapter', () => {
  test('routes every YouTube resource through the processor operation protocol', async () => {
    const run = vi.fn(async (operation: YouTubeOperation) => valueFor(operation));
    const env = environment(run);

    await searchYouTube(env, 'research', { type: 'video' });
    await browseYouTube(env, { categoryId: 'music' });
    await getVideo(env, 'abcdefghijk');
    await getVideoSignals(env, 'abcdefghijk');
    await getTranscript(env, 'abcdefghijk', 'hi');
    await getComments(env, 'abcdefghijk', 'COMMENTS_PAGE_2');
    await getAllComments(env, 'abcdefghijk');
    await getChannel(env, '@ResearchLab');
    await getChannelVideos(env, '@ResearchLab', 'VIDEOS_PAGE_2', 'popular');
    await getChannelPlaylists(env, '@ResearchLab', 'PLAYLISTS_PAGE_2', 'last-video-added');
    await getPlaylist(env, 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    await getCaptionTracks(env, 'abcdefghijk');
    await getEndscreen(env, 'abcdefghijk');

    expect(run.mock.calls.map(([operation]) => operation)).toEqual([
      { kind: 'search', query: 'research', filters: { type: 'video' } },
      { kind: 'browse', options: { categoryId: 'music', region: 'US', language: 'en' } },
      { kind: 'video', id: 'abcdefghijk' },
      { kind: 'video-signals', id: 'abcdefghijk' },
      { kind: 'transcript', id: 'abcdefghijk', lang: 'hi', granularity: 'word' },
      { kind: 'comments', id: 'abcdefghijk', continuation: 'COMMENTS_PAGE_2' },
      { kind: 'all-comments', id: 'abcdefghijk', maxPages: 100 },
      { kind: 'channel', id: '@ResearchLab' },
      { kind: 'channel-videos', id: '@ResearchLab', continuation: 'VIDEOS_PAGE_2', sort: 'popular' },
      {
        kind: 'channel-playlists', id: '@ResearchLab', continuation: 'PLAYLISTS_PAGE_2', sort: 'last-video-added',
      },
      { kind: 'playlist', id: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { kind: 'caption-tracks', id: 'abcdefghijk' },
      { kind: 'endscreen', id: 'abcdefghijk' },
    ]);
  });

  test('maps classified processor failures to the platform error contract', async () => {
    const env = environment(vi.fn(async () => {
      throw new YouTubeProcessorError('NOT_FOUND', 'Could not resolve @MissingChannel.', 404);
    }));

    await expect(getChannel(env, '@MissingChannel')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Could not resolve @MissingChannel.',
    });
  });

  test('stores misses in KV and serves expired entries when the processor is unavailable', async () => {
    const cache = {
      get: vi.fn(async () => null as unknown),
      put: vi.fn(async (_key: string, _value: string, _options?: KVNamespacePutOptions) => undefined),
    };
    const run = vi.fn(async (operation: YouTubeOperation) => valueFor(operation));
    const env = environment(run, cache);
    const miss = await getVideoWithCache(env, 'abcdefghijk');

    expect(miss.cacheStatus).toBe('miss');
    expect(cache.put).toHaveBeenCalledWith(
      expect.stringMatching(/^youtube:v1:[a-f0-9]{64}$/),
      expect.any(String),
      { expirationTtl: 604800 },
    );
    const stored = JSON.parse(cache.put.mock.calls[0]![1]) as Record<string, unknown>;
    expect(stored).toMatchObject({ version: 1, value: { id: 'abcdefghijk' } });

    const staleValue = {
      type: 'video', id: 'abcdefghijk',
      meta: { source: 'legacy', fetchedAt: '2026-08-01T00:00:00.000Z', partial: false, warnings: [] },
    };
    run.mockRejectedValue(new YouTubeProcessorError('PROCESSOR_UNAVAILABLE', 'Processor unavailable', 503, true));
    cache.get.mockResolvedValue({
      version: 1,
      value: staleValue,
      fetchedAt: Date.now() - 120_000,
      freshUntil: Date.now() - 60_000,
    });

    const stale = await getVideoWithCache(environment(run, cache), 'abcdefghijk');
    expect(stale.cacheStatus).toBe('stale');
    expect(stale.value).toMatchObject({
      id: 'abcdefghijk',
      meta: { source: 'allthingsyoutube' },
      freshness: { state: 'stale', reason: 'UPSTREAM_UNAVAILABLE' },
    });
  });

  test('does not invoke a container when Workers KV has a fresh value', async () => {
    const run = vi.fn(async (operation: YouTubeOperation) => valueFor(operation));
    const cache = {
      get: vi.fn(async () => ({
        version: 1,
        value: { type: 'video', id: 'abcdefghijk', meta },
        fetchedAt: Date.now(),
        freshUntil: Date.now() + 60_000,
      })),
      put: vi.fn(async () => undefined),
    };

    const result = await getVideoWithCache(environment(run, cache), 'abcdefghijk');

    expect(result.cacheStatus).toBe('hit');
    expect(run).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  test('treats KV outages as cache misses rather than request failures', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = {
      get: vi.fn(async () => { throw new Error('KV read unavailable'); }),
      put: vi.fn(async (_key: string, _value: string) => { throw new Error('KV write unavailable'); }),
    };

    const result = await getVideoWithCache(environment(undefined, cache), 'abcdefghijk');

    expect(result.cacheStatus).toBe('miss');
    expect(result.value.id).toBe('abcdefghijk');
    expect(warning).toHaveBeenCalledTimes(3);
    warning.mockRestore();
  });
});
