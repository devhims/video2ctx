import { createYouTubeClient } from '../src/lib/youtube-client';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

describe('normalized YouTube client', () => {
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
