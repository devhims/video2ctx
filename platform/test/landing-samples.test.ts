import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspection } from './fixtures/landing-inspection';
import { app } from '../src/app';
import { loadLandingInspection } from '../src/lib/landing-inspection';
import { inspectLandingVideo, LANDING_SAMPLE_IDS } from '../src/lib/landing-samples';

vi.mock('../src/lib/landing-inspection', () => ({ loadLandingInspection: vi.fn() }));

const id = LANDING_SAMPLE_IDS[0];
const image = 'data:image/png;base64,aGVsbG8=';
function snapshot(videoId: string = id) { return { ...inspection(videoId), samplePreview: true }; }
function object(value: unknown) {
  const json = JSON.stringify(value);
  return { size: Buffer.byteLength(json), json: async () => JSON.parse(json) };
}
const get = vi.fn();
const put = vi.fn();
const load = vi.mocked(loadLandingInspection);
const env = { VIDEO_ASSETS: { get, put }, ENVIRONMENT: 'development', APP_ORIGIN: 'http://localhost:3000' } as unknown as Env;
const url = 'https://api.video2ctx.dev/v1/demo/youtube/inspect';
const pending: Promise<unknown>[] = [];
const waitUntil = (work: Promise<unknown>) => { pending.push(work); };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  pending.length = 0;
  get.mockReset().mockResolvedValue(null);
  put.mockReset().mockResolvedValue({ etag: 'saved' });
  load.mockReset().mockResolvedValue(inspection());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('saved homepage samples', () => {
  it('accepts stored metadata from the hosted provider as well as the extraction library', async () => {
    const saved = snapshot();
    get.mockResolvedValue(object({
      ...saved,
      video: { ...saved.video, meta: { ...saved.video.meta, source: 'video2ctx', provider: 'youtube' } },
    }));
    const result = await inspectLandingVideo(env, id, url, waitUntil);
    expect(result).toMatchObject({ samplePreview: true, video: { meta: { source: 'video2ctx', provider: 'youtube' } } });
    expect(load).not.toHaveBeenCalled();
  });

  it.each(LANDING_SAMPLE_IDS)('serves %s with all images and no provider or image requests regardless of age', async (videoId) => {
    get.mockResolvedValue(object(snapshot(videoId)));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await inspectLandingVideo(env, videoId, url, waitUntil);
    expect(result).toMatchObject({ samplePreview: true, video: { id: videoId, thumbnails: [{ url: image }] } });
    expect(get).toHaveBeenCalledWith(`landing-samples/v1/${videoId}.json`);
    expect(load).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('reuses the edge cache when R2 is unavailable and never caches visitor quota', async () => {
    get.mockResolvedValue(object({ ...snapshot(), quota: { remaining: 4 } }));
    let saved: Response | undefined;
    const cache = {
      match: vi.fn(async () => saved?.clone()),
      put: vi.fn(async (_: Request, response: Response) => { saved = response; }),
    };
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
    await inspectLandingVideo(env, id, url, waitUntil);
    await Promise.all(pending);
    get.mockRejectedValue(new Error('R2 down'));
    const result = await inspectLandingVideo(env, id, url, waitUntil);
    expect(result).toHaveProperty('samplePreview', true);
    expect(result).not.toHaveProperty('quota');
    expect(saved?.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(get).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('ignores cache API errors and reads R2', async () => {
    vi.stubGlobal('caches', { open: vi.fn().mockRejectedValue(new Error('Cache down')) });
    get.mockResolvedValue(object(snapshot()));
    expect(await inspectLandingVideo(env, id, url, waitUntil)).toHaveProperty('samplePreview', true);
    expect(load).not.toHaveBeenCalled();
  });

  it('creates a missing snapshot once, embeds displayed images, and preserves the original response', async () => {
    const live = inspection();
    const source = 'https://i.ytimg.com/vi/sample/hqdefault.jpg';
    live.video.thumbnails[0]!.url = source;
    if (live.channel.status === 'ready') live.channel.channel.thumbnails[0]!.url = source;
    if (live.comments.status === 'ready') live.comments.comments[0]!.author.thumbnails[0]!.url = source;
    load.mockResolvedValue(live);
    const fetch = vi.fn(async () => new Response('hello', { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await inspectLandingVideo(env, id, url, waitUntil);
    expect(result).toHaveProperty('samplePreview', true);
    expect(result.video.thumbnails[0]?.url).toBe(image);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(live.video.thumbnails[0]?.url).toBe(source);
    expect(put).toHaveBeenCalledWith(`landing-samples/v1/${id}.json`, expect.any(String), expect.objectContaining({ onlyIf: { etagDoesNotMatch: '*' } }));
    const persisted = JSON.parse(put.mock.calls[0]![1]);
    expect(persisted).not.toHaveProperty('quota');
    get.mockResolvedValue(object(persisted));
    await inspectLandingVideo(env, id, url, waitUntil);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns the winning snapshot after concurrent initialization', async () => {
    const live = inspection();
    live.video.thumbnails = [{ url: 'https://i.ytimg.com/image.jpg' }];
    if (live.channel.status === 'ready') live.channel.channel.thumbnails = [];
    if (live.comments.status === 'ready') live.comments.comments = [];
    load.mockResolvedValue(live);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello', { headers: { 'content-type': 'image/png' } })));
    put.mockResolvedValue(null);
    const winner = snapshot();
    winner.video.title = 'First saved result';
    get.mockResolvedValueOnce(null).mockResolvedValueOnce(object(winner));
    const result = await inspectLandingVideo(env, id, url, waitUntil);
    expect(result.video.title).toBe('First saved result');
  });

  it.each(['read failure', 'invalid snapshot', 'wrong video', 'external image'])('bypasses storage for YouTube fallback on %s', async (failure) => {
    if (failure === 'read failure') get.mockRejectedValue(new Error('R2 down'));
    if (failure === 'invalid snapshot') get.mockResolvedValue(object({}));
    if (failure === 'wrong video') get.mockResolvedValue(object(snapshot('abcdefghijk')));
    if (failure === 'external image') {
      const saved = snapshot();
      saved.video.thumbnails[0]!.url = 'https://i.ytimg.com/external.jpg';
      get.mockResolvedValue(object(saved));
    }
    expect(await inspectLandingVideo(env, id, url, waitUntil)).toEqual(inspection());
    expect(load).toHaveBeenCalledWith(env, id, true);
    expect(put).not.toHaveBeenCalled();
  });

  it('does not freeze a partial inspection', async () => {
    load.mockResolvedValue({ ...inspection(), partial: true, transcript: { status: 'unavailable' } });
    await inspectLandingVideo(env, id, url, waitUntil);
    expect(put).not.toHaveBeenCalled();
  });

  it.each(['https://example.com/image.jpg', 'https://i.ytimg.com.evil.test/image.jpg', 'http://i.ytimg.com/image.jpg'])('rejects unsafe image sources: %s', async (source) => {
    const live = inspection();
    live.video.thumbnails[0]!.url = source;
    load.mockResolvedValue(live);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await inspectLandingVideo(env, id, url, waitUntil)).toEqual(live);
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each(['too large', 'bad content type', 'unavailable', 'write failure'])('returns the normal inspection when capture fails: %s', async (failure) => {
    const live = inspection();
    live.video.thumbnails = [{ url: 'https://i.ytimg.com/image.jpg' }];
    if (live.channel.status === 'ready') live.channel.channel.thumbnails = [];
    if (live.comments.status === 'ready') live.comments.comments = [];
    load.mockResolvedValue(live);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(failure === 'too large' ? 'x'.repeat(256 * 1024 + 1) : 'hello', {
      status: failure === 'unavailable' ? 503 : 200,
      headers: { 'content-type': failure === 'bad content type' ? 'text/html' : 'image/png' },
    })));
    if (failure === 'write failure') put.mockRejectedValue(new Error('R2 down'));
    expect(await inspectLandingVideo(env, id, url, waitUntil)).toEqual(live);
    if (failure !== 'write failure') expect(put).not.toHaveBeenCalled();
  });

  it('leaves ordinary videos on the existing inspection path', async () => {
    await inspectLandingVideo(env, 'abcdefghijk', url, waitUntil);
    expect(load).toHaveBeenCalledWith(env, 'abcdefghijk');
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([`https://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}&t=30`, `https://youtube.com/shorts/${id}`])('recognizes pasted sample URLs and attaches quota after reading the snapshot: %s', async (target) => {
    get.mockResolvedValue(object(snapshot()));
    const response = await app.request('/v1/demo/youtube/inspect', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: target }),
    }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-demo-limit')).toBe('5');
    expect(await response.json()).toMatchObject({ samplePreview: true, quota: { limit: 5 }, video: { id } });
    expect(load).not.toHaveBeenCalled();
  });
});
