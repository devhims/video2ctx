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
      type: 'channel', id: 'UCveZqqGewoyPiacooywP5Ig', name: 'Research Lab', thumbnails: [],
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
      channelId: 'UCveZqqGewoyPiacooywP5Ig', sort: 'latest', videos: [], continuation: 'NEXT_VIDEOS', meta: metadata,
    }, cacheStatus: 'hit' as const })),
    getChannelPlaylistsWithCache: vi.fn(async () => ({ value: {
      channelId: 'UCveZqqGewoyPiacooywP5Ig', sort: 'newest', playlists: [], continuation: 'NEXT_PLAYLISTS', meta: metadata,
    }, cacheStatus: 'hit' as const })),
  };
});

import { app } from '../src/index';
import { meterOperation } from '../src/lib/metering';
import { getChannelPlaylistsWithCache, getChannelVideosWithCache, getChannelWithCache } from '../src/lib/youtube';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('channel routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe.each(['', '/videos', '/playlists'])('channel endpoint %s', (suffix) => {
    test.each([
      'AltShiftX', 'UC123', 'UCveZqqGewoyPiacooywP5Igx', 'PLveZqqGewoyPiacooywP5Ig',
      '@', '@@AltShiftX', 'Alt Shift X', '@Alt:ShiftX', `@${'a'.repeat(200)}`,
    ])('rejects malformed identifier %s before billing or retrieval', async (id) => {
      const response = await app.request(`/v1/channels/${encodeURIComponent(id)}${suffix}?provider=youtube`, {}, {} as Env, executionContext);

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: {
        code: 'INVALID_ID',
        message: 'Provide a YouTube channel ID (UC followed by 22 characters) or a handle starting with @.',
        requestId: expect.any(String),
      } });
      expect(meterOperation).not.toHaveBeenCalled();
      expect(getChannelWithCache).not.toHaveBeenCalled();
      expect(getChannelVideosWithCache).not.toHaveBeenCalled();
      expect(getChannelPlaylistsWithCache).not.toHaveBeenCalled();
    });

    test.each(['@AltShiftX', '@research.lab-1_test', 'UCveZqqGewoyPiacooywP5Ig', 'UCabcdefghijklmnopqrst_-'])(
      'preserves valid identifier %s', async (id) => {
        const response = await app.request(`/v1/channels/${encodeURIComponent(id)}${suffix}?provider=youtube`, {}, {} as Env, executionContext);
        expect(response.status).toBe(200);
        const reader = suffix === '/videos' ? getChannelVideosWithCache
          : suffix === '/playlists' ? getChannelPlaylistsWithCache : getChannelWithCache;
        expect(reader).toHaveBeenCalled();
        expect(vi.mocked(reader).mock.calls[0]?.[1]).toBe(id);
      },
    );
  });

  test('returns only core metadata from the channel resource', async () => {
    const response = await app.request('/v1/channels/UCveZqqGewoyPiacooywP5Ig?provider=youtube', {}, {} as Env, executionContext);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(getChannelWithCache).toHaveBeenCalledWith(expect.anything(), 'UCveZqqGewoyPiacooywP5Ig');
    expect(body).not.toHaveProperty('videos');
    expect(body).not.toHaveProperty('playlists');
  });

  test('forwards independent continuation tokens to channel catalogs', async () => {
    const videosResponse = await app.request(
      '/v1/channels/UCveZqqGewoyPiacooywP5Ig/videos?provider=youtube&sort=popular&continuation=VIDEO_TOKEN', {}, {} as Env, executionContext,
    );
    const playlistsResponse = await app.request(
      '/v1/channels/UCveZqqGewoyPiacooywP5Ig/playlists?provider=youtube&sort=last-video-added&continuation=PLAYLIST_TOKEN', {}, {} as Env, executionContext,
    );

    expect(videosResponse.status).toBe(200);
    expect(playlistsResponse.status).toBe(200);
    expect(getChannelVideosWithCache).toHaveBeenCalledWith(expect.anything(), 'UCveZqqGewoyPiacooywP5Ig', 'VIDEO_TOKEN', 'popular');
    expect(getChannelPlaylistsWithCache).toHaveBeenCalledWith(
      expect.anything(), 'UCveZqqGewoyPiacooywP5Ig', 'PLAYLIST_TOKEN', 'last-video-added',
    );
  });

  test('rejects unsupported channel catalog sorts', async () => {
    const response = await app.request(
      '/v1/channels/UCveZqqGewoyPiacooywP5Ig/videos?provider=youtube&sort=most-liked', {}, {} as Env, executionContext,
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
