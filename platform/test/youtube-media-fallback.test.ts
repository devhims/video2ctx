import { getVideoFrames } from '../src/lib/youtube-frames';
import { getYouTubeMediaFrames } from '../src/lib/youtube-media-frames';
import { acquireFrameLease } from '../src/lib/frame-media-admission';
vi.mock('../src/lib/youtube-media-frames', () => ({ getYouTubeMediaFrames: vi.fn() }));
vi.mock('../src/lib/frame-media-admission', () => ({ acquireFrameLease: vi.fn() }));
const input = { videoId: 'abcdefghijk', timestampsMs: [1000,2000], maxWidth: 640 };
const frame = (timestampMs: number) => ({ timestampMs, mimeType: 'image/jpeg' as const, width: 640, height: 360, imageBase64: '/9j/2Q==' });
function setup() {
  const release = vi.fn(async () => {});
  vi.mocked(acquireFrameLease).mockResolvedValue({ release, throttle: async () => {} });
  const requests: Array<{ timestampsMs: number[]; extractionTimeoutMs: number }> = [];
  const fetch = vi.fn(async (request: Request) => {
    const body = await request.json() as { timestampsMs: number[]; extractionTimeoutMs: number };
    requests.push(body);
    return Response.json({ value: { videoId: input.videoId, frames: body.timestampsMs.map(frame), failures: [], meta: { partial: false, warnings: [] } } });
  });
  const env = { YOUTUBE_FRAMES_BACKEND: 'media', YOUTUBE_FRAMES: { idFromName: (name: string) => name, get: () => ({ fetch }) } } as unknown as Env;
  return { env, fetch, release, requests };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
test('fully successful Media extraction never starts FFmpeg', async () => {
  const { env, fetch } = setup();
  vi.mocked(getYouTubeMediaFrames).mockResolvedValue({ frames: input.timestampsMs.map(frame) });
  expect((await getVideoFrames(env,input)).frames).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(acquireFrameLease).not.toHaveBeenCalled();
});
test('FFmpeg receives only missing timestamps and the remaining budget', async () => {
  const { env, fetch, release, requests } = setup();
  vi.mocked(getYouTubeMediaFrames).mockResolvedValue({ frames: [frame(1000)], reason: 'unsupported' });
  const result = await getVideoFrames(env,input);
  expect(result.frames.map(f => f.timestampMs)).toEqual([1000,2000]);
  expect(result.meta.partial).toBe(false);
  expect(requests[0]!.timestampsMs).toEqual([2000]);
  expect(requests[0]!.extractionTimeoutMs).toBeLessThanOrEqual(45000);
  expect(fetch).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
});
test('fallback failure preserves completed frames as explicit partial coverage', async () => {
  const { env, fetch } = setup();
  vi.mocked(getYouTubeMediaFrames).mockResolvedValue({ frames: [frame(1000)], reason: 'unsupported' });
  fetch.mockResolvedValue(Response.json({ error: { code: 'PROCESSOR_BUSY', message: 'Busy' } }, { status: 503 }));
  const result = await getVideoFrames(env,input);
  expect(result.frames.map(f => f.timestampMs)).toEqual([1000]);
  expect(result.failures.map(f => f.timestampMs)).toEqual([2000]);
  expect(result.meta.partial).toBe(true);
});
test('caller cancellation prevents fallback dispatch', async () => {
  const { env, fetch } = setup(); const controller = new AbortController();
  vi.mocked(getYouTubeMediaFrames).mockImplementation(async () => { controller.abort(new Error('Canceled')); return { frames: [] }; });
  await expect(getVideoFrames(env,input,controller.signal)).rejects.toThrow('Canceled');
  expect(fetch).not.toHaveBeenCalled();
});

test('elapsed Media and admission time is subtracted from the fallback budget', async () => {
  const { env, requests } = setup();
  let now = 100000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(getYouTubeMediaFrames).mockImplementation(async () => { now += 18000; return { frames: [] }; });
  vi.mocked(acquireFrameLease).mockImplementation(async () => {
    now += 1000;
    return { release: async () => {}, throttle: async () => {} };
  });
  await getVideoFrames(env, input);
  expect(requests[0]!.extractionTimeoutMs).toBe(26000);
});
test('short budgets go directly to FFmpeg', async () => {
  const { env, requests } = setup();
  await getVideoFrames(env, input, undefined, { extractionTimeoutMs: 10000 });
  expect(getYouTubeMediaFrames).not.toHaveBeenCalled();
  expect(requests[0]!.extractionTimeoutMs).toBeLessThanOrEqual(10000);
});
