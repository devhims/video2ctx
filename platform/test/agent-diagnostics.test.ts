import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeAgentOperation } from '../src/agents/runtime/diagnostics';
import { withRunDeadline } from '../src/agents/runtime/deadline';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('agent failure diagnostics', () => {
  it('records cancellation even when the provider never settles', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = withRunDeadline(Date.now() + 20, new AbortController().signal, signal =>
      observeAgentOperation({ runId: 'run', videoId: 'video', stage: 'model_attempt' }, signal,
        () => new Promise(() => {})), 'Research phase timeout.');
    const rejected = expect(result).rejects.toThrow('Research phase timeout.');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toEqual([
      expect.objectContaining({ outcome: 'started', stage: 'model_attempt' }),
      expect.objectContaining({ outcome: 'canceled', cancellationReason: 'research_deadline', elapsedMs: 20 }),
    ]);
  });

  it('preserves status and retryability without logging provider bodies or credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = Object.assign(new Error('secret transcript'), {
      statusCode: 429, isRetryable: true, responseBody: 'secret token',
      responseHeaders: { authorization: 'secret' },
    });
    await expect(observeAgentOperation({ stage: 'model_attempt' }, undefined,
      async () => { throw error; })).rejects.toBe(error);
    expect(JSON.parse(log.mock.calls[1]![0])).toMatchObject({ outcome: 'failed', statusCode: 429, retryable: true });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });

  it('does not report success when an aborted call returns late', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    let resolve!: (value: number) => void;
    const result = observeAgentOperation({ stage: 'transcript_analysis' }, controller.signal,
      () => new Promise<number>(done => { resolve = done; }));
    controller.abort(new Error('Research phase timeout.'));
    resolve(1);
    await result;
    expect(log.mock.calls).toHaveLength(2);
    expect(JSON.parse(log.mock.calls[1]![0]).outcome).toBe('canceled');
  });
});
