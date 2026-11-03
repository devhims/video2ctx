import { acquireFrameLease } from '../src/lib/frame-media-admission';

function setup(acquire: ReturnType<typeof vi.fn>) {
  const stub = { acquire, release: vi.fn(async () => {}), throttle: vi.fn(async () => {}) };
  const env = { MEDIA_FRAME_CAPACITY: { getByName: () => stub } } as unknown as Env;
  return { env, stub };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('accepts a delayed first batch grant without retrying or bypassing admission', async () => {
  const { env, stub } = setup(vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 2618));
    return { admitted: true, retryAfterMs: 0 };
  }));
  const lease = acquireFrameLease(env, 'media-job', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2618);
  await (await lease).release();
  expect(stub.acquire).toHaveBeenCalledOnce();
  expect(stub.release).toHaveBeenCalledOnce();
});

test('caller cancellation fails closed without freeing an uncertain remote lease', async () => {
  const { env, stub } = setup(vi.fn(() => new Promise(() => {})));
  const caller = new AbortController();
  const lease = acquireFrameLease(env, 'media-job', caller.signal);
  caller.abort(new Error('Canceled'));
  await expect(lease).rejects.toThrow('Canceled');
  expect(stub.release).not.toHaveBeenCalled();
});

test('a shared cooldown exceeding the budget does not retry admission', async () => {
  const { env, stub } = setup(vi.fn(async () => ({ admitted: false, denial: 'cooldown', retryAfterMs: 30000 })));
  const observe = vi.fn();
  await expect(acquireFrameLease(env, 'media-frame', new AbortController().signal, 2000, observe)).rejects.toMatchObject({ code: 'capacity' });
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ admissionState: 'refused', lastDenial: 'cooldown', retryAfterMs: 30000 }));
  expect(stub.acquire).toHaveBeenCalledOnce();
});

test.each(['media-job', 'media-frame'] as const)('a refused %s and its retry share the original deadline', async kind => {
  const { env, stub } = setup(vi.fn()
    .mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 900));
      return { admitted: false, retryAfterMs: 250, denial: 'active_limit' };
    })
    .mockImplementation(() => new Promise(() => {})));
  const observe = vi.fn();
  const pending = acquireFrameLease(env, kind, new AbortController().signal, 2000, observe);
  const failed = expect(pending).rejects.toMatchObject({ code: 'capacity' });
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ admissionState: 'rpc_timeout', lastDenial: 'active_limit', rpcAttempts: 2, rpcMs: 1750 }));
  expect(stub.acquire).toHaveBeenCalledTimes(2);
  expect(stub.release).not.toHaveBeenCalled();
});


test.each([
  ['media-job', 4000], ['media-frame', 2000], ['ffmpeg-job', 2000],
] as const)('bounds an unanswered initial %s RPC at %i ms', async (kind, timeoutMs) => {
  const { env, stub } = setup(vi.fn(() => new Promise(() => {})));
  const observe = vi.fn();
  const failed = expect(acquireFrameLease(env, kind, new AbortController().signal, 2000, observe))
    .rejects.toMatchObject({ code: 'capacity' });
  await vi.advanceTimersByTimeAsync(timeoutMs - 1);
  expect(observe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await failed;
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ admissionState: 'rpc_timeout', rpcAttempts: 1, rpcMs: timeoutMs }));
  expect(stub.release).not.toHaveBeenCalled();
});

test('a late batch refusal does not start a new attempt during reply grace', async () => {
  const { env, stub } = setup(vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 2618));
    return { admitted: false, denial: 'active_limit', retryAfterMs: 250 };
  }));
  const observe = vi.fn();
  const failed = expect(acquireFrameLease(env, 'media-job', new AbortController().signal, 2000, observe))
    .rejects.toMatchObject({ code: 'capacity' });
  await vi.advanceTimersByTimeAsync(2618);
  await failed;
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ admissionState: 'refused', lastDenial: 'active_limit', rpcAttempts: 1 }));
  expect(stub.acquire).toHaveBeenCalledOnce();
});

test('an earlier parent deadline ends first-grant grace', async () => {
  const { env, stub } = setup(vi.fn(() => new Promise(() => {})));
  const observe = vi.fn();
  const failed = expect(acquireFrameLease(env, 'media-job', AbortSignal.timeout(2200), 2000, observe))
    .rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(2200);
  await failed;
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ admissionState: 'canceled', rpcMs: 2200, rpcAttempts: 1 }));
  expect(stub.release).not.toHaveBeenCalled();
});
