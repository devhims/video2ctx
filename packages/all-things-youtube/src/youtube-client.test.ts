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

  test('selects the default caption for the default audio track', async () => {
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

    expect(response.track).toMatchObject({ id: '.es', languageCode: 'es', isDefault: true });
    expect(response.text).toBe('hola');
  });
});
