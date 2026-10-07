import { traceFinalizationFailure, type FinalizationFailureCapture } from '../src/agents/runtime/finalization-trace';
import type { TraceToolCall } from '../src/agents/runtime/tool-call-trace';

const capture = (): FinalizationFailureCapture => ({ runId: 'run', attemptId: 'attempt', attempt: 1,
  modelCallId: 'call', modelId: 'deepseek', startedAt: 100, elapsedMs: 200,
  schemaVersion: 'answer-blocks-v3', validationStage: 'output_schema', code: 'INVALID_ANSWER_STRUCTURE', candidate: 'private draft',
  candidateCharacters: 13, referenceMap: new Map(), evidence: [], error: new Error('private provider body') });

function recorder(storageFailure = false) {
  const recorded: { input?: unknown; error?: unknown } = {};
  const trace: TraceToolCall = async call => {
    recorded.input = structuredClone(call.input);
    try { return await call.execute(); } catch (error) {
      recorded.error = error;
      throw storageFailure ? new Error('Storage failed') : error;
    }
  };
  return { trace, recorded };
}

it('bounds private payloads and resolves references without propagating storage failures', async () => {
  const value = capture();
  value.candidate = 'a'.repeat(40_000);
  value.candidateCharacters = 40_000;
  value.validationMessage = 'b'.repeat(5_000);
  value.schemaIssues = Array.from({ length: 45 }, () => ({ path: ['blocks', 0], code: 'custom', message: 'c'.repeat(2_000) }));
  value.referenceMap = new Map(Array.from({ length: 140 }, (_, i) => [`ref_${i}`, `e${i}`]));
  value.evidence = [{ packetId: 'packet', kind: 'youtube_transcript', sources: [{ id: 'source', provider: 'youtube', videoId: 'aaaaaaaaaaa', title: 'Video', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }],
    excerpts: [{ id: 'e0', sourceId: 'source', text: 'quote' }], artifacts: [], warnings: [] }] as unknown as FinalizationFailureCapture['evidence'];
  const { trace, recorded } = recorder(true);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(traceFinalizationFailure(trace, value)).resolves.toBeUndefined();
    expect(recorded.input).toMatchObject({ captureTruncated: true, candidate: 'a'.repeat(32_000), candidateCharacters: 40_000,
      references: expect.arrayContaining([expect.objectContaining({ alias: 'ref_0', evidenceId: 'e0', packetId: 'packet', sourceId: 'source', videoId: 'aaaaaaaaaaa' })]) });
    const input = recorded.input as { issues: Array<{ message: string }>; references: unknown[] };
    expect(input.issues).toHaveLength(40);
    expect(input.issues[0]?.message).toHaveLength(1_000);
    expect(input.references).toHaveLength(128);
    expect(recorded.error).toMatchObject({ message: 'b'.repeat(4_000) });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  } finally { warn.mockRestore(); }
});

it('excludes provider error bodies and headers from captured failures', async () => {
  const value = capture();
  Object.assign(value.error as Error, { responseBody: 'provider secret', responseHeaders: { authorization: 'secret token' } });
  const { trace, recorded } = recorder();
  await traceFinalizationFailure(trace, value);
  expect(JSON.stringify(recorded.input)).not.toContain('provider secret');
  expect(recorded.error).toMatchObject({ name: 'FinalAnswerRejection', code: 'INVALID_ANSWER_STRUCTURE',
    message: 'Final answer generation did not complete.' });
  expect(recorded.error).not.toHaveProperty('responseBody');
  expect(recorded.error).not.toHaveProperty('responseHeaders');
});

it('marks a bounded partial stream as truncated even if its stored candidate fits', async () => {
  const { trace, recorded } = recorder();
  await traceFinalizationFailure(trace, { ...capture(), candidateCharacters: 90_000 });
  expect(recorded.input).toMatchObject({ candidate: 'private draft', captureTruncated: true, candidateCharacters: 90_000 });
});
