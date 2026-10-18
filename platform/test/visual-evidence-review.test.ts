import { MockLanguageModelV4 } from 'ai/test';
import { reviewVisualAnswer } from '../src/agents/runtime/visual-evidence-review';
import { inspectionRecordsForModel } from '../src/agents/runtime/inspection-records';
import type { EvidencePacket } from '../src/agents/contracts';

const packet: EvidencePacket = { packetId: 'frames', kind: 'youtube_frames', sources: [], excerpts: [], warnings: [], usage: [],
  artifacts: [{ type: 'youtube_frame_analysis', data: { requestedTimestampsMs: [200000], frames: [{ timestampMs: 200000, mimeType: 'image/jpeg', width: 640, height: 360 }], failures: [] } }] };
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const options = (model: MockLanguageModelV4) => ({ model, evidence: [], inspectionRecords: inspectionRecordsForModel([packet]),
  blocks: [{ text: 'The reason for 3:20 was not recorded.', evidenceIds: [] }], question: 'Why 3:20?',
  signal: new AbortController().signal, deadlineAt: Date.now() + 100_000, callId: 'review' });

it('checks no new video sources and records review cost once', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async call => {
    expect(call.tools).toBeUndefined();
    return { content: [{ type: 'text', text: '{"issues":[]}' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  const recordUsage = vi.fn();
  await reviewVisualAnswer({ ...options(model), budget: { limitMicros: 1000, currentCostMicros: () => 0, recordUsage } });
  expect(recordUsage).toHaveBeenCalledOnce();
  expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ callId: 'review', category: 'timeout_finalizer' }));
  expect(model.doGenerateCalls).toHaveLength(1);
});

it('does not admit another review after the run cost limit', async () => {
  const model = new MockLanguageModelV4();
  await expect(reviewVisualAnswer({ ...options(model), budget: { limitMicros: 1000, currentCostMicros: () => 1000, recordUsage: vi.fn() } })).rejects.toThrow('model-cost budget');
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('bounds an abort-ignoring reviewer to 20 seconds', async () => {
  vi.useFakeTimers();
  try {
    const model = new MockLanguageModelV4({ doGenerate: () => new Promise(() => {}) });
    const outcome = reviewVisualAnswer(options(model)).then(() => 'unexpected success', error => error.message);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toBe('Visual evidence review timed out.');
    expect(model.doGenerateCalls).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
