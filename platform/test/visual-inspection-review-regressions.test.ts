import { MockLanguageModelV4 } from 'ai/test';
import { executeResearchRun } from '../src/agents/research/research-agent';
import { reviewVisualAnswer } from '../src/agents/runtime/visual-evidence-review';
import { memoryDeltaSchema, projectMemoryUpdaterInput, validateMemoryDelta } from '../src/agents/runtime/memory-updater';
import { withModelFailover, type ModelFailoverState } from '../src/agents/runtime/model-failover';
import type { EvidencePacket } from '../src/agents/contracts';
import type { ModelEvidencePacket } from '../src/agents/runtime/model-evidence';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';

const models = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../src/agents/model', async original => ({ ...await original<typeof import('../src/agents/model')>(), createAgentModel: models.select }));
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const response = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });
const answer = (text: string) => ({ confidence: 'medium', warnings: [], blocks: [{ text, evidenceIds: [] }] });
const frame: EvidencePacket = { packetId: 'frames', kind: 'youtube_frames', sources: [{ id: 'v', provider: 'youtube', kind: 'frames', videoId: 'abcdefghijk' }],
  excerpts: [], warnings: [], usage: [], artifacts: [{ type: 'youtube_frame_analysis', data: { requestedTimestampsMs: [200000],
    frames: [{ timestampMs: 200000, mimeType: 'image/jpeg', width: 640, height: 360 }], failures: [] } }] };
function runtime(finalizer: MockLanguageModelV4, reviewer: MockLanguageModelV4) {
  models.select.mockClear();
  models.select.mockImplementation((_env, _affinity, _effort, metadata) => metadata.model_role === 'evidence_reviewer' ? reviewer : finalizer);
  const options: Parameters<typeof executeResearchRun>[0] = {
    runId: 'review-regression', userMessageId: crypto.randomUUID(),
    env: {} as Env, sessionAffinity: 'session', message: 'Explain your earlier answer.', signal: new AbortController().signal,
    persistedRoute: { route: 'finalize', responseIntent: 'context_answer', contextScope: 'video', reason: 'Follow-up' },
    conversationHistory: [], recoveredEvidence: [], recoveredToolFailures: [],
    modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage: vi.fn() }, modelCallPrefix: 'regression',
    persistRoute: vi.fn(), onCapabilityLoaded: vi.fn(), onFinalizing: vi.fn(), executeEvidenceTool: vi.fn(),
    finalize: vi.fn(async (_id, input) => input as never),
  };
  return options;
}

it('checks and repairs a positive inspection claim before persistence when no visual records exist', async () => {
  const finalizer = new MockLanguageModelV4({ doGenerate: [response(answer('I inspected frames at 3:20.')), response(answer('The available records do not establish a frame inspection.'))] });
  const reviewer = new MockLanguageModelV4({ doGenerate: [response({ issues: [{ blockIndex: 0, reason: 'No inspection record supports this claim.' }] }), response({ issues: [] })] });
  const options = runtime(finalizer, reviewer);
  await executeResearchRun(options);
  expect(reviewer.doGenerateCalls).toHaveLength(2);
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ answer: 'The available records do not establish a frame inspection.' }));
});

it('never persists an unsupported no-record claim rejected on both answer attempts', async () => {
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => response(answer('I inspected frames at 3:20.')) });
  const reviewer = new MockLanguageModelV4({ doGenerate: async () => response({ issues: [{ blockIndex: 0, reason: 'No recorded inspection supports this claim.' }] }) });
  const options = runtime(finalizer, reviewer);
  await expect(executeResearchRun(options)).rejects.toThrow();
  expect(reviewer.doGenerateCalls).toHaveLength(2);
  expect(options.finalize).not.toHaveBeenCalled();
});

it.each(['If we inspect a frame at 3:20, we could check the shirt.', 'I cannot establish whether a frame at 3:20 was inspected.'])(
  'preserves a hypothetical or uncertain answer with no inspection records: %s', async text => {
    const finalizer = new MockLanguageModelV4({ doGenerate: async () => response(answer(text)) });
    const reviewer = new MockLanguageModelV4({ doGenerate: async () => response({ issues: [] }) });
    const options = runtime(finalizer, reviewer);
    await executeResearchRun(options);
    expect(reviewer.doGenerateCalls).toHaveLength(1);
    expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ answer: text }));
  });

it('gives the checker a cited transcript finding and its support without losing citation identity', async () => {
  const transcript: ModelEvidencePacket = { packetId: 'captions', kind: 'youtube_transcript_analysis', sources: [{ id: 'captions', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }], warnings: [],
    transcriptAnalysis: { summary: 'Speaker introduction', findings: [{ claim: 'The speaker introduces herself before the selected frame.', excerptIds: ['ref_2'],
      entities: [{ name: 'Azadeh Moshiri', source: 'transcript', quote: 'I am Azadeh Moshiri and this is my report.' }], quantities: [], uncertainty: null }],
      coverage: { completeTranscriptRead: true, segmentCount: 1, startMs: 190000, endMs: 200000 }, selectedExcerptCount: 1 } };
  const model = new MockLanguageModelV4({ doGenerate: async () => response({ issues: [] }) });
  await reviewVisualAnswer({ model, evidence: [transcript], blocks: [{ text: 'The introduction supports locating a frame around 3:20.', evidenceIds: ['ref_2'] }],
    question: 'Why that timestamp?', signal: new AbortController().signal, deadlineAt: Date.now() + 20000, callId: 'support' });
  expect(model.doGenerateCalls).toHaveLength(1);
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  expect(prompt).toContain('I am Azadeh Moshiri and this is my report.');
  expect(prompt).toContain('ref_2');
});

it('passes the same already-read older history and recovered context to the checker', async () => {
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => response(answer('The older answer cited 3:20.')) });
  const reviewer = new MockLanguageModelV4({ doGenerate: async () => response({ issues: [] }) });
  const options = runtime(finalizer, reviewer);
  options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', contextScope: 'history', reason: 'Older answer' };
  const historyPage = { messages: [{ id: 'old-answer-id', role: 'assistant' as const, text: 'Earlier I cited 3:20 for the opening scene.', createdAt: 1 }], nextOffset: 20 };
  const readHistory = vi.fn(() => historyPage);
  options.session = { brief: () => ({ assets: [], memories: [] }), readHistory, evidence: () => [], readEvidence: vi.fn() } as unknown as NonNullable<typeof options.session>;
  options.recoveredResearchContext = { reads: [{ tool: 'search_context', input: { label: 'history', query: 'opening' }, result: [{ id: 'searched-old-answer', role: 'assistant', text: 'I also described an alternative at 3:30.' }] }], truncated: true, budgetTruncated: true };
  await executeResearchRun(options);
  expect(readHistory).toHaveBeenCalledOnce();
  expect(options.session!.readEvidence).not.toHaveBeenCalled();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(reviewer.doGenerateCalls).toHaveLength(1);
  const prompt = JSON.stringify(reviewer.doGenerateCalls[0]!.prompt);
  const finalizerPrompt = JSON.parse((finalizer.doGenerateCalls[0]!.prompt.find(part => part.role === 'user')!.content as Array<{ text: string }>)[0]!.text);
  const reviewPrompt = JSON.parse((reviewer.doGenerateCalls[0]!.prompt.find(part => part.role === 'user')!.content as Array<{ text: string }>)[0]!.text);
  for (const key of ['historyPage', 'researchContext', 'contextIncomplete', 'missingInputs', 'conversationHistory', 'session', 'evidenceOmittedFromContext', 'providerFailures', 'applicationDurationNotice']) expect(reviewPrompt.answerContext[key]).toEqual(finalizerPrompt[key]);
  expect(reviewPrompt.contextDelivery.additionalRetrieval).toBe(false);
  for (const value of ['old-answer-id', 'Earlier I cited 3:20', 'nextOffset', 'searched-old-answer', 'alternative at 3:30', 'budgetTruncated']) expect(prompt).toContain(value);
});

it.each(['context', 'question'] as const)('accepts a quote-only %s upsert with omitted or empty text', kind => {
  for (const supplied of [{}, { text: '' }]) {
    const delta = memoryDeltaSchema.parse({ changes: [{ action: 'upsert', kind, topic: 'preference', userQuote: 'I prefer detailed answers', ...supplied }] });
    const projection = projectMemoryUpdaterInput({ question: 'I prefer detailed answers', answer: 'Understood.', citations: [], memories: [] });
    expect(validateMemoryDelta(delta, projection)).toEqual({ rejected: 0, changes: [{ action: 'upsert', kind, topic: 'preference', text: 'I prefer detailed answers', evidenceIds: [] }] });
  }
});

it.each(['finalize', 'inspect_video'] as const)('inherits selected fallback and diagnostics on %s without reusing the answer deadline state', async route => {
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => response(answer('The selection reason was not recorded.')) });
  const reviewer = new MockLanguageModelV4({ doGenerate: async () => response({ issues: [] }) });
  const options = runtime(finalizer, reviewer); options.recoveredEvidence = [{ ...frame, excerpts: [{ id: 'frame-note', sourceId: 'v', text: 'The supplied frame has no recorded selection reason.' }] }];
  const state: ModelFailoverState = { fallback: true, deadlineAt: 1, onDiagnostic: vi.fn() }; options.modelFailover = state;
  if (route === 'inspect_video') {
    options.persistedRoute = { route: 'inspect_video', videoId: 'abcdefghijk', visualEvidence: 'none' };
    vi.mocked(options.executeEvidenceTool).mockResolvedValue({ ...frame, packetId: 'metadata', kind: 'youtube_video' });
    finalizer.doGenerate = async () => response({ ...answer('The selection reason was not recorded.'), blocks: [{ text: 'The selection reason was not recorded.', evidenceIds: ['ref_1'] }] });
  }
  await executeResearchRun(options);
  const call = models.select.mock.calls.find(call => call[3]?.model_role === 'evidence_reviewer');
  expect(call?.[4]).toMatchObject({ fallback: true, onDiagnostic: state.onDiagnostic });
  expect(call?.[4]).not.toBe(state);
  expect(state.deadlineAt).not.toBe(call?.[4]?.deadlineAt);
});

it('finishes the review on the known healthy fallback within twenty seconds', async () => {
  vi.useFakeTimers();
  try {
    const finalizer = new MockLanguageModelV4({ doGenerate: async () => response(answer('The selection reason was not recorded.')) });
    const options = runtime(finalizer, new MockLanguageModelV4()); options.recoveredEvidence = [frame];
    const state: ModelFailoverState = { fallback: true, onDiagnostic: vi.fn() }; options.modelFailover = state;
    const primary = new MockLanguageModelV4({ modelId: 'glm', doStream: () => new Promise(() => {}) });
    const backup = new MockLanguageModelV4({ modelId: 'deepseek', doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
      setTimeout(() => { controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'answer' }); controller.enqueue({ type: 'text-delta', id: 'answer', delta: '{"issues":[]}' }); }, 1000);
      setTimeout(() => { controller.enqueue({ type: 'text-end', id: 'answer' }); controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); controller.close(); }, 15000);
    } }) }) });
    models.select.mockImplementation((_env, _affinity, _effort, metadata, failover) => metadata.model_role === 'evidence_reviewer'
      ? withModelFailover({ primary, fallback: backup, state: failover ?? { fallback: false }, role: 'evidence_reviewer' }) : finalizer);
    const outcome = executeResearchRun(options).then(() => 'accepted', error => error.message);
    await vi.advanceTimersByTimeAsync(15001);
    expect(primary.doStreamCalls).toHaveLength(0);
    expect(await outcome).toBe('accepted');
    expect(backup.doStreamCalls).toHaveLength(1);
    expect(options.finalize).toHaveBeenCalledOnce();
    expect(state.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'deepseek', outcome: 'succeeded' }));
  } finally { vi.useRealTimers(); }
});
