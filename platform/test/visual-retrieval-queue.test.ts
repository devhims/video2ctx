import { VisualRetrievalQueue } from '../src/agents/runtime/visual-retrieval-queue';
import { captureVisualWork, countVisualWork, visualSpan, withVisualFailureCapture,
  type VisualFailureCapture } from '../src/lib/visual-diagnostics';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('uses two slots, skips blocked same-video waiters, and retains their order', async () => {
  const queue = new VisualRetrievalQueue();
  const gates = [gate(), gate(), gate(), gate()];
  const started: number[] = [];
  const run = (videoId: string, index: number) => queue.run(videoId, undefined, async () => {
    started.push(index);
    await gates[index]!.promise;
  });
  const tasks = [run('a', 0), run('a', 1), run('b', 2), run('c', 3)];
  try {
    await flush();
    expect(started).toEqual([0, 2]);
    gates[2]!.release();
    await tasks[2];
    await flush();
    expect(started).toEqual([0, 2, 3]);
    gates[0]!.release();
    await tasks[0];
    await flush();
    expect(started).toEqual([0, 2, 3, 1]);
  } finally {
    gates.forEach(gate => gate.release());
    await Promise.allSettled(tasks);
  }
});

test('queued cancellation rejects immediately and never dispatches canceled work', async () => {
  const queue = new VisualRetrievalQueue(), held = gate(), controller = new AbortController();
  const active = ['a', 'b'].map(id => queue.run(id, undefined, () => held.promise));
  const work = vi.fn(async () => {});
  const queued = queue.run('c', controller.signal, work);
  const reason = new Error('deadline exceeded');
  const rejected = expect(queued).rejects.toBe(reason);
  controller.abort(reason);
  try {
    await rejected;
    expect(work).not.toHaveBeenCalled();
  } finally { held.release(); await Promise.allSettled(active); }
  await queue.run('c', undefined, work);
  expect(work).toHaveBeenCalledOnce();
});

test('already-canceled work never takes a slot', async () => {
  const queue = new VisualRetrievalQueue(), work = vi.fn(async () => {});
  const reason = new Error('canceled');
  await expect(queue.run('a', AbortSignal.abort(reason), work)).rejects.toBe(reason);
  await queue.run('a', undefined, work);
  expect(work).toHaveBeenCalledOnce();
});

test('cancellation after admission releases the slot without invoking work', async () => {
  const queue = new VisualRetrievalQueue(), controller = new AbortController();
  const work = vi.fn(async () => {});
  const pending = queue.run('a', controller.signal, work);
  const reason = new Error('canceled');
  const rejected = expect(pending).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  expect(work).not.toHaveBeenCalled();
  await queue.run('a', undefined, work);
  expect(work).toHaveBeenCalledOnce();
});

test('active cancellation holds the video slot until work settles, then failure releases it', async () => {
  const queue = new VisualRetrievalQueue(), held = gate(), entered = gate();
  const controller = new AbortController(), reason = new Error('canceled');
  const active = queue.run('a', controller.signal, async () => {
    entered.release();
    await held.promise;
    controller.signal.throwIfAborted();
  });
  const rejected = expect(active).rejects.toBe(reason);
  await entered.promise;
  controller.abort(reason);
  const next = vi.fn(async () => {});
  const pending = queue.run('a', undefined, next);
  try {
    await flush();
    expect(next).not.toHaveBeenCalled();
  } finally { held.release(); }
  await rejected;
  await pending;
  expect(next).toHaveBeenCalledOnce();
});

test.each([false, true])('failures release slots, including synchronous throw=%s', async sync => {
  const queue = new VisualRetrievalQueue(), error = new Error('upstream failure');
  await expect(queue.run('a', undefined, () => {
    if (sync) throw error;
    return Promise.reject(error);
  })).rejects.toBe(error);
  const work = vi.fn(async () => {});
  await queue.run('a', undefined, work);
  expect(work).toHaveBeenCalledOnce();
});

test('queued work retains its own diagnostics and records only admission time as queue wait', async () => {
  const queue = new VisualRetrievalQueue(), held = gate();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const first = captureVisualWork('tool', 'storyboard', () => queue.run('a', undefined, async () => {
    countVisualWork('returnedImages', 1);
    await held.promise;
  }));
  await flush();
  now = 10;
  const second = captureVisualWork('tool', 'frames', () => queue.run('a', undefined, async () => {
    await visualSpan('session_lookup', async () => { now = 40; countVisualWork('returnedImages', 6); });
  }));
  await flush();
  now = 30;
  held.release();
  try {
    const [a, b] = await Promise.all([first, second]);
    expect(a.diagnostics.counters).toEqual({ returnedImages: 1 });
    expect(b.diagnostics.counters).toEqual({ returnedImages: 6 });
    expect(b.diagnostics.spans.find(span => span.stage === 'session_queue_wait')).toMatchObject({
      startMs: 0, endMs: 20, exclusiveMs: 20, outcome: 'success',
    });
    expect(b.diagnostics.spans.find(span => span.stage === 'session_lookup')).toMatchObject({
      startMs: 20, endMs: 30,
    });
  } finally { vi.restoreAllMocks(); }
});

test('queued cancellation retains a failed queue span for the canceled caller', async () => {
  const queue = new VisualRetrievalQueue(), held = gate(), controller = new AbortController();
  const first = queue.run('a', undefined, () => held.promise);
  const failure: VisualFailureCapture = {};
  const reason = new Error('deadline');
  const second = withVisualFailureCapture(failure, () => captureVisualWork('tool', 'frames',
    () => queue.run('a', controller.signal, async () => {})));
  const rejected = expect(second).rejects.toBe(reason);
  controller.abort(reason);
  try {
    await rejected;
    expect(failure.diagnostics?.spans).toEqual([expect.objectContaining({ stage: 'session_queue_wait', outcome: 'error' })]);
  } finally { held.release(); await first; }
});
