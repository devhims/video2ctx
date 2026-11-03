import { extractionEventSchema } from '../src/lib/extraction-diagnostics';
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
test('recovers a redirected picture range on the same proxy without changing the clip or resetting the batch budget', async () => {
  const { fetch } = await setup();
  vi.mocked(normalizedProxyUrls).mockReturnValueOnce(['https://one.test', 'https://two.test', 'https://three.test']);
  vi.mocked(planProxyOrder).mockResolvedValueOnce({ order: [2] } as Awaited<ReturnType<typeof planProxyOrder>>);
  const fixture = await readFile(new URL('./fixtures/media/indexed.mp4', import.meta.url));
  // Keep the index in the prefix, move the actual picture bytes outside it.
  const padding = Buffer.alloc(65536);
  padding.writeUInt32BE(padding.length); padding.write('free', 4);
  const mdat = fixture.indexOf('mdat') - 4;
  const offsets = fixture.indexOf('stco') + 8;
  for (let i = 0; i < fixture.readUInt32BE(offsets); i++) {
    const at = offsets + 4 + i * 4;
    fixture.writeUInt32BE(fixture.readUInt32BE(at) + padding.length, at);
  }
  const file = Buffer.concat([fixture.subarray(0, mdat), padding, fixture.subarray(mdat)]);
  const target = 'https://r2.googlevideo.com/videoplayback?token=never-log';
  let redirect = false;
  fetch.mockImplementation(async input => {
    const request = input as Request;
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range')!)!;
    if (redirect && Number(first) > 0 && request.url !== target)
      return new Response(null, { status: 302, headers: { location: target } });
    const end = Math.min(Number(last), file.length - 1);
    return new Response(file.subarray(Number(first), end + 1), { status: 206,
      headers: { 'content-range': `bytes ${first}-${end}/${file.length}` } });
  });
  const record = vi.fn();
  const source = await openYouTubeFrameSource(env, id, 640, new AbortController().signal, record);
  const control = await source.clip(2.5);
  redirect = true;
  for (let i = 0; i < 6; i++) expect(await source.clip(2.5)).toEqual(control);
  await expect(source.clip(2.5)).rejects.toMatchObject({ code: 'source' });
  expect(createWorkerProxyTransport).toHaveBeenCalledTimes(1);
  const requests = fetch.mock.calls.map(([request]) => request as Request);
  const forwarded = requests.filter(request => request.url === target);
  expect(forwarded).toHaveLength(6);
  for (const next of forwarded) {
    const before = requests[requests.indexOf(next) - 1]!;
    expect(next.headers.get('range')).toBe(before.headers.get('range'));
    expect(next.redirect).toBe('manual');
  }
  const http = record.mock.calls.map(([event]) => event).filter(event => event.stage === 'media_http');
  expect(new Set(http.map(event => event.proxySlot))).toEqual(new Set([2]));
  expect(new Set(http.map(event => event.redirectAction))).toEqual(new Set([undefined, 'followed', 'response', 'limit']));
  expect(JSON.stringify(record.mock.calls)).not.toContain('never-log');
  await source.close();
});

test.each(['http://r2.googlevideo.com/videoplayback', 'https://r2.googlevideo.com.evil.test/videoplayback',
  'https://user@r2.googlevideo.com/videoplayback', 'https://r2.googlevideo.com:8443/videoplayback',
  '/login', '#loop'])('rejects an unsafe or self redirect (%s)', async location => {
  const { fetch } = await setup();
  fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location } }));
  const record = vi.fn();
  await expect(openYouTubeFrameSource(env, id, 640, new AbortController().signal, record)).rejects.toMatchObject({ code: 'unsupported' });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ redirectAction: 'blocked' }));
  expect(fetch.mock.calls.every(([request]) => (request as Request).url.startsWith('https://r1.googlevideo.com/videoplayback?'))).toBe(true);
});

test.each([302, 403, 200, 206])('rejects a second hop, denial, full body or mismatched range after a redirect (%s)', async status => {
  const { fetch } = await setup(), cancel = vi.fn();
  fetch.mockImplementation(async input => (input as Request).url.includes('second')
    ? new Response(new ReadableStream({ cancel }), { status, headers: { location: '?third', 'content-range': 'bytes 8-12/15' } })
    : new Response(null, { status: 302, headers: { location: '?second' } }));
  await expect(openYouTubeFrameSource(env, id, 640, new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' });
  expect(cancel).toHaveBeenCalled();
  expect(fetch.mock.calls.some(([r]) => (r as Request).url.includes('third'))).toBe(false);
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

test.each([true, undefined])('a confirmed live video stops all proxy discovery (player flag %s)', async isLive => {
  const { fetch, close } = await setup();
  vi.mocked(normalizedProxyUrls).mockReturnValue(['https://one.test', 'https://two.test', 'https://three.test', 'https://four.test']);
  vi.mocked(planProxyOrder).mockResolvedValue({ order: [0,1,2,3] } as Awaited<ReturnType<typeof planProxyOrder>>);
  const group = await vi.mocked(loadMediaCandidateGroup).getMockImplementation()!(1, id, 640, {});
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({ ...group!, isLive });
  vi.mocked(getDetails).mockResolvedValue({ isLive: true } as Awaited<ReturnType<typeof getDetails>>);
  await expect(openYouTubeFrameSource(env, id, 640, new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' });
  expect(loadMediaCandidateGroup).toHaveBeenCalledOnce();
  expect(createWorkerProxyTransport).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});


test('retains the precise sample guard and count in the stored projection for progressive input', async () => {
  const { fetch } = await setup();
  const bytes = Buffer.from(await readFile(new URL('./fixtures/media/indexed.mp4', import.meta.url)));
  bytes.writeUInt32BE(50001, bytes.indexOf('stsz') + 12);
  fetch.mockImplementation(async () => new Response(bytes, { status: 206,
    headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` } }));
  const record = vi.fn();
  await expect(openYouTubeFrameSource(env, id, 640, new AbortController().signal, record)).rejects.toMatchObject({ code: 'unsupported' });
  const events = record.mock.calls.map(([event]) => extractionEventSchema.parse(event));
  expect(events).toContainEqual(expect.objectContaining({ stage: 'media_source', formatId: 18, mp4Guard: 'track_samples',
    trackKind: 'video', declaredCount: 50001 }));
});
