import { captureVisualWork, countVisualWork, diagnoseVisualTool, linkVisualWork, visualDiagnosticsSchema,
  visualFailure, visualSpan } from '../src/lib/visual-diagnostics';

afterEach(() => vi.restoreAllMocks());

test('parallel child spans use interval union and exclusive parent time', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { diagnostics } = await captureVisualWork('tool', 'frames', async () => {
    now = 5;
    await visualSpan('retrieval', async () => {
      now = 10;
      await Promise.all([
        visualSpan('session_lookup', async () => { countVisualWork('catalogHits'); }),
        visualSpan('coordinator_wait', async () => { now = 30; }),
      ]);
      now = 40;
    });
    now = 50;
  });
  expect(diagnostics.elapsedMs).toBe(50);
  expect(diagnostics.unaccountedMs).toBe(15);
  expect(diagnostics.spans[0]).toMatchObject({ startMs: 5, endMs: 40, exclusiveMs: 15 });
  expect(diagnostics.spans.slice(1).every(span => span.parentId === 1)).toBe(true);
  expect(visualDiagnosticsSchema.safeParse(diagnostics).success).toBe(true);
});

test('concurrent requests isolate counters and link remote work without adding its duration', async () => {
  const remote = await captureVisualWork('coordinator', 'frames', async () => { countVisualWork('containerAttempts'); });
  remote.diagnostics.elapsedMs = 100_000;
  const results = await Promise.all([1, 2].map(count => captureVisualWork('tool', 'frames', async () => {
    await visualSpan('coordinator_wait', async () => {
      await Promise.resolve();
      countVisualWork('requestedImages', count);
      linkVisualWork(remote.diagnostics, 'coalesced');
      linkVisualWork({ password: 'do not retain' });
    });
  })));
  for (const [index, result] of results.entries()) {
    expect(result.diagnostics.counters).toEqual({ requestedImages: index + 1 });
    expect(result.diagnostics.linked).toHaveLength(1);
    expect(result.diagnostics.linked[0]).toMatchObject({ waitSpanId: 1, cacheStatus: 'coalesced',
      work: { operationId: remote.diagnostics.operationId, counters: { containerAttempts: 1 } } });
    expect(result.diagnostics.elapsedMs).toBeLessThan(100_000);
  }
  expect(results[0]!.diagnostics.operationId).not.toBe(results[1]!.diagnostics.operationId);
});

test('preserves original failures and bounds diagnostics without URLs or raw errors', async () => {
  const error = new Error('https://private.example/?secret=token');
  await expect(captureVisualWork('tool', 'storyboard', async () => {
    for (let i = 0; i < 200; i++) await visualSpan('catalog_lookup', async () => {});
    await visualSpan('extraction', async () => { throw error; });
  })).rejects.toBe(error);
  const diagnostics = visualFailure(error)!;
  expect(diagnostics.outcome).toBe('error');
  expect(diagnostics.spans).toHaveLength(192);
  expect(diagnostics.droppedSpans).toBe(9);
  expect(JSON.stringify(diagnostics)).not.toContain('secret');
  expect(visualFailure(new Error('unrelated'))).toBeUndefined();
});

test('late work after a deadline cannot mutate the persisted snapshot', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let late!: Promise<void>;
  const { diagnostics } = await captureVisualWork('tool', 'storyboard', async () => {
    late = visualSpan('retrieval', async () => { await gate; countVisualWork('containerAttempts'); });
  });
  const snapshot = JSON.stringify(diagnostics);
  expect(diagnostics.spans[0]!.outcome).toBe('pending');
  finish();
  await late;
  expect(JSON.stringify(diagnostics)).toBe(snapshot);
});

test('logging failure cannot replace a successful packet', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('logger unavailable'); });
  const packet = await diagnoseVisualTool('frames', async () => ({ artifacts: [{ data: {} as Record<string, unknown> }] }));
  expect(visualDiagnosticsSchema.safeParse(packet.artifacts[0]!.data.visualDiagnostics).success).toBe(true);
});

test('timing logs emit structured JSON with correlation fields', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  await captureVisualWork('tool', 'storyboard', async () => {}, { runId: 'run', toolCallId: 'call' });
  expect(info).toHaveBeenCalledOnce();
  expect(JSON.parse(info.mock.calls[0]![0])).toMatchObject({ event: 'visual_work_timing', runId: 'run', toolCallId: 'call' });
});
