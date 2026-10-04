import { readFile } from 'node:fs/promises';
import { getDetails } from '../../packages/all-things-youtube/src/index';
import { loadMediaCandidateGroup } from '../../packages/youtube-skills/src/watch/media';
import { createWorkerProxyTransport } from '../src/lib/youtube-worker-transport';
import { openYouTubeFrameSources } from '../src/lib/frame-media-source';
import { reportProxyOutcomes, normalizedProxyUrls, planProxyOrder } from '../src/lib/proxy-health';
vi.mock('../../packages/all-things-youtube/src/index', () => ({ getDetails: vi.fn() }));
vi.mock('../../packages/youtube-skills/src/watch/media', () => ({ loadMediaCandidateGroup: vi.fn() }));
vi.mock('../src/lib/youtube-worker-transport', () => ({ createWorkerProxyTransport: vi.fn() }));
vi.mock('../src/lib/proxy-health', () => ({ normalizedProxyUrls: vi.fn(() => ['https://private-test-proxy.invalid']),
  planProxyOrder: vi.fn(async () => ({ order: [0] })), reportProxyOutcomes: vi.fn(async () => {}) }));
async function openYouTubeFrameSource(...args: Parameters<typeof openYouTubeFrameSources>) {
  const sources = openYouTubeFrameSources(...args);
  const next = await sources.next();
  if (next.done) throw new Error('No source');
  return { ...next.value, close: async () => { await sources.return(); } };
}
const env = {} as Env;
const id = 'abcdefghijk';
async function setup() {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/media/indexed.mp4', import.meta.url)));
  vi.mocked(getDetails).mockResolvedValue({ isLive: false } as Awaited<ReturnType<typeof getDetails>>);
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({ profile: 'android', candidates: [{ url: 'https://r1.googlevideo.com/videoplayback?secret=never-log',
    progressive: true, formatId: 18, mimeType: 'video/mp4; codecs="avc1"', width: 64, height: 48 }] });
  const close = vi.fn(async () => {});
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(_input instanceof Request ? _input.headers : init?.headers).get('range')!)!;
    const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  });
  vi.mocked(createWorkerProxyTransport).mockReturnValue({ fetch, close });
  return { fetch, close };
}
beforeEach(() => vi.clearAllMocks());
test.each(['indexed', 'fragmented', 'fragmented-edit'])('prepares %s from one bounded prefix read', async name => {
  const { fetch } = await setup();
  const bytes = new Uint8Array(await readFile(new URL(`./fixtures/media/${name}.mp4`, import.meta.url)));
  fetch.mockImplementation(async input => {
    const range = /^bytes=(\d+)-(\d+)$/.exec((input as Request).headers.get('range')!)!;
    const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  });
  const source = await openYouTubeFrameSource(env, id, 640, new AbortController().signal);
  expect(fetch).toHaveBeenCalledOnce();
  expect((fetch.mock.calls[0]![0] as Request).headers.get('range')).toBe('bytes=0-65535');
  expect((await source.clip(2.5)).bytes.length).toBeGreaterThan(0);
  await source.close();
});
test('reads all media through the selected proxy and requires precise byte ranges', async () => {
  const { fetch, close } = await setup();
  const source = await openYouTubeFrameSource(env,id,640,new AbortController().signal);
  expect((await source.clip(2.5)).time).toBeCloseTo(0.5);
  expect(fetch.mock.calls.every(([request]) => request instanceof Request && request.redirect === 'manual')).toBe(true);
  await source.close(); expect(close).toHaveBeenCalledOnce();
});
test.each([200,302,403,429])('rejects HTTP %s without reading the media body', async status => {
  const { fetch, close } = await setup(); const canceled = vi.fn();
  fetch.mockImplementation(async () => new Response(new ReadableStream({ cancel: canceled }),{status}));
  await expect(openYouTubeFrameSource(env,id,640,new AbortController().signal)).rejects.toMatchObject({code:'unsupported'});
  expect(canceled).toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});
test('rejects signed URLs outside the known media host before any media fetch', async () => {
  const { fetch } = await setup();
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({profile:'android', candidates:[{url:'http://127.0.0.1/admin',progressive:true,mimeType:'video/mp4; codecs="avc1"'}]});
  await expect(openYouTubeFrameSource(env,id,640,new AbortController().signal)).rejects.toMatchObject({code:'unsupported'});
  expect(fetch).not.toHaveBeenCalled();
});
test('uncertain broadcasts retain the existing FFmpeg verification path', async () => {
  const { fetch } = await setup();
  vi.mocked(getDetails).mockResolvedValue({ isLive: true } as Awaited<ReturnType<typeof getDetails>>);
  await expect(openYouTubeFrameSource(env,id,640,new AbortController().signal)).rejects.toMatchObject({code:'unsupported'});
  expect(fetch).not.toHaveBeenCalled();
});

test('prefers the sharper supported candidate over progressive 360p', async () => {
  await setup();
  const candidate = { url: 'https://r1.googlevideo.com/videoplayback', mimeType: 'video/mp4; codecs="avc1"' };
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({ profile: 'android', candidates: [
    { ...candidate, formatId: 136, width: 1280, height: 720, progressive: false },
    { ...candidate, formatId: 18, width: 640, height: 360, progressive: true },
  ] });
  const source = await openYouTubeFrameSource(env, id, 1280, new AbortController().signal);
  expect(source.formatId).toBe(136);
  expect(vi.mocked(loadMediaCandidateGroup).mock.calls[0]![4]).toBe(true);
  await source.close();
});

test('records safe source stages without provider messages or URLs', async () => {
  await setup();
  vi.mocked(getDetails).mockRejectedValue(Object.assign(new Error('https://private.invalid/?secret=never-log'), { code: 'AUTH_REQUIRED' }));
  const record = vi.fn();
  await expect(openYouTubeFrameSource(env, id, 640, new AbortController().signal, record)).rejects.toMatchObject({ code: 'unsupported' });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ stage: 'player', outcome: 'error', code: 'AUTH_REQUIRED' }));
  expect(JSON.stringify(record.mock.calls)).not.toContain('never-log');
  expect(loadMediaCandidateGroup).toHaveBeenCalledOnce();
});

test('recovers a blocked sharper source with a progressive source', async () => {
  const { fetch } = await setup();
  const read = fetch.getMockImplementation()!;
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({ profile: 'android', candidates: [
    { url: 'https://r1.googlevideo.com/high', formatId: 136, width: 1280, progressive: false, mimeType: 'video/mp4; codecs="avc1"' },
    { url: 'https://r1.googlevideo.com/low', formatId: 18, width: 640, progressive: true, mimeType: 'video/mp4; codecs="avc1"' },
  ] });
  fetch.mockImplementation(async (request, init) => new URL((request as Request).url).pathname === '/high'
    ? new Response('', { status: 403 }) : read(request, init));
  const source = await openYouTubeFrameSource(env, id, 1280, new AbortController().signal);
  expect(source.formatId).toBe(18);
  expect((await source.clip(2.5)).bytes.length).toBeGreaterThan(0);
  await source.close();
});

test('opening an index alone does not mark a proxy healthy', async () => {
  await setup();
  const source = await openYouTubeFrameSource(env, id, 640, new AbortController().signal);
  await source.close();
  expect(vi.mocked(reportProxyOutcomes).mock.calls.flatMap(call => call[2])).not.toContainEqual({ slot: 0, outcome: 'success' });
});

test('reuses the source player live flag instead of fetching unrelated video metadata', async () => {
  await setup();
  const group = await vi.mocked(loadMediaCandidateGroup).getMockImplementation()!(1, id, 640, {});
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({ ...group!, isLive: false });
  const source = await openYouTubeFrameSource(env, id, 640, new AbortController().signal);
  expect(getDetails).not.toHaveBeenCalled();
  await source.close();
});
test('a live source player is rejected before media bytes or secondary metadata are fetched', async () => {
  const { fetch } = await setup();
  const group = await vi.mocked(loadMediaCandidateGroup).getMockImplementation()!(1, id, 640, {});
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({ ...group!, isLive: true });
  await expect(openYouTubeFrameSource(env, id, 640, new AbortController().signal)).rejects.toMatchObject({code:'unsupported'});
  expect(fetch).not.toHaveBeenCalled();
  expect(getDetails).not.toHaveBeenCalled();
});


test('confirmed bot challenges are redacted, cooled, and can reach the fourth route', async () => {
  const { close } = await setup();
  const group = await vi.mocked(loadMediaCandidateGroup).getMockImplementation()!(1, id, 640, {});
  vi.mocked(normalizedProxyUrls).mockReturnValue(['https://one.test', 'https://two.test', 'https://three.test', 'https://four.test']);
  vi.mocked(planProxyOrder).mockResolvedValue({ order: [0, 1, 2, 3] } as Awaited<ReturnType<typeof planProxyOrder>>);
  let calls = 0;
  vi.mocked(loadMediaCandidateGroup).mockImplementation(async (_profile, _video, _width, _options, _prefer, diagnostic) => {
    calls++;
    if (calls < 4) {
      diagnostic?.({ stage: 'player_response', playabilityStatus: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot secret=never-log" });
      return undefined;
    }
    return group;
  });
  const record = vi.fn();
  const source = await openYouTubeFrameSource(env, id, 640, new AbortController().signal, record);
  expect(source.slot).toBe(3);
  await source.clip(2.5);
  await source.close();
  expect(close).toHaveBeenCalledTimes(4);
  expect(vi.mocked(reportProxyOutcomes).mock.calls.flatMap(call => call[2])).toEqual([
    { slot: 0, outcome: 'rate_limited' }, { slot: 1, outcome: 'rate_limited' },
    { slot: 2, outcome: 'rate_limited' }, { slot: 3, outcome: 'success' },
  ]);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ failureReason: 'bot_challenge', proxySlot: 0 }));
  expect(JSON.stringify(record.mock.calls)).not.toContain('never-log');
});

test('tries progressive recovery before spending its source attempts on more adaptive formats', async () => {
  await setup();
  vi.mocked(normalizedProxyUrls).mockReturnValue(['https://one.test']);
  vi.mocked(planProxyOrder).mockResolvedValue({ order: [0] } as Awaited<ReturnType<typeof planProxyOrder>>);
  const base = { url: 'https://r1.googlevideo.com/video', mimeType: 'video/mp4; codecs="avc1"', progressive: false };
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({ profile: 'android', isLive: false, candidates: [
    { ...base, formatId: 136, width: 1280 }, { ...base, formatId: 135, width: 854 },
    { ...base, formatId: 134, width: 640 }, { ...base, formatId: 18, width: 640, progressive: true },
  ] });
  const sources = openYouTubeFrameSources(env, id, 1280, new AbortController().signal);
  expect((await sources.next()).value).toMatchObject({ formatId: 136 });
  expect((await sources.next()).value).toMatchObject({ formatId: 18 });
  await sources.return();
});
