vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));

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
    getChannel: vi.fn(async () => ({
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
    })),
    getChannelVideos: vi.fn(async () => ({
      channelId: 'UC123', sort: 'latest', videos: [], continuation: 'NEXT_VIDEOS', meta: metadata,
    })),
    getChannelPlaylists: vi.fn(async () => ({
      channelId: 'UC123', sort: 'newest', playlists: [], continuation: 'NEXT_PLAYLISTS', meta: metadata,
    })),
  };
});

import { app } from '../src/index';
import { getChannel, getChannelPlaylists, getChannelVideos } from '../src/lib/youtube';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('channel routes', () => {
  test('returns only core metadata from the channel resource', async () => {
    const response = await app.request('/v1/channels/UC123', {}, {} as Env, executionContext);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(getChannel).toHaveBeenCalledWith(expect.anything(), 'UC123');
    expect(body).not.toHaveProperty('videos');
    expect(body).not.toHaveProperty('playlists');
  });

  test('forwards independent continuation tokens to channel catalogs', async () => {
    const videosResponse = await app.request(
      '/v1/channels/UC123/videos?sort=popular&continuation=VIDEO_TOKEN', {}, {} as Env, executionContext,
    );
    const playlistsResponse = await app.request(
      '/v1/channels/UC123/playlists?sort=last-video-added&continuation=PLAYLIST_TOKEN', {}, {} as Env, executionContext,
    );

    expect(videosResponse.status).toBe(200);
    expect(playlistsResponse.status).toBe(200);
    expect(getChannelVideos).toHaveBeenCalledWith(expect.anything(), 'UC123', 'VIDEO_TOKEN', 'popular');
    expect(getChannelPlaylists).toHaveBeenCalledWith(
      expect.anything(), 'UC123', 'PLAYLIST_TOKEN', 'last-video-added',
    );
  });

  test('rejects unsupported channel catalog sorts', async () => {
    const response = await app.request(
      '/v1/channels/UC123/videos?sort=most-liked', {}, {} as Env, executionContext,
    );

    expect(response.status).toBe(422);
  });
});
