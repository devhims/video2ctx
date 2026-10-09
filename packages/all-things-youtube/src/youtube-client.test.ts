import { describe, expect, test, vi } from 'vitest';

import { createYouTubeClient } from './youtube-client';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function commentRenderer(id: string, text: string): Record<string, unknown> {
  return {
    commentThreadRenderer: {
      comment: {
        commentRenderer: {
          commentId: id,
          contentText: { simpleText: text },
          authorText: { simpleText: 'Commenter' },
        },
      },
    },
  };
}

describe('normalized YouTube client', () => {
  test('finds openai channels when the unfiltered search page contains only videos', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // YouTube's channel filter is required; a relevance page need not include a channel card.
      return jsonResponse({ contents: body.params === 'EgIQAg=='
        ? { channelRenderer: { channelId: 'UCXZCJLdBC09xxGZ6gcdrc6A', title: { simpleText: 'OpenAI' } } }
        : { videoRenderer: { videoId: 'abcdefghijk', title: { simpleText: 'OpenAI news' } } } });
    }) as unknown as typeof fetch;
    const response = await createYouTubeClient({ fetch: fetchMock }).search('openai', { type: 'channel' });
    expect(response.channels.map(channel => channel.name)).toContain('OpenAI');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('channel continuation requests preserve the token without replacing it with search filters', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.continuation).toBe('NEXT_CHANNELS');
      expect(body).not.toHaveProperty('query');
      expect(body).not.toHaveProperty('params');
      return jsonResponse({ contents: [] });
    }) as unknown as typeof fetch;
    await createYouTubeClient({ fetch: fetchMock }).search('openai', { type: 'channel', continuation: 'NEXT_CHANNELS' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('uses YouTube caption filtering instead of relying on omitted result badges', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({
        contents: {
          videoRenderer: {
            videoId: 'abcdefghijk',
            title: { simpleText: 'Captioned video' },
            ownerText: {
              runs: [{
                text: 'Captioned channel',
                navigationEndpoint: { browseEndpoint: { browseId: 'UCcaptioned' } },
              }],
            },
            thumbnail: { thumbnails: [] },
          },
        },
      });
    }) as unknown as typeof fetch;

    const response = await createYouTubeClient({ fetch: fetchMock }).search('captioned video', {
      type: 'video',
      captionsOnly: true,
    });

    expect(requestBodies[0]).toMatchObject({ query: 'captioned video', params: 'EgIoAQ==' });
    expect(response.videos).toHaveLength(1);
    expect(response.videos[0]).toMatchObject({ id: 'abcdefghijk', hasCaptions: true });
  });

  test('does not charge the newest-sort redirect against maxPages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        contents: [
          commentRenderer('old-comment', 'Old comment'),
          {
            sortFilterSubMenuRenderer: {
              subMenuItems: [{
                title: 'Newest first',
                continuationEndpoint: { continuationCommand: { token: 'NEWEST_PAGE' } },
              }],
            },
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        contents: [commentRenderer('new-comment', 'Newest comment')],
      })) as unknown as typeof fetch;

    const response = await createYouTubeClient({ fetch: fetchMock }).getAllComments({
      videoId: 'abcdefghijk',
      maxPages: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.pagesFetched).toBe(1);
    expect(response.comments.map((comment) => comment.id)).toEqual(['new-comment']);
  });

  test('prefers English over a regional default caption when the original language is unknown', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/youtubei/v1/player')) {
        return jsonResponse({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              defaultAudioTrackIndex: 1,
              audioTracks: [
                { defaultCaptionTrackIndex: 0 },
                { defaultCaptionTrackIndex: 2, hasDefaultTrack: true },
              ],
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  vssId: '.en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
                {
                  baseUrl: 'https://captions.test/el',
                  vssId: '.el',
                  languageCode: 'el',
                  name: { simpleText: 'Greek' },
                },
                {
                  baseUrl: 'https://captions.test/es',
                  vssId: '.es',
                  languageCode: 'es',
                  name: { simpleText: 'Spanish' },
                },
              ],
              translationLanguages: [],
            },
          },
        });
      }
      if (url.startsWith('https://www.youtube.com/watch')) {
        return new Response('', { status: 404 });
      }
      if (url.startsWith('https://captions.test/es')) {
        return jsonResponse({
          events: [{
            tStartMs: 0,
            dDurationMs: 1_000,
            segs: [{ utf8: 'hola' }],
          }],
        });
      }
      if (url.startsWith('https://captions.test/en')) {
        return jsonResponse({
          events: [{
            tStartMs: 0,
            dDurationMs: 1_000,
            segs: [{ utf8: 'hello' }],
          }],
        });
      }
      if (url.startsWith('https://captions.test/el')) {
        return jsonResponse({
          events: [{
            tStartMs: 0,
            dDurationMs: 1_000,
            segs: [{ utf8: 'γειά' }],
          }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const response = await createYouTubeClient({ fetch: fetchMock }).getTranscript({
      videoId: 'abcdefghijk',
    });

    expect(response.track).toMatchObject({ id: '.en', languageCode: 'en', isDefault: true });
    expect(response.text).toBe('hello');
  });

  describe('original-language caption selection', () => {
    const asr = (language: string) => ({ baseUrl: `https://captions.test/${language}`, vssId: `a.${language}`,
      languageCode: language, kind: 'asr', name: { simpleText: `${language} (auto-generated)` } });
    // Auto-dubbed videos list one undubbed audio track among dubbed ones.
    const dubbedAudio = (original: string, dubbed: string[]) => ({ adaptiveFormats: [
      ...dubbed.map((language) => ({ audioTrack: { displayName: language, id: `${language}.10`, audioIsDefault: false, isAutoDubbed: true } })),
      { audioTrack: { displayName: `${original} original`, id: `${original}.4`, audioIsDefault: false } },
    ] });
    const client = (player: Record<string, unknown>) => createYouTubeClient({ fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/youtubei/v1/player')) return jsonResponse({ playabilityStatus: { status: 'OK' }, ...player });
      if (url.startsWith('https://www.youtube.com/watch')) return new Response('', { status: 404 });
      const language = /^https:\/\/captions\.test\/([\w-]+)/.exec(url)?.[1];
      if (language) return jsonResponse({ events: [{ tStartMs: 0, dDurationMs: 1_000, segs: [{ utf8: `text in ${language}` }] }] });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch });
    // Video uPEh6ydPGpQ: alphabetical ASR tracks, and a regional default that points at a dubbed language.
    const dubbedVideo = {
      streamingData: dubbedAudio('en-US', ['ar', 'bn']),
      captions: { playerCaptionsTracklistRenderer: {
        defaultAudioTrackIndex: 0,
        audioTracks: [{ audioTrackId: 'ar.10', defaultCaptionTrackIndex: 0, hasDefaultTrack: true }, { audioTrackId: 'en-US.4' }],
        captionTracks: [asr('ar'), asr('bn'), asr('en')],
        translationLanguages: [],
      } },
    };

    test('reads the original audio language of an auto-dubbed video instead of the regional default', async () => {
      const youtube = client(dubbedVideo);
      const response = await youtube.getTranscript({ videoId: 'abcdefghijk' });
      expect(response.track).toMatchObject({ id: 'a.en', languageCode: 'en', isDefault: true });
      expect(response.text).toBe('text in en');
      expect((await youtube.getCaptionTracks('abcdefghijk')).defaultTrackId).toBe('a.en');
    });

    test('prefers a non-English original language over English', async () => {
      const response = await client({
        streamingData: dubbedAudio('hi', ['en']),
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [asr('en'), asr('hi')], translationLanguages: [] } },
      }).getTranscript({ videoId: 'abcdefghijk' });
      expect(response.track).toMatchObject({ id: 'a.hi', languageCode: 'hi' });
    });

    test('keeps an explicitly requested language', async () => {
      const response = await client(dubbedVideo).getTranscript({ videoId: 'abcdefghijk', language: 'ar' });
      expect(response.track).toMatchObject({ id: 'a.ar', languageCode: 'ar' });
    });

    test("falls back to YouTube's default when neither the original language nor English is captioned", async () => {
      const response = await client({ captions: { playerCaptionsTracklistRenderer: {
        audioTracks: [{ defaultCaptionTrackIndex: 1, hasDefaultTrack: true }],
        captionTracks: [asr('el'), asr('es')],
        translationLanguages: [],
      } } }).getTranscript({ videoId: 'abcdefghijk' });
      expect(response.track).toMatchObject({ id: 'a.es', languageCode: 'es' });
    });
  });
});
