const mocks = vi.hoisted(() => {
  class YouTubeClientError extends Error {
    readonly name = 'YouTubeClientError';
    readonly retryable: boolean;
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
      retryable = false,
    ) {
      super(message);
      this.retryable = retryable;
    }
  }
  const meta = {
    source: 'allthingsyoutube' as const,
    fetchedAt: '2026-08-07T00:00:00.000Z',
    partial: false,
    warnings: [],
  };
  return {
    YouTubeClientError,
    getTracks: vi.fn(async () => ({ tracks: [], sourceTracks: [], translationLanguages: [], meta })),
    getTranscript: vi.fn(async () => ({ videoId: 'abcdefghijk', segments: [], text: '', meta })),
    getComments: vi.fn(async () => ({ videoId: 'abcdefghijk', comments: [], meta })),
    getDetails: vi.fn(async () => ({ type: 'video', id: 'abcdefghijk', meta })),
    getEndscreen: vi.fn(async () => []),
    getChannelInfo: vi.fn(async () => ({ type: 'channel', id: 'UC123', meta })),
    getChannelVideos: vi.fn(async () => ({ channelId: 'UC123', videos: [], meta })),
    getChannelPlaylists: vi.fn(async () => ({ channelId: 'UC123', playlists: [], meta })),
    getPlaylist: vi.fn(async () => ({ type: 'playlist', id: 'PL123', videos: [], meta })),
    discoveryClient: {
      search: vi.fn(),
      browse: vi.fn(),
      getVideoSignals: vi.fn(),
    },
  };
});

vi.mock('all-things-youtube', () => ({
  YouTubeClientError: mocks.YouTubeClientError,
  getTracks: mocks.getTracks,
  getTranscript: mocks.getTranscript,
  getComments: mocks.getComments,
  getDetails: mocks.getDetails,
  getEndscreen: mocks.getEndscreen,
  getChannelInfo: mocks.getChannelInfo,
  getChannelVideos: mocks.getChannelVideos,
  getChannelPlaylists: mocks.getChannelPlaylists,
  getPlaylist: mocks.getPlaylist,
}));

vi.mock('../src/lib/youtube-client', () => ({
  browseDestination: vi.fn(),
  createYouTubeClient: vi.fn(() => mocks.discoveryClient),
}));

import {
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
} from '../src/lib/youtube';

function environment(): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({})),
        })),
      })),
    },
  } as unknown as Env;
}

describe('platform YouTube package adapter', () => {
  test('routes core YouTube resources through the package public interface', async () => {
    const env = environment();

    await getVideo(env, 'abcdefghijk');
    await getTranscript(env, 'abcdefghijk', 'hi');
    await getComments(env, 'abcdefghijk', 'COMMENTS_PAGE_2');
    await getAllComments(env, 'abcdefghijk');
    await getChannel(env, '@ResearchLab');
    await getChannelVideos(env, '@ResearchLab', 'VIDEOS_PAGE_2', 'popular');
    await getChannelPlaylists(env, '@ResearchLab', 'PLAYLISTS_PAGE_2', 'last-video-added');
    await getPlaylist(env, 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    await getCaptionTracks('abcdefghijk');
    await getEndscreen('abcdefghijk');

    expect(mocks.getDetails).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'abcdefghijk' }));
    expect(mocks.getTranscript).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'abcdefghijk', lang: 'hi', granularity: 'word',
    }));
    expect(mocks.getComments).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'abcdefghijk', continuation: 'COMMENTS_PAGE_2',
    }));
    expect(mocks.getComments).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'abcdefghijk', all: true, maxPages: 100,
    }));
    expect(mocks.getChannelInfo).toHaveBeenCalledWith(expect.objectContaining({
      channelId: '@ResearchLab',
    }));
    expect(mocks.getChannelVideos).toHaveBeenCalledWith(expect.objectContaining({
      channelId: '@ResearchLab', continuation: 'VIDEOS_PAGE_2', sort: 'popular',
    }));
    expect(mocks.getChannelPlaylists).toHaveBeenCalledWith(expect.objectContaining({
      channelId: '@ResearchLab', continuation: 'PLAYLISTS_PAGE_2', sort: 'last-video-added',
    }));
    expect(mocks.getPlaylist).toHaveBeenCalledWith(expect.objectContaining({
      playlistId: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    }));
    expect(mocks.getTracks).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'abcdefghijk' }));
    expect(mocks.getEndscreen).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'abcdefghijk' }));
  });

  test('maps classified package failures to the platform error contract', async () => {
    mocks.getChannelInfo.mockRejectedValueOnce(new mocks.YouTubeClientError(
      'NOT_FOUND',
      'Could not resolve @MissingChannel.',
      404,
    ));

    await expect(getChannel(environment(), '@MissingChannel')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Could not resolve @MissingChannel.',
    });
  });
});
