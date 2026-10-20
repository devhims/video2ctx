import type { Transcript } from 'all-things-youtube';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EvidencePacket, FinalizeAnswerInput } from '../src/agents/contracts';
import { executeResearchRun } from '../src/agents/research/research-agent';
import { buildPassages } from '../src/lib/video-index/passages';
import { normalize } from '../src/lib/video-index/vectors';

const models = vi.hoisted(() => ({ select: vi.fn() }));
const storage = vi.hoisted(() => ({ read: vi.fn() }));
const upstream = vi.hoisted(() => ({ transcript: vi.fn() }));
vi.mock('../src/agents/model', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agents/model')>(), createAgentModel: models.select,
}));
vi.mock('../src/lib/video-index/storage', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/video-index/storage')>(), readTranscriptIndex: storage.read,
}));
vi.mock('../src/agents/providers/youtube/provider', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agents/providers/youtube/provider')>(),
  createYouTubeAgentProvider: () => ({ transcript: upstream.transcript }),
}));

const VIDEO = 'abcdefghijk';
const segments = Array.from({ length: 400 }, (_, index) => ({
  startMs: index * 3_000, endMs: index * 3_000 + 3_000, durationMs: 3_000,
  text: `This is caption ${index} with several spoken words${index % 6 === 5 ? '.' : ''}`,
}));
const transcript: Transcript = {
  videoId: VIDEO, segments, text: '',
  track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: true, isDefault: true },
  meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-19T00:00:00Z', partial: false, warnings: [] },
};
const passages = buildPassages(segments);
const unit = (index: number) => normalize(Array.from({ length: 8 }, (_, i) => i === index % 8 ? 1 : 0.01));
const usage = { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
const toolCall = (toolCallId: string, toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage, warnings: [],
});

beforeEach(() => {
  models.select.mockReset();
  storage.read.mockReset();
  storage.read.mockResolvedValue({ index: { captionCount: 400, dims: 8, passages, vectors: passages.map((_, i) => unit(i)) } });
  upstream.transcript.mockResolvedValue({ cacheStatus: 'hit', value: transcript,
    catalogVersions: [{ videoId: VIDEO, kind: 'transcript', variant: '{"language":"default","granularity":"word"}', contentHash: 'd'.repeat(64) }] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    data: [{ index: 0, embedding: [...unit(3)] }], usage: { total_tokens: 12 } })));
});
afterEach(() => vi.restoreAllMocks());

it('answers an inspected video from indexed passages, with citations that resolve to caption excerpts', async () => {
  const classifier = new MockLanguageModelV4({ doGenerate: async () => toolCall('route', 'classify_request',
    { route: 'inspect_video', videoId: VIDEO, visualEvidence: 'none', answerDetail: 'standard', transcriptScope: 'topic' }) });
  let step = 0;
  const research = new MockLanguageModelV4({ doGenerate: async () => step++ === 0
    ? toolCall('captions', 'get_video_transcript', { videoId: VIDEO })
    : toolCall('done', 'complete_research', {}) });
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ confidence: 'high', warnings: [], blocks: [{ text: 'The talk covers caption topics.', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : metadata.model_role === 'agent_core' ? research : finalizer);
  const packets: EvidencePacket[] = [];
  const finalize = vi.fn(async (_id: string, _input: FinalizeAnswerInput) => ({}) as never);
  const events: string[] = [];
  await executeResearchRun({
    env: { AGENT_TRANSCRIPT_RETRIEVAL: 'index', FIREWORKS_API_KEY: 'fw', AI_GATEWAY_ID: '' } as unknown as Env,
    runId: 'indexed-run', message: `What does https://youtu.be/${VIDEO} say about captions?`, sessionAffinity: 'session',
    signal: new AbortController().signal, conversationHistory: [], recoveredEvidence: [], recoveredToolFailures: [],
    modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage: vi.fn() }, modelCallPrefix: 'indexed',
    persistRoute: vi.fn(), onClassifying: vi.fn(), onCapabilityLoaded: vi.fn(), onFinalizing: vi.fn(),
    onTranscriptRetrievalEvent: type => events.push(type),
    executeEvidenceTool: async execution => {
      if (execution.toolName === 'get_video') return { packetId: 'metadata', kind: 'youtube_video', sources: [], excerpts: [], artifacts: [], warnings: [], usage: [] };
      const packet = await execution.execute();
      packets.push(packet);
      return packet;
    },
    finalize,
  });

  const transcriptPacket = packets.find(packet => packet.kind === 'youtube_transcript')!;
  expect(transcriptPacket.artifacts[0]!.type).toBe('youtube_transcript_retrieval');
  expect(transcriptPacket.excerpts.length).toBeLessThan(400);
  expect(events).toEqual(['transcript.retrieval']);
  // The research model is told not to read the whole transcript.
  expect(JSON.stringify(research.doGenerateCalls[0]!.prompt)).toContain('youtube_transcript_retrieval artifact');
  const input = finalize.mock.calls[0]![1];
  const cited = /\[cite:([^\]]+)\]/.exec(input.answer)![1]!;
  expect(transcriptPacket.excerpts.map(excerpt => excerpt.id)).toContain(cited);
  expect(cited).toMatch(new RegExp(`^transcript:${VIDEO}:\\d+:\\d+:0$`));
  // The finalizer receives bounded passages, not the whole transcript.
  const finalizerPrompt = JSON.stringify(finalizer.doGenerateCalls[0]!.prompt);
  expect(finalizerPrompt).toContain('not the whole transcript');
  expect(finalizerPrompt.length).toBeLessThan(60_000);
});

it('keeps today\'s path, with no retrieval guidance, when retrieval is off', async () => {
  const classifier = new MockLanguageModelV4({ doGenerate: async () => toolCall('route', 'classify_request',
    { route: 'inspect_video', videoId: VIDEO, visualEvidence: 'none', answerDetail: 'standard' }) });
  let step = 0;
  const research = new MockLanguageModelV4({ doGenerate: async () => step++ === 0
    ? toolCall('captions', 'get_video_transcript', { videoId: VIDEO })
    : toolCall('done', 'complete_research', {}) });
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ confidence: 'high', warnings: [], blocks: [{ text: 'Summary.', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : metadata.model_role === 'agent_core' ? research : finalizer);
  const packets: EvidencePacket[] = [];
  await executeResearchRun({
    env: {} as Env, runId: 'full-run', message: `Summarize https://youtu.be/${VIDEO}`, sessionAffinity: 'session',
    signal: new AbortController().signal, conversationHistory: [], recoveredEvidence: [], recoveredToolFailures: [],
    modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage: vi.fn() }, modelCallPrefix: 'full',
    persistRoute: vi.fn(), onClassifying: vi.fn(), onCapabilityLoaded: vi.fn(), onFinalizing: vi.fn(),
    executeEvidenceTool: async execution => {
      if (execution.toolName === 'get_video') return { packetId: 'metadata', kind: 'youtube_video', sources: [], excerpts: [], artifacts: [], warnings: [], usage: [] };
      const packet = await execution.execute();
      packets.push(packet);
      return packet;
    },
    finalize: vi.fn(async () => ({}) as never),
  });
  expect(packets[0]!.excerpts).toHaveLength(400);
  expect(storage.read).not.toHaveBeenCalled();
  expect(JSON.stringify(research.doGenerateCalls[0]!.prompt)).not.toContain('youtube_transcript_retrieval');
  expect(JSON.stringify(classifier.doGenerateCalls[0]!.prompt)).not.toContain('set transcriptScope');
});
