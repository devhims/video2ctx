import { acquireFrameLease } from '../src/lib/frame-media-admission';

function setup(acquire: ReturnType<typeof vi.fn>) {
  const stub = { acquire, release: vi.fn(async () => {}), throttle: vi.fn(async () => {}) };
  const env = { MEDIA_FRAME_CAPACITY: { getByName: () => stub } } as unknown as Env;
  return { env, stub };
}
afterEach(() => vi.useRealTimers());

test('allows cold placement to use the full two-second admission budget', async () => {
  vi.useFakeTimers();
  const { env, stub } = setup(vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    return { admitted: true, retryAfterMs: 0 };
  }));
  const lease = acquireFrameLease(env, 'media-job', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1200);
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
  const { env, stub } = setup(vi.fn(async () => ({ admitted: false, retryAfterMs: 30000 })));
  await expect(acquireFrameLease(env, 'media-frame', new AbortController().signal)).rejects.toMatchObject({ code: 'capacity' });
  expect(stub.acquire).toHaveBeenCalledOnce();
});
