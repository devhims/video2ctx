import { getYouTubeMediaFrames } from '../src/lib/youtube-media-frames';
import { openYouTubeFrameSources } from '../src/lib/frame-media-source';
import { acquireFrameLease } from '../src/lib/frame-media-admission';
import { FrameMediaError } from '../src/lib/frame-media-io';

vi.mock('../src/lib/frame-media-source', () => ({ openYouTubeFrameSources: vi.fn() }));
vi.mock('../src/lib/frame-media-admission', () => ({ acquireFrameLease: vi.fn() }));
const input = { videoId: 'abcdefghijk', timestampsMs: [1000, 2000, 3000], maxWidth: 640 };
const jpeg = new Uint8Array([255,216,255,192,0,17,8,0,48,0,64,3,1,17,0,2,17,0,3,17,0,255,217]);

function setup(response = vi.fn(async () => new Response(jpeg))) {
  const close = vi.fn(async () => {}), clip = vi.fn(async (time: number) => ({ bytes: new Uint8Array([1,2,3]), time: time % 1, duration: 1 }));
  const source = { duration: 60, width: 640, height: 360, clip, slot: 0,
    profile: 'android' as const, formatId: 18, bytesRead: 500 };
  vi.mocked(openYouTubeFrameSources).mockImplementation(async function* () { try { yield source; } finally { await close(); } });
  const leases: Array<{ kind: string; release: ReturnType<typeof vi.fn>; throttle: ReturnType<typeof vi.fn> }> = [];
  vi.mocked(acquireFrameLease).mockImplementation(async (_env, kind) => {
    const lease = { kind, release: vi.fn(async () => {}), throttle: vi.fn(async () => {}) };
    leases.push(lease); return lease;
  });
  const output = vi.fn(() => ({ response }));
  const env = { MEDIA: { input: vi.fn(() => ({ transform: vi.fn(() => ({ output })) })) } } as unknown as Env;
  return { env, response, close, clip, leases, output, source };
}

beforeEach(() => vi.clearAllMocks());

test('decodes at most two frames at a time and publishes each completed frame', async () => {
  let active = 0, peak = 0;
  const response = vi.fn(async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return new Response(jpeg); });
  const { env, leases, close } = setup(response), diagnostic = vi.fn(), ready = vi.fn();
  const six = { ...input, timestampsMs: [1000, 2000, 3000, 4000, 5000, 6000] };
  const result = await getYouTubeMediaFrames(env, six, new AbortController().signal, diagnostic, ready);
  expect(result.frames.map(f => f.timestampMs)).toEqual(six.timestampsMs);
  expect(peak).toBe(2);
  expect(ready).toHaveBeenCalledTimes(6);
  expect(ready.mock.calls.map(([frame]) => frame.timestampMs).sort((a, b) => a - b)).toEqual(six.timestampsMs);
  expect(close).toHaveBeenCalledOnce();
  expect(leases).toHaveLength(7);
  expect(leases.every(lease => lease.release.mock.calls.length === 1)).toBe(true);
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ backend: 'media', outcome: 'success' }));
});

test('retains completed frames when another timestamp cannot be clipped', async () => {
  const { env, clip } = setup();
  clip.mockImplementation(async time => {
    if (time === 2) throw new FrameMediaError('unsupported');
    return { bytes: new Uint8Array([1]), time: 0, duration: 1 };
  });
  expect((await getYouTubeMediaFrames(env, input, new AbortController().signal)).frames.map(f => f.timestampMs)).toEqual([1000]);
});

test('9423 cools shared admission and prevents further dispatch', async () => {
  const { env, leases, response } = setup(vi.fn(async () => { throw Object.assign(new Error('untrusted provider details'), { code: 9423 }); }));
  const diagnostic = vi.fn();
  const result = await getYouTubeMediaFrames(env, input, new AbortController().signal, diagnostic);
  expect(result.reason).toBe('throttled');
  expect(response.mock.calls.length).toBeLessThanOrEqual(3);
  expect(leases.some(lease => lease.throttle.mock.calls.length === 1)).toBe(true);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('untrusted');
});

test('a canceled uncooperative Media call leaves its capacity leased until expiry', async () => {
  const { env, leases, response, close } = setup(vi.fn(() => new Promise<Response>(() => {})));
  const controller = new AbortController();
  const result = getYouTubeMediaFrames(env, { ...input, timestampsMs: [1000] }, controller.signal);
  await vi.waitFor(() => expect(response).toHaveBeenCalledOnce());
  controller.abort();
  expect((await result).frames).toEqual([]);
  expect(leases.find(lease => lease.kind === 'media-frame')!.release).not.toHaveBeenCalled();
  expect(leases.find(lease => lease.kind === 'media-job')!.release).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

test('admission failure does not resolve or download a source', async () => {
  const { env } = setup();
  vi.mocked(acquireFrameLease).mockRejectedValue(new FrameMediaError('capacity'));
  expect((await getYouTubeMediaFrames(env, input, new AbortController().signal)).reason).toBe('capacity');
  expect(openYouTubeFrameSources).not.toHaveBeenCalled();
});


test('a failed source recovers only missing frames after the old batch settles', async () => {
  const { env, source, leases } = setup();
  const oldClosed = vi.fn(), ready = vi.fn(), fallbackClip = vi.fn(async (time: number) => source.clip(time));
  const first = { ...source, width: 1280, height: 720, formatId: 136, clip: async (time: number) => {
    if (time !== 1) throw new FrameMediaError('source');
    return source.clip(time);
  } };
  vi.mocked(openYouTubeFrameSources).mockImplementation(async function* () {
    yield first;
    oldClosed();
    yield { ...source, clip: async (time: number) => {
      expect(oldClosed).toHaveBeenCalledOnce();
      return fallbackClip(time);
    } };
  });
  const result = await getYouTubeMediaFrames(env, input, new AbortController().signal, undefined, ready);
  expect(result.frames.map(frame => [frame.timestampMs, frame.sourceHeight])).toEqual([[1000, 720], [2000, 360], [3000, 360]]);
  expect(fallbackClip.mock.calls.map(([time]) => time).sort()).toEqual([2, 3]);
  expect(ready).toHaveBeenCalledTimes(3);
  expect(leases.filter(lease => lease.kind === 'media-frame')).toHaveLength(3);
});

test('failed sources are bounded to three, even if more are available', async () => {
  const { env, source } = setup();
  let sources = 0;
  const closed = vi.fn();
  vi.mocked(openYouTubeFrameSources).mockImplementation(async function* () {
    try {
      for (let i = 0; i < 10; i++) { sources++; yield { ...source, clip: async () => { throw new FrameMediaError('source'); } }; }
    } finally { closed(); }
  });
  expect((await getYouTubeMediaFrames(env, input, new AbortController().signal)).frames).toEqual([]);
  expect(sources).toBe(3);
  expect(closed).toHaveBeenCalledOnce();
});

test.each([new TypeError('fetch failed'), new DOMException('range deadline', 'TimeoutError')])('recovers a source transport failure: %s', async error => {
  const { env, source } = setup();
  const recovery = vi.fn(async (time: number) => source.clip(time)), diagnostic = vi.fn();
  vi.mocked(openYouTubeFrameSources).mockImplementation(async function* () {
    yield { ...source, clip: async () => { throw error; } };
    yield { ...source, clip: recovery };
  });
  const result = await getYouTubeMediaFrames(env, input, new AbortController().signal, diagnostic);
  expect(result.frames.map(frame => frame.timestampMs)).toEqual(input.timestampsMs);
  expect(recovery).toHaveBeenCalledTimes(3);
  expect(diagnostic.mock.calls[0]![0].events).toContainEqual(expect.objectContaining({ stage: 'media_source', outcome: 'error' }));
});

test('source exhaustion preserves the transport failure reason', async () => {
  const { env, source } = setup();
  vi.mocked(openYouTubeFrameSources).mockImplementation(async function* () {
    yield { ...source, clip: async () => { throw new FrameMediaError('source'); } };
    throw new FrameMediaError('unsupported');
  });
  expect((await getYouTubeMediaFrames(env, input, new AbortController().signal)).reason).toBe('source');
});

test('a rejected clip does not stop unrelated timestamps on the same source', async () => {
  const { env, response } = setup();
  response.mockResolvedValueOnce(new Response(null, { status: 422 }));
  const six = { ...input, timestampsMs: [1000,2000,3000,4000,5000,6000] };
  const result = await getYouTubeMediaFrames(env, six, new AbortController().signal);
  expect(result.frames.map(frame => frame.timestampMs)).toEqual([2000,3000,4000,5000,6000]);
  expect(response).toHaveBeenCalledTimes(6);
});

test('a service failure stops remaining decode work instead of retrying sources', async () => {
  const { env, source, response } = setup(vi.fn(async () => new Response(null, { status: 503 })));
  const alternate = vi.fn(async (time: number) => source.clip(time));
  vi.mocked(openYouTubeFrameSources).mockImplementation(async function* () { yield source; yield { ...source, clip: alternate }; });
  const result = await getYouTubeMediaFrames(env, { ...input, timestampsMs: [1000,2000,3000,4000,5000,6000] }, new AbortController().signal);
  expect(result.reason).toBe('decode');
  expect(response).toHaveBeenCalledTimes(2);
  expect(alternate).not.toHaveBeenCalled();
});

test('caller cancellation during source reads never tries the alternate source', async () => {
  const { env, source } = setup();
  const controller = new AbortController(), alternate = vi.fn(async (time: number) => source.clip(time));
  vi.mocked(openYouTubeFrameSources).mockImplementation(async function* () {
    yield { ...source, clip: async () => { controller.abort(); throw controller.signal.reason; } };
    yield { ...source, clip: alternate };
  });
  expect((await getYouTubeMediaFrames(env, input, controller.signal)).frames).toEqual([]);
  expect(alternate).not.toHaveBeenCalled();
});
