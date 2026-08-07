const mocks = vi.hoisted(() => {
  const client = {
    search: vi.fn(),
    getCaptionTracks: vi.fn(),
    getTranscript: vi.fn(),
    getComments: vi.fn(),
    getAllComments: vi.fn(),
    getVideo: vi.fn(),
    getEndscreen: vi.fn(),
    getChannel: vi.fn(),
    getChannelVideos: vi.fn(),
    getChannelPlaylists: vi.fn(),
    getPlaylist: vi.fn(),
  };
  return {
    client,
    createYouTubeClient: vi.fn(() => client),
  };
});

vi.mock('./youtube-client', () => ({
  createYouTubeClient: mocks.createYouTubeClient,
}));

import {
  getChannelInfo,
  getChannelPlaylists,
  getChannelVideos,
  getComments,
  getDetails,
  getEndscreen,
  getPlaylist,
  getTracks,
  getTranscript,
} from './index';
import * as publicApi from './index';

describe('all-things-youtube public API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('exports the documented functions', () => {
    for (const exported of [
      getTracks,
      getTranscript,
      getComments,
      getDetails,
      getEndscreen,
      getChannelInfo,
      getChannelVideos,
      getChannelPlaylists,
      getPlaylist,
    ]) {
      expect(typeof exported).toBe('function');
    }
    expect(publicApi).not.toHaveProperty('createYouTubeClient');
  });

  test('maps the video helpers to the normalized client', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    mocks.client.getCaptionTracks.mockResolvedValue({ tracks: [] });
    mocks.client.getTranscript.mockResolvedValue({ segments: [] });
    mocks.client.getVideo.mockResolvedValue({ id: 'abcdefghijk' });
    mocks.client.getEndscreen.mockResolvedValue([]);

    await getTracks({ videoId: 'abcdefghijk', fetch: fetchMock });
    await getTranscript({ videoId: 'abcdefghijk', lang: 'hi', granularity: 'word' });
    await getDetails({ videoId: 'abcdefghijk' });
    await getEndscreen({ videoId: 'abcdefghijk' });

    expect(mocks.createYouTubeClient).toHaveBeenCalledWith(expect.objectContaining({ fetch: fetchMock }));
    expect(mocks.client.getCaptionTracks).toHaveBeenCalledWith('abcdefghijk');
    expect(mocks.client.getTranscript).toHaveBeenCalledWith({
      videoId: 'abcdefghijk', translateTo: 'hi', granularity: 'word',
    });
    expect(mocks.client.getVideo).toHaveBeenCalledWith('abcdefghijk');
    expect(mocks.client.getEndscreen).toHaveBeenCalledWith('abcdefghijk');
  });

  test('keeps comment continuation internals out of the public result', async () => {
    mocks.client.getComments.mockResolvedValue({
      videoId: 'abcdefghijk', comments: [], replyContinuations: ['internal'],
      newestContinuation: 'internal-newest', continuation: 'NEXT', meta: {},
    });
    mocks.client.getAllComments.mockResolvedValue({
      videoId: 'abcdefghijk', comments: [], replyContinuations: ['internal'],
      complete: true, pagesFetched: 2, topLevelCount: 1, replyCount: 0,
      remainingContinuations: 0, meta: {},
    });

    const page = await getComments({ videoId: 'abcdefghijk', continuation: 'CURRENT' });
    const collection = await getComments({ videoId: 'abcdefghijk', all: true, maxPages: 10 });

    expect(mocks.client.getComments).toHaveBeenCalledWith({
      videoId: 'abcdefghijk', continuation: 'CURRENT',
    });
    expect(mocks.client.getAllComments).toHaveBeenCalledWith({
      videoId: 'abcdefghijk', maxPages: 10,
    });
    expect(page).not.toHaveProperty('replyContinuations');
    expect(page).not.toHaveProperty('newestContinuation');
    expect(collection).not.toHaveProperty('replyContinuations');
  });

  test('resolves handles and forwards channel catalog pagination and sorting', async () => {
    mocks.client.search.mockResolvedValue({ channels: [{ id: 'UC123' }] });
    mocks.client.getChannel.mockResolvedValue({ id: 'UC123' });
    mocks.client.getChannelVideos.mockResolvedValue({ videos: [] });
    mocks.client.getChannelPlaylists.mockResolvedValue({ playlists: [] });

    await getChannelInfo({ channelId: '@ResearchLab' });
    await getChannelVideos({
      channelId: '@ResearchLab', continuation: 'VIDEO_NEXT', sort: 'popular',
    });
    await getChannelPlaylists({
      channelId: '@ResearchLab', continuation: 'PLAYLIST_NEXT', sort: 'last-video-added',
    });

    expect(mocks.client.search).toHaveBeenCalledWith('@ResearchLab', { type: 'channel' });
    expect(mocks.client.getChannel).toHaveBeenCalledWith('UC123');
    expect(mocks.client.getChannelVideos).toHaveBeenCalledWith('UC123', 'VIDEO_NEXT', 'popular');
    expect(mocks.client.getChannelPlaylists).toHaveBeenCalledWith(
      'UC123', 'PLAYLIST_NEXT', 'last-video-added',
    );
  });

  test('returns a typed not-found error when a channel handle cannot be resolved', async () => {
    mocks.client.search.mockResolvedValue({ channels: [] });

    await expect(getChannelInfo({ channelId: '@MissingChannel' })).rejects.toMatchObject({
      name: 'YouTubeClientError',
      code: 'NOT_FOUND',
      status: 404,
      retryable: false,
    });
  });

  test('rejects unsupported channel sorts at runtime', async () => {
    await expect(getChannelVideos({
      channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
      sort: 'bogus' as never,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(getChannelPlaylists({
      channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
      sort: '' as never,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(mocks.client.getChannelVideos).not.toHaveBeenCalled();
    expect(mocks.client.getChannelPlaylists).not.toHaveBeenCalled();
  });

  test('forwards playlist continuation', async () => {
    mocks.client.getPlaylist.mockResolvedValue({ videos: [] });

    const playlistId = 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    await getPlaylist({ playlistId, continuation: 'PLAYLIST_PAGE_2' });

    expect(mocks.client.getPlaylist).toHaveBeenCalledWith(playlistId, 'PLAYLIST_PAGE_2');
  });

  test('rejects malformed playlist ids before making a request', async () => {
    await expect(getPlaylist({ playlistId: 'PLnope_zzz_99887766' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(mocks.client.getPlaylist).not.toHaveBeenCalled();
  });
});
