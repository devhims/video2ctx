import { describe, expect, it, vi } from 'vitest';
import { withRunDeadline } from '../src/agents/runtime/deadline';

describe('admission deadline', () => {
  it('uses the remaining admission budget, even for an operation that ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      vi.setSystemTime(start + 50_000);
      let signal!: AbortSignal;
      const run = withRunDeadline(start + 60_000, new AbortController().signal, async (s) => {
        signal = s;
        return new Promise(() => {});
      });
      const check = expect(run).rejects.toThrow('60-second deadline');
      await vi.advanceTimersByTimeAsync(10_000);
      await check;
      expect(signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('does not restart work after the admission deadline has expired', async () => {
    const work = vi.fn();
    await expect(withRunDeadline(Date.now() - 1, new AbortController().signal, work)).rejects.toThrow('60-second deadline');
    expect(work).not.toHaveBeenCalled();
  });

  it('preserves cancellation and aborts outstanding calls when work completes', async () => {
    const parent = new AbortController();
    parent.abort(new Error('Cancelled by user'));
    const work = vi.fn();
    await expect(withRunDeadline(Date.now() + 60_000, parent.signal, work)).rejects.toThrow('Cancelled by user');
    expect(work).not.toHaveBeenCalled();
    let signal!: AbortSignal;
    await withRunDeadline(Date.now() + 60_000, new AbortController().signal, async (s) => { signal = s; });
    expect(signal.aborted).toBe(true);
  });
});
