import { withFinalizationAttempt } from '../src/agents/research/finalization-attempt';

it('honors user cancellation even when the provider ignores its signal', async () => {
  vi.useFakeTimers();
  try {
    const parent = new AbortController();
    const run = withFinalizationAttempt(Date.now() + 60_000, parent.signal, async () => {
      return new Promise(() => {});
    }).catch(error => error.message);
    await vi.advanceTimersByTimeAsync(1);
    parent.abort(new Error('Cancelled by user'));
    expect(await run).toBe('Cancelled by user');
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('enforces the overall deadline even when the provider ignores its signal', async () => {
  vi.useFakeTimers();
  try {
    let finished = false;
    const run = withFinalizationAttempt(Date.now() + 60_000, new AbortController().signal, async () => new Promise(() => {}))
      .catch(error => error.message).finally(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBe('Finalization attempt timeout.');
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
