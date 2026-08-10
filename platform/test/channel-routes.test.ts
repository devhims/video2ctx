vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));

vi.mock('../src/middlewares/authentication', () => routeAuthenticationMock());
vi.mock('../src/lib/metering', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/metering')>(),
  meterOperation: vi.fn(async (_c, _options, work) => (await work()).value),
}));

vi.mock('../src/lib/youtube', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/youtube')>();
  const metadata = {
    source: 'allthingsyoutube' as const,
    fetchedAt: '2026-08-07T00:00:00.000Z',
    partial: false,
    warnings: [],
  };
  return {
    ...original,
    getChannelWithCache: vi.fn(async () => ({ value: {
      type: 'channel', id: 'UC123', name: 'Research Lab', thumbnails: [],
      url: 'https://www.youtube.com/@ResearchLab',
      about: {
        description: 'Evidence-first videos.',
        links: [],
        moreInfo: {
          canonicalChannelUrl: 'https://www.youtube.com/@ResearchLab',
          businessEmailAvailable: false,
        },
      },
      meta: metadata,
    }, cacheStatus: 'hit' as const })),
    getChannelVideosWithCache: vi.fn(async () => ({ value: {
      channelId: 'UC123', sort: 'latest', videos: [], continuation: 'NEXT_VIDEOS', meta: metadata,
    }, cacheStatus: 'hit' as const })),
    getChannelPlaylistsWithCache: vi.fn(async () => ({ value: {
      channelId: 'UC123', sort: 'newest', playlists: [], continuation: 'NEXT_PLAYLISTS', meta: metadata,
    }, cacheStatus: 'hit' as const })),
  };
});

import { app } from '../src/index';
import { getChannelPlaylistsWithCache, getChannelVideosWithCache, getChannelWithCache } from '../src/lib/youtube';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('channel routes', () => {
  test('returns only core metadata from the channel resource', async () => {
    const response = await app.request('/v1/providers/youtube/channels/UC123', {}, {} as Env, executionContext);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(getChannelWithCache).toHaveBeenCalledWith(expect.anything(), 'UC123');
    expect(body).not.toHaveProperty('videos');
    expect(body).not.toHaveProperty('playlists');
  });

  test('forwards independent continuation tokens to channel catalogs', async () => {
    const videosResponse = await app.request(
      '/v1/providers/youtube/channels/UC123/videos?sort=popular&continuation=VIDEO_TOKEN', {}, {} as Env, executionContext,
    );
    const playlistsResponse = await app.request(
      '/v1/providers/youtube/channels/UC123/playlists?sort=last-video-added&continuation=PLAYLIST_TOKEN', {}, {} as Env, executionContext,
    );

    expect(videosResponse.status).toBe(200);
    expect(playlistsResponse.status).toBe(200);
    expect(getChannelVideosWithCache).toHaveBeenCalledWith(expect.anything(), 'UC123', 'VIDEO_TOKEN', 'popular');
    expect(getChannelPlaylistsWithCache).toHaveBeenCalledWith(
      expect.anything(), 'UC123', 'PLAYLIST_TOKEN', 'last-video-added',
    );
  });

  test('rejects unsupported channel catalog sorts', async () => {
    const response = await app.request(
      '/v1/providers/youtube/channels/UC123/videos?sort=most-liked', {}, {} as Env, executionContext,
    );

    expect(response.status).toBe(422);
  });
});

function routeAuthenticationMock() {
  const user = { id: 'test-user', email: 'test@example.com', name: 'Test User' };
  const principal = { user, method: 'session' as const, permissions: {} };
  return {
    establishPrincipal: async (c: any, next: () => Promise<void>) => {
      c.set('principal', principal); c.set('user', user); await next();
    },
    requireAccountPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requireDataPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requireSessionPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requirePrincipal: () => principal,
    requireUser: () => user,
  };
}
