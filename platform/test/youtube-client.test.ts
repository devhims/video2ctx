import { createYouTubeClient } from '../src/lib/youtube-client';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

describe('normalized YouTube client', () => {
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
      .getPlaylist('PLMODERN');

    expect(playlist).toMatchObject({
      id: 'PLMODERN',
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

  test('loads modern channel video and playlist tabs and normalizes lockup view models', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
            metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [
              { text: { content: '621K views' } }, { text: { content: '2 months ago' } },
            ] }] } },
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
            metadata: { lockupMetadataViewModel: { title: { content: 'Dune Research' } } },
          } },
          { lockupViewModel: {
            contentId: 'PLPODCAST',
            contentType: 'LOCKUP_CONTENT_TYPE_PODCAST',
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

    const channel = await createYouTubeClient({ fetch: fetchMock as typeof fetch }).getChannel('UC123');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(channel).toMatchObject({
      id: 'UC123',
      name: 'Research Lab',
      handle: '@ResearchLab',
      subscriberCountText: '2.04M subscribers',
      videoCountText: '218 videos',
      continuation: 'MORE_VIDEOS',
      videos: [{
        id: 'abcdefghijk', title: 'The Future of Research', viewCount: 621000,
        viewCountText: '621K views', publishedTimeText: '2 months ago', durationSeconds: 2389,
        channel: { id: 'UC123', name: 'Research Lab' },
      }],
      playlists: [
        { id: 'PL123', title: 'Dune Research', videoCount: 6, videoCountText: '6 videos' },
        { id: 'PLPODCAST', title: 'Research videos' },
      ],
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/player')) return response(playerFixture('asr'));
      return response({ events: [{ tStartMs: 1200, dDurationMs: 900, segs: [
        { utf8: 'Hello ', tOffsetMs: 0 }, { utf8: 'world', tOffsetMs: 420 },
      ] }] });
    });
    const transcript = await createYouTubeClient({ fetch: fetchMock as typeof fetch }).getTranscript({
      videoId: 'abcdefghijk', language: 'en', translateTo: 'es', granularity: 'word',
    });
    expect(transcript.track).toMatchObject({ kind: 'asr', provenance: 'asr', languageCode: 'en' });
    expect(transcript.granularity).toBe('word');
    expect(transcript.segments[0]!.words).toEqual([
      { text: 'Hello ', startMs: 1200, offsetMs: 0 },
      { text: 'world', startMs: 1620, offsetMs: 420 },
    ]);
    const captionUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(captionUrl).toContain('fmt=json3');
    expect(captionUrl).toContain('tlang=es');
  });

  test('reports manual caption tracks and available translation languages', async () => {
    const client = createYouTubeClient({ fetch: vi.fn(async () => response(playerFixture('manual'))) as typeof fetch });
    const tracks = await client.getCaptionTracks('abcdefghijk');
    expect(tracks.tracks[0]).toMatchObject({ kind: 'manual', provenance: 'manual', isDefault: true });
    expect(tracks.translationLanguages).toContainEqual({ languageCode: 'hi', name: 'Hindi' });
  });

  test('normalizes unavailable/private/live video state without leaking signed media URLs', async () => {
    const fixture = playerFixture('manual');
    fixture.playabilityStatus = { status: 'LOGIN_REQUIRED', reason: 'Private video' };
    fixture.videoDetails = { ...fixture.videoDetails as object, isPrivate: true, isLiveContent: true };
    const video = await createYouTubeClient({ fetch: vi.fn(async () => response(fixture)) as typeof fetch }).getVideo('abcdefghijk');
    expect(video.availability).toMatchObject({ playable: false, isPrivate: true, isLive: true });
    expect(video.isLive).toBe(true);
    expect(JSON.stringify(video.media)).not.toContain('https://signed.test');
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
    })) as typeof fetch });
    const page = await client.getComments({ videoId: 'abcdefghijk' });
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
    expect(result).toMatchObject({
      complete: true,
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
      translationLanguages: [{ languageCode: 'hi', languageName: { simpleText: 'Hindi' } }],
    } },
  };
}
