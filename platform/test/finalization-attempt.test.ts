import { withFinalizationAttempt } from '../src/agents/research/finalization-attempt';

it('ignores late provider progress after cancellation without throwing or restarting the idle clock', async () => {
  vi.useFakeTimers();
  try {
    const parent = new AbortController();
    let reportProgress!: () => void;
    const run = withFinalizationAttempt(Date.now() + 60_000, parent.signal, true, async (_signal, progress) => {
      reportProgress = progress;
      return new Promise(() => {});
    }).catch(error => error.message);
    await vi.advanceTimersByTimeAsync(1);
    parent.abort(new Error('Cancelled by user'));
    expect(await run).toBe('Cancelled by user');
    expect(() => reportProgress()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
