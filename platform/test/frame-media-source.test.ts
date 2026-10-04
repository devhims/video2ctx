import { readFile } from 'node:fs/promises';
import { getDetails } from '../../packages/all-things-youtube/src/index';
import { loadMediaCandidateGroup } from '../../packages/youtube-skills/src/watch/media';
import { createWorkerProxyTransport } from '../src/lib/youtube-worker-transport';
import { openYouTubeFrameSource } from '../src/lib/frame-media-source';
vi.mock('../../packages/all-things-youtube/src/index', () => ({ getDetails: vi.fn() }));
vi.mock('../../packages/youtube-skills/src/watch/media', () => ({ loadMediaCandidateGroup: vi.fn() }));
vi.mock('../src/lib/youtube-worker-transport', () => ({ createWorkerProxyTransport: vi.fn() }));
vi.mock('../src/lib/proxy-health', () => ({ normalizedProxyUrls: () => ['https://private-test-proxy.invalid'],
  planProxyOrder: async () => ({ order: [0] }), reportProxyOutcomes: vi.fn(async () => {}) }));
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
    const start = Number(range[1]), end = Number(range[2]);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  });
  vi.mocked(createWorkerProxyTransport).mockReturnValue({ fetch, close });
  return { fetch, close };
}
beforeEach(() => vi.clearAllMocks());
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
  expect(loadMediaCandidateGroup).not.toHaveBeenCalled();
});

test('does not replace an unsupported sharper source with a lower-resolution Media source', async () => {
  const { fetch } = await setup();
  vi.mocked(loadMediaCandidateGroup).mockResolvedValue({ profile: 'android', candidates: [
    { url: 'https://r1.googlevideo.com/high', formatId: 136, width: 1280, progressive: false, mimeType: 'video/mp4; codecs="avc1"' },
    { url: 'https://r1.googlevideo.com/low', formatId: 18, width: 640, progressive: true, mimeType: 'video/mp4; codecs="avc1"' },
  ] });
  fetch.mockImplementation(async () => new Response('', { status: 403 }));
  await expect(openYouTubeFrameSource(env, id, 1280, new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' });
  expect(fetch.mock.calls.every(([request]) => request instanceof Request && new URL(request.url).pathname === '/high')).toBe(true);
});
