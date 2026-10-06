/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { inspectLandingVideo } from '../src/lib/landing-samples';
import { loadLandingInspection } from '../src/lib/landing-inspection';
import { inspection } from './fixtures/landing-inspection';

vi.mock('../src/lib/landing-inspection', () => ({ loadLandingInspection: vi.fn() }));
const bindings = env as Env;
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

test('native R2 and Cache API serve a complete sample without extraction', async () => {
  const id = 'bAX27XRHMH8';
  const key = `landing-samples/v1/${id}.json`;
  await bindings.VIDEO_ASSETS.put(key, JSON.stringify({ ...inspection(id), samplePreview: true }));
  const pending: Promise<unknown>[] = [];
  const result = await inspectLandingVideo(bindings, id, 'https://sample.test/inspect', work => { pending.push(work); });
  expect(result).toHaveProperty('samplePreview', true);
  await Promise.all(pending);
  await bindings.VIDEO_ASSETS.delete(key);
  const cached = await inspectLandingVideo(bindings, id, 'https://sample.test/inspect', work => { pending.push(work); });
  expect(cached).toEqual(result);
  expect(loadLandingInspection).not.toHaveBeenCalled();
});

test('initial capture stores embedded images and native R2 conditional writes prevent replacement', async () => {
  const id = 'eC7xzavzEKY';
  const live = inspection(id);
  const thumbnail = { url: 'https://i.ytimg.com/sample.jpg' };
  live.video.thumbnails = [thumbnail];
  if (live.channel.status === 'ready') live.channel.channel.thumbnails = [thumbnail];
  if (live.comments.status === 'ready') live.comments.comments[0]!.author.thumbnails = [thumbnail];
  vi.mocked(loadLandingInspection).mockResolvedValue(live);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // Exercise Workers' native request validation before supplying image bytes.
    new Request(input, init);
    return new Response('hello', { headers: { 'content-type': 'image/png' } });
  }));
  const pending: Promise<unknown>[] = [];
  const result = await inspectLandingVideo(bindings, id, 'https://sample.test/inspect', work => { pending.push(work); });
  await Promise.all(pending);
  expect(result).toHaveProperty('samplePreview', true);
  expect(result.video.thumbnails[0]?.url).toBe('data:image/png;base64,aGVsbG8=');
  const key = `landing-samples/v1/${id}.json`;
  expect(await (await bindings.VIDEO_ASSETS.get(key))?.json()).toEqual(result);
  expect(await bindings.VIDEO_ASSETS.put(key, 'replacement', { onlyIf: { etagDoesNotMatch: '*' } })).toBeNull();
  expect(await (await bindings.VIDEO_ASSETS.get(key))?.json()).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([301, 302, 303, 307, 308])('rejects image redirect %i without following it or saving an incomplete snapshot', async status => {
  const id = 'Vyb-sTrY_Y8';
  const live = inspection(id);
  live.video.thumbnails = [{ url: 'https://i.ytimg.com/redirect.jpg' }];
  if (live.channel.status === 'ready') live.channel.channel.thumbnails = [];
  if (live.comments.status === 'ready') live.comments.comments = [];
  vi.mocked(loadLandingInspection).mockResolvedValue(live);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe('manual');
    return new Response('redirect', { status, headers: {
      location: 'https://untrusted.example/image.jpg', 'content-type': 'image/png',
    } });
  }));
  const pending: Promise<unknown>[] = [];
  const result = await inspectLandingVideo(bindings, id, 'https://sample.test/inspect', work => { pending.push(work); });
  await Promise.all(pending);
  expect(result).toEqual(live);
  expect(await bindings.VIDEO_ASSETS.get(`landing-samples/v1/${id}.json`)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
