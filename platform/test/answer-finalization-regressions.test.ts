import { MockLanguageModelV4 } from 'ai/test';
import { executeResearchRun } from '../src/agents/research/research-agent';
import type { EvidencePacket } from '../src/agents/contracts';

const models = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../src/agents/model', async original => ({ ...await original<typeof import('../src/agents/model')>(), createAgentModel: models.select }));
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const response = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });
const answer = (text: string) => ({ confidence: 'medium', warnings: [], blocks: [{ text, evidenceIds: [] }] });
const frame: EvidencePacket = { packetId: 'frames', kind: 'youtube_frames', sources: [{ id: 'v', provider: 'youtube', kind: 'frames', videoId: 'abcdefghijk' }],
  excerpts: [], warnings: [], usage: [], artifacts: [{ type: 'youtube_frame_analysis', data: { requestedTimestampsMs: [200000],
    frames: [{ timestampMs: 200000, mimeType: 'image/jpeg', width: 640, height: 360 }], failures: [] } }] };
function runtime(finalizer: MockLanguageModelV4) {
  models.select.mockClear();
  models.select.mockImplementation((_env, _affinity, _effort, metadata) => {
    if (metadata.model_role !== 'finalizer') throw new Error(`Unexpected model role: ${metadata.model_role}`);
    return finalizer;
  });
  const options: Parameters<typeof executeResearchRun>[0] = {
    runId: 'answer-regression', userMessageId: crypto.randomUUID(),
    env: {} as Env, sessionAffinity: 'session', message: 'Explain your earlier answer.', signal: new AbortController().signal,
    persistedRoute: { route: 'finalize', responseIntent: 'context_answer', contextScope: 'video', reason: 'Follow-up' },
    conversationHistory: [], recoveredEvidence: [], recoveredToolFailures: [],
    modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage: vi.fn() }, modelCallPrefix: 'regression',
    traceToolCall: vi.fn(async call => call.execute()), persistRoute: vi.fn(), onCapabilityLoaded: vi.fn(), onFinalizing: vi.fn(), executeEvidenceTool: vi.fn(),
    finalize: vi.fn(async (_id, input) => input as never),
  };
  return options;
}

it.each([false, true])('saves an answer with one model call and no semantic reviewer, visual records=%s', async visual => {
  const text = 'The available context does not establish what she is holding.';
  const model = new MockLanguageModelV4({ doGenerate: async () => response(answer(text)) });
  const options = runtime(model);
  if (visual) options.recoveredEvidence = [frame];
  await executeResearchRun(options);
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(models.select).toHaveBeenCalledOnce();
  expect(options.modelBudget!.recordUsage).toHaveBeenCalledOnce();
  expect(options.traceToolCall).not.toHaveBeenCalled();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ answer: text }));
});

it('answers a workflow follow-up using older history without a second model', async () => {
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => response(answer('The older answer cited 3:20.')) });
  const options = runtime(finalizer);
  options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', contextScope: 'history', reason: 'Older answer' };
  const historyPage = { messages: [{ id: 'old-answer-id', role: 'assistant' as const, text: 'Earlier I cited 3:20 for the opening scene.', createdAt: 1 }], nextOffset: 20 };
  const readHistory = vi.fn(() => historyPage);
  options.session = { brief: () => ({ assets: [], memories: [] }), readHistory, evidence: () => [], readEvidence: vi.fn() } as unknown as NonNullable<typeof options.session>;
  options.recoveredResearchContext = { reads: [{ tool: 'search_context', input: { label: 'history', query: 'opening' }, result: [{ id: 'searched-old-answer', role: 'assistant', text: 'I also described an alternative at 3:30.' }] }], truncated: true, budgetTruncated: true };
  await executeResearchRun(options);
  expect(readHistory).toHaveBeenCalledOnce();
  expect(options.session!.readEvidence).not.toHaveBeenCalled();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  const prompt = JSON.stringify(finalizer.doGenerateCalls[0]!.prompt);
  for (const value of ['old-answer-id', 'Earlier I cited 3:20', 'nextOffset', 'searched-old-answer', 'alternative at 3:30', 'budgetTruncated']) expect(prompt).toContain(value);
});


it('gives workflow follow-ups the selection bases of this conversation branch only, never free-text reasons', async () => {
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => response(answer('The recorded basis was a spoken introduction.')) });
  const options = runtime(finalizer);
  const withSelections = (packetId: string, selections: unknown[]): EvidencePacket => ({ ...frame, packetId, artifacts: [{ type: 'youtube_frame_retrieval',
    data: { ...frame.artifacts[0]!.data, selections } }] });
  options.message = 'Why did you pick 3:20 in abcdefghijk?';
  options.conversationHistory = [{ userMessageId: 'u1', agentMessageId: 'a1', user: 'What is she holding?', assistant: 'A microphone.',
    resourceIds: ['abcdefghijk'], inspection: [
      withSelections('branch-frames', [{ timestampMs: 200000, basis: 'spoken_introduction', evidenceIds: ['cue-1'] }]),
      // Saved before bases existed: its free text restates a transcript claim never admitted to this turn.
      withSelections('legacy-frames', [{ timestampMs: 200000, reason: 'Captions say revenue doubled to 40 million here', evidenceIds: [] }]),
    ] }];
  // Another conversation's saved inspection of the same video must not be offered as this branch's record.
  options.session = { brief: () => ({ assets: [], memories: [] }), evidence: () => [withSelections('other-conversation', [{ timestampMs: 200000, basis: 'exploratory', evidenceIds: [] }])],
    readEvidence: vi.fn() } as unknown as NonNullable<typeof options.session>;
  await executeResearchRun(options);
  const prompt = JSON.stringify(finalizer.doGenerateCalls[0]!.prompt);
  for (const value of ['branch-frames', 'spoken_introduction', 'cue-1', 'legacy-frames']) expect(prompt).toContain(value);
  expect(prompt).not.toContain('revenue doubled');
  expect(prompt).not.toContain('other-conversation');
});
