import { createYouTubeClient } from '../src/lib/youtube-client';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function htmlResponse(data: unknown): Response {
  return new Response(`<!doctype html><script>var ytInitialData = ${JSON.stringify(data)};</script>`, {
    headers: { 'content-type': 'text/html' },
  });
}

describe('normalized YouTube client', () => {
  test('preserves the client locale on browse-backed requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        context: { client: { hl: string; gl: string } };
      };
      expect(payload.context.client).toMatchObject({ hl: 'de', gl: 'DE' });
      return response({
        contents: [{ lockupViewModel: {
          contentId: 'abcdefghijk',
          contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          contentImage: { thumbnailViewModel: { image: { sources: [] } } },
          metadata: { lockupMetadataViewModel: {
            title: { content: 'Ein lokalisiertes Video' },
            metadata: { contentMetadataViewModel: { metadataRows: [
              { metadataParts: [{ text: { content: 'Ein Kanal' } }] },
              { metadataParts: [
                { text: { content: '44 Mio. Aufrufe' } },
                { text: { content: 'vor 12 Tagen' } },
              ] },
            ] } },
          } },
        } }],
      });
    });

    const playlist = await createYouTubeClient({
      fetch: fetchMock as typeof fetch,
      language: 'de',
      region: 'DE',
    }).getPlaylist('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(playlist.videos[0]).toMatchObject({
      publishedTimeText: 'vor 12 Tagen',
      viewCountText: '44 Mio. Aufrufe',
      viewCount: 44_000_000,
    });
  });

  test('normalizes modern playlist metadata and omits an exhausted continuation', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({
      header: { pageHeaderRenderer: {
        pageTitle: 'Modern research playlist',
        content: { pageHeaderViewModel: { metadata: { contentMetadataViewModel: {
          metadataRows: [
            { metadataParts: [{ avatarStack: { avatarStackViewModel: { text: {
              content: 'by Playlist Owner',
              commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCOWNER' } } } }],
            } } } }] },
            { metadataParts: [
              { text: { content: 'Playlist' } },
              { text: { content: '1 video' } },
              { text: { content: '42 views' } },
            ] },
          ],
        } } } },
      } },
      metadata: { playlistMetadataRenderer: {
        title: 'Modern research playlist',
        description: 'A modern playlist response fixture.',
      } },
      sidebar: { playlistSidebarRenderer: { items: [
        { playlistSidebarPrimaryInfoRenderer: {
          title: { simpleText: 'Modern research playlist' },
          description: { simpleText: 'A modern playlist response fixture.' },
          stats: [{ runs: [{ text: '1' }, { text: ' video' }] }],
          thumbnailRenderer: { playlistVideoThumbnailRenderer: { thumbnail: { thumbnails: [
            { url: 'https://img.test/playlist-cover.jpg', width: 480, height: 270 },
          ] } } },
        } },
        { playlistSidebarSecondaryInfoRenderer: { videoOwner: { videoOwnerRenderer: {
          title: { runs: [{
            text: 'Playlist Owner',
            navigationEndpoint: { browseEndpoint: { browseId: 'UCOWNER' } },
          }] },
          navigationEndpoint: { browseEndpoint: { browseId: 'UCOWNER' } },
        } } } },
      ] } },
      contents: [
        { lockupViewModel: {
          contentId: 'abcdefghijk',
          contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          contentImage: { thumbnailViewModel: {
            image: { sources: [{ url: 'https://img.test/video.jpg', width: 336, height: 188 }] },
            overlays: [{ thumbnailBottomOverlayViewModel: { badges: [
              { thumbnailBadgeViewModel: { text: '12:30' } },
            ] } }],
          } },
          metadata: { lockupMetadataViewModel: {
            title: { content: 'Modern playlist video' },
            metadata: { contentMetadataViewModel: { metadataRows: [
              { metadataParts: [{ text: {
                content: 'Video Creator',
                commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCVIDEO' } } } }],
              } }] },
              { metadataParts: [
                { text: { content: '12K views' } },
                { text: { content: '2 days ago' } },
              ] },
            ] } },
          } },
        } },
        { continuationItemViewModel: { continuationCommand: { innertubeCommand: {
          continuationCommand: { token: 'EMPTY_PAGE' },
        } } } },
      ],
    }));

    const playlist = await createYouTubeClient({ fetch: fetchMock as typeof fetch })
      .getPlaylist('PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

    expect(playlist).toMatchObject({
      id: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      title: 'Modern research playlist',
      description: 'A modern playlist response fixture.',
      channel: {
        id: 'UCOWNER',
        name: 'Playlist Owner',
        url: 'https://www.youtube.com/channel/UCOWNER',
      },
      thumbnails: [{ url: 'https://img.test/playlist-cover.jpg', width: 480, height: 270 }],
      videoCount: 1,
      videoCountText: '1 video',
      videos: [{
        id: 'abcdefghijk',
        channel: {
          id: 'UCVIDEO',
          name: 'Video Creator',
          url: 'https://www.youtube.com/channel/UCVIDEO',
        },
      }],
    });
    expect(playlist.continuation).toBeUndefined();
  });

  test('separates channel metadata, videos, and playlists into independent resources', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/channel/UC123/about')) return htmlResponse({
        metadata: { channelMetadataRenderer: {
          externalId: 'UC123', title: 'Research Lab', description: 'Evidence-first videos.',
          vanityChannelUrl: 'https://www.youtube.com/@ResearchLab',
          channelUrl: 'https://www.youtube.com/channel/UC123',
          avatar: { thumbnails: [{ url: 'https://img.test/channel.jpg', width: 900, height: 900 }] },
        } },
        contents: [{ aboutChannelRenderer: { metadata: { aboutChannelViewModel: {
          channelId: 'UC123',
          description: 'Evidence-first videos.\nContact: research@example.com',
          subscriberCountText: '2.04M subscribers',
          videoCountText: '218 videos',
          viewCountText: '460,922,610 views',
          joinedDateText: { content: 'Joined May 8, 2012' },
          canonicalChannelUrl: 'http://www.youtube.com/@ResearchLab',
          displayCanonicalChannelUrl: 'www.youtube.com/@ResearchLab',
          signInForBusinessEmail: { content: 'Sign in to see email address' },
          links: [{ channelExternalLinkViewModel: {
            title: { content: 'Patreon' },
            link: {
              content: 'patreon.com/ResearchLab',
              commandRuns: [{ onTap: { innertubeCommand: { urlEndpoint: {
                url: 'https://www.youtube.com/redirect?redir_token=temporary&q=https%3A%2F%2Fwww.patreon.com%2FResearchLab',
              } } } }],
            },
          } }],
        } } } }],
      });
      const payload = JSON.parse(String(init?.body)) as { params?: string };
      if (payload.params === 'VIDEOS_TAB') return response({
        contents: [{ richItemRenderer: { content: { lockupViewModel: {
          contentId: 'abcdefghijk',
          contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          contentImage: { thumbnailViewModel: {
            image: { sources: [{ url: 'https://img.test/newest.jpg', width: 336, height: 188 }] },
            overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '39:49' } }] } }],
          } },
          metadata: { lockupMetadataViewModel: {
            title: { content: 'The Future of Research' },
            metadata: { contentMetadataViewModel: { metadataRows: [
              { metadataParts: [
                { text: { content: '621K views' } }, { text: { content: '2 months ago' } },
              ] },
              { badges: [{ badgeViewModel: { badgeText: 'CC', rendererContext: {
                accessibilityContext: { label: 'Closed captions' },
              } } }] },
            ] } },
          } },
        } } } }],
        continuationContents: { richGridContinuation: { contents: [{
          continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'MORE_VIDEOS' } } },
        }] } },
      });
      if (payload.params === 'PLAYLISTS_TAB') return response({
        contents: [
          { lockupViewModel: {
            contentId: 'PL123',
            contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
            contentImage: { collectionThumbnailViewModel: { primaryThumbnail: { thumbnailViewModel: {
              image: { sources: [{ url: 'https://img.test/playlist.jpg', width: 480, height: 270 }] },
              overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: '6 videos' } }] } }],
            } } } },
            metadata: { lockupMetadataViewModel: {
              title: { content: 'Dune Research' },
              metadata: { contentMetadataViewModel: { metadataRows: [
                { metadataParts: [{ text: { content: 'Updated 4 days ago' } }] },
                { metadataParts: [{ text: { content: 'View full playlist' } }] },
              ] } },
            } },
            rendererContext: { commandContext: { onTap: { innertubeCommand: {
              watchEndpoint: { videoId: 'abcdefghijk', playlistId: 'PL123' },
            } } } },
          } },
          { lockupViewModel: {
            contentId: 'PLPODCAST',
            contentType: 'LOCKUP_CONTENT_TYPE_PODCAST',
            contentImage: { collectionThumbnailViewModel: { primaryThumbnail: { thumbnailViewModel: {
              overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [
                { thumbnailBadgeViewModel: { text: '181 episodes' } },
              ] } }],
            } } } },
            metadata: { lockupMetadataViewModel: { title: { content: 'Research videos' } } },
          } },
        ],
        continuationContents: { gridContinuation: { continuations: [{
          nextContinuationData: { continuation: 'MORE_PLAYLISTS' },
        }] } },
      });
      return response({
        metadata: { channelMetadataRenderer: {
          externalId: 'UC123', title: 'Research Lab', description: 'Evidence-first videos.',
          vanityChannelUrl: 'https://www.youtube.com/@ResearchLab',
          channelUrl: 'https://www.youtube.com/channel/UC123',
          avatar: { thumbnails: [{ url: 'https://img.test/channel.jpg', width: 900, height: 900 }] },
        } },
        header: { pageHeaderRenderer: { content: { pageHeaderViewModel: {
          metadata: { contentMetadataViewModel: { metadataRows: [
            { metadataParts: [{ text: { content: '@ResearchLab' } }] },
            { metadataParts: [
              { text: { content: '2.04M subscribers' } },
              { text: { content: '218 videos' } },
            ] },
          ] } },
        } } } },
        contents: { twoColumnBrowseResultsRenderer: { tabs: [
          { tabRenderer: {
            title: 'Videos',
            endpoint: {
              commandMetadata: { webCommandMetadata: { url: '/@ResearchLab/videos' } },
              browseEndpoint: { browseId: 'UC123', params: 'VIDEOS_TAB' },
            },
          } },
          { tabRenderer: {
            title: 'Playlists',
            endpoint: {
              commandMetadata: { webCommandMetadata: { url: '/@ResearchLab/playlists' } },
              browseEndpoint: { browseId: 'UC123', params: 'PLAYLISTS_TAB' },
            },
          } },
        ] } },
      });
    });

    const client = createYouTubeClient({ fetch: fetchMock as typeof fetch });
    const channel = await client.getChannel('UC123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(channel).toMatchObject({
      id: 'UC123',
      name: 'Research Lab',
      handle: '@ResearchLab',
      url: 'https://www.youtube.com/@ResearchLab',
      about: {
        description: 'Evidence-first videos.\nContact: research@example.com',
        links: [{
          title: 'Patreon',
          displayUrl: 'patreon.com/ResearchLab',
          url: 'https://www.patreon.com/ResearchLab',
        }],
        moreInfo: {
          canonicalChannelUrl: 'https://www.youtube.com/@ResearchLab',
          displayCanonicalChannelUrl: 'www.youtube.com/@ResearchLab',
          joinedDate: '2012-05-08',
          joinedDateText: 'Joined May 8, 2012',
          subscriberCount: 2040000,
          subscriberCountText: '2.04M subscribers',
          videoCount: 218,
          viewCount: 460922610,
          businessEmailAvailable: true,
        },
      },
    });
    expect(channel).not.toHaveProperty('videos');
    expect(channel).not.toHaveProperty('playlists');
    expect(channel).not.toHaveProperty('continuation');

    const videoPage = await client.getChannelVideos('UC123');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(videoPage).toMatchObject({
      channelId: 'UC123',
      sort: 'latest',
      continuation: 'MORE_VIDEOS',
      videos: [{
        id: 'abcdefghijk', title: 'The Future of Research', viewCount: 621000,
        viewCountText: '621K views', publishedTimeText: '2 months ago', durationSeconds: 2389,
        channel: { id: 'UC123', name: 'Research Lab' }, hasCaptions: true,
      }],
    });

    const playlistPage = await client.getChannelPlaylists('UC123');

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(playlistPage).toMatchObject({
      channelId: 'UC123',
      sort: 'newest',
      continuation: 'MORE_PLAYLISTS',
      playlists: [
        {
          id: 'PL123', title: 'Dune Research', videoCount: 6, videoCountText: '6 videos',
          updatedTimeText: 'Updated 4 days ago', isPodcast: false,
          playUrl: 'https://www.youtube.com/watch?v=abcdefghijk&list=PL123',
        },
        {
          id: 'PLPODCAST', title: 'Research videos', videoCount: 181,
          videoCountText: '181 episodes', isPodcast: true,
        },
      ],
    });
  });

  test('paginates channel videos with the video-specific continuation', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { continuation?: string };
      if (payload.continuation === 'VIDEO_PAGE_2') {
        return response({
          contents: [{ richItemRenderer: { content: { videoRenderer: {
            videoId: 'abcdefghijk', title: { simpleText: 'Second page video' },
            thumbnail: { thumbnails: [] },
          } } } }],
          continuationContents: { richGridContinuation: { contents: [{
            continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'VIDEO_PAGE_3' } } },
          }] } },
        });
      }
      return response({ metadata: { channelMetadataRenderer: {
        externalId: 'UC123', title: 'Research Lab', channelUrl: 'https://www.youtube.com/channel/UC123',
      } } });
    });

    const page = await createYouTubeClient({ fetch: fetchMock as typeof fetch })
      .getChannelVideos('UC123', 'VIDEO_PAGE_2');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page).toMatchObject({
      channelId: 'UC123',
      sort: 'latest',
      continuation: 'VIDEO_PAGE_3',
      videos: [{ id: 'abcdefghijk', title: 'Second page video' }],
    });
  });

  test('applies the same channel catalog sorts exposed by the YouTube tabs', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        browseId?: string; params?: string; continuation?: string;
      };
      if (payload.params === 'VIDEOS_TAB') return response({
        header: { feedFilterChipBarRenderer: { contents: [
          { chipViewModel: { text: 'Latest', selected: true } },
          { chipViewModel: { text: 'Popular', tapCommand: { innertubeCommand: {
            continuationCommand: { token: 'POPULAR_SORT' },
          } } } },
          { chipViewModel: { text: 'Oldest', tapCommand: { innertubeCommand: {
            continuationCommand: { token: 'OLDEST_SORT' },
          } } } },
        ] } },
      });
      if (payload.continuation === 'POPULAR_SORT') return response({
        contents: [{ lockupViewModel: {
          contentId: 'popular12345', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          metadata: { lockupMetadataViewModel: { title: { content: 'Most popular' } } },
        } }],
        continuationContents: { richGridContinuation: { contents: [{
          continuationItemRenderer: { continuationEndpoint: {
            continuationCommand: { token: 'MORE_POPULAR' },
          } },
        }] } },
      });
      if (payload.params === 'PLAYLISTS_TAB') return response({
        menu: { sortFilterSubMenuRenderer: { subMenuItems: [
          { title: 'Date added (newest)', selected: true },
          { title: 'Last video added', navigationEndpoint: { browseEndpoint: {
            browseId: 'UC123', params: 'LAST_VIDEO_ADDED',
          } } },
        ] } },
      });
      if (payload.params === 'LAST_VIDEO_ADDED') return response({
        contents: [{ lockupViewModel: {
          contentId: 'PLRECENT', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
          metadata: { lockupMetadataViewModel: { title: { content: 'Recently updated' } } },
        } }],
      });
      return response({
        metadata: { channelMetadataRenderer: {
          externalId: 'UC123', title: 'Research Lab',
          channelUrl: 'https://www.youtube.com/channel/UC123',
        } },
        contents: { twoColumnBrowseResultsRenderer: { tabs: [
          { tabRenderer: { endpoint: {
            commandMetadata: { webCommandMetadata: { url: '/@ResearchLab/videos' } },
            browseEndpoint: { browseId: 'UC123', params: 'VIDEOS_TAB' },
          } } },
          { tabRenderer: { endpoint: {
            commandMetadata: { webCommandMetadata: { url: '/@ResearchLab/playlists' } },
            browseEndpoint: { browseId: 'UC123', params: 'PLAYLISTS_TAB' },
          } } },
        ] } },
      });
    });
    const client = createYouTubeClient({ fetch: fetchMock as typeof fetch });

    const videos = await client.getChannelVideos('UC123', undefined, 'popular');
    const playlists = await client.getChannelPlaylists('UC123', undefined, 'last-video-added');

    expect(videos).toMatchObject({
      sort: 'popular', continuation: 'MORE_POPULAR',
      videos: [{ id: 'popular12345', title: 'Most popular' }],
    });
    expect(playlists).toMatchObject({
      sort: 'last-video-added',
      playlists: [{ id: 'PLRECENT', title: 'Recently updated' }],
    });
  });

  test('normalizes search renderers, filters captions/duration, and exposes a continuation', async () => {
    const fetchMock = vi.fn(async () => response({
      contents: [{ videoRenderer: {
        videoId: 'abcdefghijk', title: { simpleText: 'Captioned lesson' },
        ownerText: { runs: [{ text: 'Research Lab', navigationEndpoint: { browseEndpoint: { browseId: 'UC123' } } }] },
        lengthText: { simpleText: '12:30' }, viewCountText: { simpleText: '12K views' },
        badges: [{ metadataBadgeRenderer: { label: 'CC', tooltip: 'Subtitles/closed captions' } }],
        thumbnail: { thumbnails: [{ url: 'https://img.test/video.jpg', width: 320, height: 180 }] },
      } }, { channelRenderer: { channelId: 'UC999', title: { simpleText: 'Other channel' }, thumbnail: { thumbnails: [] } } }],
      continuationContents: { itemSectionContinuation: { continuations: [{ nextContinuationData: { continuation: 'NEXT_PAGE' } }] } },
    }));
    const client = createYouTubeClient({ fetch: fetchMock as typeof fetch });
    const result = await client.search('research', { type: 'video', duration: 'medium', captionsOnly: true });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ type: 'video', id: 'abcdefghijk', hasCaptions: true, durationSeconds: 750 });
    expect(result.continuation).toBe('NEXT_PAGE');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/search'), expect.objectContaining({ method: 'POST' }));
  });

  test('retries rate-limited InnerTube search requests through the shared transport', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts < 5) return new Response('limited', { status: 429 });
      return response({ contents: [{ videoRenderer: {
        videoId: 'abcdefghijk', title: { simpleText: 'Recovered result' },
        ownerText: { runs: [{ text: 'Research Lab' }] }, thumbnail: { thumbnails: [] },
      } }] });
    });
    const client = createYouTubeClient({
      fetch: fetchMock as typeof fetch,
      retry: { wait: async (delayMs) => { waits.push(delayMs); }, random: () => 0 },
    });

    const result = await client.search('research');

    expect(result.videos[0]?.title).toBe('Recovered result');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(waits).toHaveLength(4);
  });

  test('deduplicates search entities and returns explicit result categories', async () => {
    const duplicateVideo = {
      videoId: 'abcdefghijk',
      title: { simpleText: 'Repeated research video' },
      ownerText: { runs: [{
        text: 'Research Lab',
        navigationEndpoint: { browseEndpoint: { browseId: 'UC123' } },
      }] },
      thumbnail: { thumbnails: [{ url: 'https://img.test/video.jpg', width: 320, height: 180 }] },
    };
    const client = createYouTubeClient({ fetch: vi.fn(async () => response({
      contents: [
        { videoRenderer: duplicateVideo },
        { videoRenderer: duplicateVideo },
        { channelRenderer: {
          channelId: 'UC123', title: { simpleText: 'Research Lab' }, thumbnail: { thumbnails: [] },
        } },
        { playlistRenderer: {
          playlistId: 'PL123', title: { simpleText: 'Research playlist' },
          videoCountText: { simpleText: '3 videos' }, thumbnail: { thumbnails: [] },
        } },
      ],
      continuationContents: { itemSectionContinuation: { continuations: [
        { nextContinuationData: { continuation: 'NEXT_SEARCH_PAGE' } },
      ] } },
    })) as typeof fetch });

    const result = await client.search('research');

    expect(result.results.map((item) => `${item.type}:${item.id}`)).toEqual([
      'video:abcdefghijk',
      'channel:UC123',
      'playlist:PL123',
    ]);
    expect(result.videos.map((video) => video.id)).toEqual(['abcdefghijk']);
    expect(result.channels.map((channel) => channel.id)).toEqual(['UC123']);
    expect(result.playlists.map((playlist) => playlist.id)).toEqual(['PL123']);
    expect(result.continuation).toBe('NEXT_SEARCH_PAGE');
  });

  test('browses a supported discovery category with request-specific locale and result buckets', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({
      metadata: { channelMetadataRenderer: { title: 'Music' } },
      contents: [
        { videoRenderer: {
          videoId: 'abcdefghijk', title: { simpleText: 'Featured performance' },
          ownerText: { runs: [{
            text: 'Music Channel',
            navigationEndpoint: { browseEndpoint: { browseId: 'UCMUSIC' } },
          }] },
          thumbnail: { thumbnails: [] },
        } },
        { continuationItemRenderer: {
          continuationEndpoint: { continuationCommand: { token: 'MORE_MUSIC' } },
        } },
      ],
    }));

    const result = await createYouTubeClient({ fetch: fetchMock as typeof fetch }).browse({
      categoryId: 'music',
      region: 'IN',
      language: 'hi',
    });

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      browseId: 'UC-9-kyTW8ZkZNDHQJ6FgpwQ',
      context: { client: { gl: 'IN', hl: 'hi' } },
    });
    expect(result).toMatchObject({
      category: 'music',
      browseId: 'UC-9-kyTW8ZkZNDHQJ6FgpwQ',
      title: 'Music',
      videos: [{ id: 'abcdefghijk' }],
      channels: [],
      playlists: [],
      continuation: 'MORE_MUSIC',
    });
  });

  test('rejects browse categories and locales outside the public contract', async () => {
    const client = createYouTubeClient({ fetch: vi.fn(async () => response({})) as typeof fetch });

    await expect(client.browse({ categoryId: '10' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.browse({ categoryId: 'gaming' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.browse({ categoryId: 'music', region: 'GB' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.browse({ categoryId: 'music', language: 'fr' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('computes ASR word timestamps from tStartMs + tOffsetMs and preserves translation provenance', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes('/player')) return response(playerFixture('asr'));
      if (String(input).startsWith('https://www.youtube.com/watch')) {
        return new Response(
          `<!doctype html><script>var ytInitialPlayerResponse = ${JSON.stringify(playerFixture('asr'))};</script>`,
          { headers: { 'content-type': 'text/html', 'set-cookie': 'VISITOR_INFO1_LIVE=test-visitor; Path=/; Secure' } },
        );
      }
      return response({ events: [{ tStartMs: 1200, dDurationMs: 900, segs: [
        { utf8: 'Hello ', tOffsetMs: 0 }, { utf8: 'world', tOffsetMs: 420 },
      ] }] });
    });
    const transcript = await createYouTubeClient({ fetch: fetchMock as typeof fetch }).getTranscript({
      videoId: 'abcdefghijk', language: 'en', translateTo: 'es', granularity: 'word',
    });
    expect(transcript.track).toMatchObject({ kind: 'asr', provenance: 'asr', languageCode: 'en' });
    expect(transcript.translatedTo).toEqual({ languageCode: 'es', name: 'Spanish' });
    expect(transcript.granularity).toBe('word');
    expect(transcript.segments[0]!.words).toEqual([
      { text: 'Hello ', startMs: 1200, offsetMs: 0 },
      { text: 'world', startMs: 1620, offsetMs: 420 },
    ]);
    const captionUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    const captionHeaders = fetchMock.mock.calls.at(-1)?.[1]?.headers as Record<string, string>;
    expect(captionUrl).toContain('fmt=json3');
    expect(captionUrl).toContain('tlang=es');
    expect(captionHeaders.Cookie).toBe('VISITOR_INFO1_LIVE=test-visitor');
  });

  test('reports manual caption tracks and available translation languages', async () => {
    const client = createYouTubeClient({ fetch: vi.fn(async () => response(playerFixture('manual'))) as typeof fetch });
    const tracks = await client.getCaptionTracks('abcdefghijk');
    expect(tracks.tracks[0]).toMatchObject({ kind: 'manual', provenance: 'manual', isDefault: true });
    expect(tracks.translationLanguages).toContainEqual({ languageCode: 'hi', name: 'Hindi' });
  });

  test('supplements the mobile caption catalog with every desktop translation target', async () => {
    const desktopFixture = playerFixture('manual');
    const renderer = (desktopFixture.captions as any).playerCaptionsTracklistRenderer;
    renderer.translationLanguages = [
      { languageCode: 'af', languageName: { simpleText: 'Afrikaans' } },
      { languageCode: 'hi', languageName: { simpleText: 'Hindi' } },
      { languageCode: 'zu', languageName: { simpleText: 'Zulu' } },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://www.youtube.com/watch')) {
        return new Response(`<!doctype html><script>var ytInitialPlayerResponse = ${JSON.stringify(desktopFixture)};</script>`, {
          headers: { 'content-type': 'text/html' },
        });
      }
      return response(playerFixture('manual'));
    });

    const result = await createYouTubeClient({ fetch: fetchMock as typeof fetch })
      .getCaptionTracks('abcdefghijk');

    expect(result.translationLanguages).toEqual(expect.arrayContaining([
      { languageCode: 'af', name: 'Afrikaans' },
      { languageCode: 'hi', name: 'Hindi' },
      { languageCode: 'zu', name: 'Zulu' },
    ]));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('youtube.com/watch?v=abcdefghijk'),
      expect.any(Object),
    );
  });

  test('uses the default source track when only a translation target is requested', async () => {
    const fixture = playerFixture('manual');
    const renderer = (fixture.captions as any).playerCaptionsTracklistRenderer;
    renderer.defaultAudioTrackIndex = 1;
    renderer.audioTracks = [
      { defaultCaptionTrackIndex: 0 },
      { defaultCaptionTrackIndex: 1, hasDefaultTrack: true },
    ];
    renderer.captionTracks = [
      {
        baseUrl: 'https://captions.test/en?lang=en', vssId: '.en', languageCode: 'en',
        name: { simpleText: 'English' }, isTranslatable: true,
      },
      {
        baseUrl: 'https://captions.test/es?lang=es', vssId: '.es', languageCode: 'es',
        name: { simpleText: 'Spanish' }, isTranslatable: true,
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/player')) return response(fixture);
      if (String(input).startsWith('https://www.youtube.com/watch')) {
        return new Response(`<!doctype html><script>var ytInitialPlayerResponse = ${JSON.stringify(fixture)};</script>`, {
          headers: { 'content-type': 'text/html', 'set-cookie': 'VISITOR_INFO1_LIVE=test-visitor; Path=/; Secure' },
        });
      }
      return response({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'नमस्ते' }] }] });
    });

    const transcript = await createYouTubeClient({ fetch: fetchMock as typeof fetch }).getTranscript({
      videoId: 'abcdefghijk', translateTo: 'hi', granularity: 'segment',
    });

    expect(transcript.track.languageCode).toBe('es');
    expect(transcript.translatedTo).toEqual({ languageCode: 'hi', name: 'Hindi' });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/es?');
  });

  test('retries translated captions with a refreshed visitor session after upstream rate limiting', async () => {
    const fixture = playerFixture('asr');
    let captionAttempts = 0;
    let watchAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/player')) return response(fixture);
      if (String(input).startsWith('https://www.youtube.com/watch')) {
        watchAttempts += 1;
        return new Response(`<!doctype html><script>var ytInitialPlayerResponse = ${JSON.stringify(fixture)};</script>`, {
          headers: { 'content-type': 'text/html', 'set-cookie': `VISITOR_INFO1_LIVE=visitor-${watchAttempts}; Path=/; Secure` },
        });
      }
      captionAttempts += 1;
      if (captionAttempts < 5) return new Response('rate limited', { status: 429 });
      return response({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'नमस्ते' }] }] });
    });

    const transcript = await createYouTubeClient({
      fetch: fetchMock as typeof fetch,
      retry: { wait: async () => {}, random: () => 0 },
    }).getTranscript({
      videoId: 'abcdefghijk', translateTo: 'hi',
    });

    expect(transcript.text).toBe('नमस्ते');
    expect(captionAttempts).toBe(5);
    expect(watchAttempts).toBe(5);
  });

  test('normalizes unavailable/private/live video state without leaking signed media URLs', async () => {
    const fixture = playerFixture('manual');
    fixture.playabilityStatus = { status: 'LOGIN_REQUIRED', reason: 'Private video' };
    fixture.videoDetails = { ...fixture.videoDetails as object, isPrivate: true, isLiveContent: true };
    const video = await createYouTubeClient({ fetch: vi.fn(async () => response(fixture)) as typeof fetch }).getVideo('abcdefghijk');
    expect(video.availability).toMatchObject({ playable: false, isPrivate: true, isLive: true });
    expect(video.isLive).toBe(true);
    expect(JSON.stringify(video)).not.toContain('https://signed.test');
  });

  test('returns core video metadata without fetching or embedding subresources', async () => {
    const fixture = playerFixture('manual');
    const fetchMock = vi.fn(async () => response(fixture));

    const video = await createYouTubeClient({ fetch: fetchMock as typeof fetch }).getVideo('abcdefghijk');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(video).toMatchObject({
      id: 'abcdefghijk',
      title: 'Evidence video',
      durationSeconds: 90,
      durationText: '1:30',
      viewCount: 1000,
      viewCountText: '1K views',
      keywords: [],
    });
    expect(video.meta.source).toBe('allthingsyoutube');
    expect(video).not.toHaveProperty('captionTracks');
    expect(video).not.toHaveProperty('translationLanguages');
    expect(video).not.toHaveProperty('media');
    expect(video).not.toHaveProperty('storyboards');
    expect(video).not.toHaveProperty('endscreen');
  });

  test('normalizes public trend signals from the watch-next response', async () => {
    const client = createYouTubeClient({ fetch: vi.fn(async () => response({
      contents: [{ videoPrimaryInfoRenderer: {
        dateText: { simpleText: 'Jul 31, 2026' },
        viewCount: { videoViewCountRenderer: { originalViewCount: '12345' } },
      } }],
      engagementPanels: [{ engagementPanelSectionListRenderer: {
        content: { commentsHeaderRenderer: { commentsCount: { runs: [{ text: '234' }] } } },
      } }],
      frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: {
        likeCountEntity: { likeCountIfIndifferentNumber: '987' },
      } }] } },
    })) as typeof fetch });
    await expect(client.getVideoSignals('abcdefghijk')).resolves.toMatchObject({
      videoId: 'abcdefghijk', publishDate: 'Jul 31, 2026', viewCount: 12345,
      commentCount: 234, likeCount: 987,
    });
  });

  test('normalizes comment threads and continuation tokens', async () => {
    const client = createYouTubeClient({ fetch: vi.fn(async () => response({
      onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
        { commentThreadRenderer: { comment: { commentRenderer: {
          commentId: 'comment-1', contentText: { simpleText: 'Can you explain the evidence?' },
          authorText: { simpleText: 'Viewer' }, voteCount: { simpleText: '42' },
        } }, replyCount: 3, replies: { commentRepliesRenderer: { contents: [
          { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'COMMENT_REPLIES' } } } },
        ] } } } },
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'MORE_COMMENTS' } } } },
      ] } }],
      engagementPanels: [{ engagementPanelSectionListRenderer: {
        content: { commentsHeaderRenderer: { commentsCount: { simpleText: '234' } } },
      } }],
    })) as typeof fetch });
    const page = await client.getComments({ videoId: 'abcdefghijk' });
    expect(page.totalCount).toBe(234);
    expect(page.comments[0]).toMatchObject({ id: 'comment-1', text: 'Can you explain the evidence?', replyCount: 3 });
    expect(page.continuation).toBe('MORE_COMMENTS');
    expect(page.replyContinuations).toEqual(['COMMENT_REPLIES']);
  });

  test('follows the comments bootstrap continuation before returning the first page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [
          { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'COMMENTS_BOOTSTRAP' } } } },
        ] } }],
        engagementPanels: [{ engagementPanelSectionListRenderer: {
          content: { commentsHeaderRenderer: { commentsCount: { simpleText: '1.2K' } } },
        } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
          { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'NEXT_COMMENTS' } } } },
        ] } }],
        frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { commentEntityPayload: {
          properties: { commentId: 'comment-2', content: { content: 'This was useful.' }, publishedTime: '1 day ago' },
          author: { channelId: 'UC456', displayName: 'Researcher', avatarThumbnailUrl: 'https://img.test/avatar.jpg' },
          toolbar: { likeCountNotliked: '7', replyCount: '2' },
        } } }] } },
      }));
    const page = await createYouTubeClient({ fetch: fetchMock as typeof fetch }).getComments({ videoId: 'abcdefghijk' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.comments).toHaveLength(1);
    expect(page.totalCount).toBe(1200);
    expect(page.comments[0]).toMatchObject({ id: 'comment-2', text: 'This was useful.' });
    expect(page.continuation).toBe('NEXT_COMMENTS');
  });

  test('crawls every comment page and reply continuation without duplicates', async () => {
    const continuationItem = (token: string) => ({
      continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } },
    });
    const commentThread = (id: string, text: string, replyToken?: string) => ({
      commentThreadRenderer: {
        comment: { commentRenderer: { commentId: id, contentText: { simpleText: text } } },
        replies: replyToken ? { commentRepliesRenderer: { contents: [continuationItem(replyToken)] } } : undefined,
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: {
          continuationItems: [continuationItem('COMMENTS_BOOTSTRAP')],
        } }],
        engagementPanels: [{ engagementPanelSectionListRenderer: {
          content: { commentsHeaderRenderer: { commentsCount: { simpleText: '3' } } },
        } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [
          commentThread('top-1', 'First thread', 'REPLIES_FOR_TOP_1'),
          continuationItem('MORE_THREADS'),
        ] } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
          commentThread('top-2', 'Second thread'),
        ] } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
          { commentRenderer: { commentId: 'top-1.reply-1', contentText: { simpleText: 'A reply' } } },
        ] } }],
      }));

    const result = await createYouTubeClient({ fetch: fetchMock as typeof fetch })
      .getAllComments({ videoId: 'abcdefghijk' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.comments.map((comment) => comment.id)).toEqual(['top-1', 'top-2', 'top-1.reply-1']);
    expect(result.comments[0]?.replies.map((reply) => reply.id)).toEqual(['top-1.reply-1']);
    expect(result).toMatchObject({
      complete: true,
      totalCount: 3,
      topLevelCount: 2,
      replyCount: 1,
      remainingContinuations: 0,
    });
  });

  test('follows reply continuations nested in a continuation button command', async () => {
    const continuationItem = (token: string) => ({
      continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: {
          continuationItems: [continuationItem('COMMENTS_BOOTSTRAP')],
        } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [{
          commentThreadRenderer: {
            comment: { commentRenderer: { commentId: 'top-1', contentText: { simpleText: 'Thread' } } },
            replies: { commentRepliesRenderer: { contents: [continuationItem('FIRST_REPLIES')] } },
          },
        }] } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
          { commentRenderer: { commentId: 'top-1.reply-1', contentText: { simpleText: 'First reply' } } },
          { continuationItemRenderer: { button: { buttonRenderer: {
            command: { continuationCommand: { token: 'MORE_REPLIES' } },
          } } } },
        ] } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { continuationItems: [
          { commentRenderer: { commentId: 'top-1.reply-2', contentText: { simpleText: 'Later reply' } } },
        ] } }],
      }));

    const result = await createYouTubeClient({ fetch: fetchMock as typeof fetch })
      .getAllComments({ videoId: 'abcdefghijk' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.comments.map((comment) => comment.id)).toEqual([
      'top-1',
      'top-1.reply-1',
      'top-1.reply-2',
    ]);
    expect(result.comments[0]?.replies.map((reply) => reply.id)).toEqual([
      'top-1.reply-1',
      'top-1.reply-2',
    ]);
    expect(result).toMatchObject({ complete: true, topLevelCount: 1, replyCount: 2 });
  });

  test('uses the Newest feed so potential-spam comments are not omitted by Top comments', async () => {
    const continuationItem = (token: string) => ({
      continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } },
    });
    const commentThread = (id: string, text: string) => ({
      commentThreadRenderer: {
        comment: { commentRenderer: { commentId: id, contentText: { simpleText: text } } },
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: {
          continuationItems: [continuationItem('COMMENTS_BOOTSTRAP')],
        } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [
          { commentsHeaderRenderer: { sortMenu: { sortFilterSubMenuRenderer: { subMenuItems: [
            { title: 'Top', selected: true },
            { title: 'Newest', selected: false, serviceEndpoint: { continuationCommand: { token: 'NEWEST_COMMENTS' } } },
          ] } } } },
          commentThread('featured-only', 'Only present in the filtered Top response'),
        ] } }],
      }))
      .mockResolvedValueOnce(response({
        onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [
          commentThread('newest-only', 'Included by Newest, including potential spam'),
        ] } }],
      }));

    const result = await createYouTubeClient({ fetch: fetchMock as typeof fetch })
      .getAllComments({ videoId: 'abcdefghijk' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.comments.map((comment) => comment.id)).toEqual(['newest-only']);
    expect(result).toMatchObject({ complete: true, topLevelCount: 1, replyCount: 0 });
  });

  test('returns stable invalid-input errors', async () => {
    await expect(createYouTubeClient({ fetch }).getVideo('bad')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(createYouTubeClient({ fetch }).getPlaylist('PLnope_zzz_99887766'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('returns not-found for a well-formed channel id with no channel metadata', async () => {
    const client = createYouTubeClient({ fetch: vi.fn(async () => response({})) as typeof fetch });
    await expect(client.getChannel('UCxxxxxxxxxxxxxxxxxxxxxx')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

function playerFixture(kind: 'manual' | 'asr'): Record<string, unknown> {
  const vssId = kind === 'asr' ? 'a.en' : '.en';
  return {
    playabilityStatus: { status: 'OK', playableInEmbed: true },
    videoDetails: {
      videoId: 'abcdefghijk', title: 'Evidence video', author: 'Research Lab', channelId: 'UC123',
      lengthSeconds: '90', viewCount: '1000', shortDescription: 'A source.',
      thumbnail: { thumbnails: [{ url: 'https://img.test/video.jpg' }] },
    },
    streamingData: {
      formats: [{ itag: 18, mimeType: 'video/mp4; codecs="avc1"', url: 'https://signed.test/video' }],
      adaptiveFormats: [],
    },
    captions: { playerCaptionsTracklistRenderer: {
      captionTracks: [{
        baseUrl: 'https://captions.test/api?lang=en', vssId, languageCode: 'en',
        kind: kind === 'asr' ? 'asr' : undefined, name: { simpleText: 'English' }, isTranslatable: true,
      }],
      translationLanguages: [
        { languageCode: 'hi', languageName: { simpleText: 'Hindi' } },
        { languageCode: 'es', languageName: { simpleText: 'Spanish' } },
      ],
    } },
  };
}
