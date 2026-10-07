import { MockLanguageModelV4 } from 'ai/test';
import { attachTestAssetStore } from './fixtures/analysis-session';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { reviewedVideoIds } from '../src/agents/research/research-coverage';
import { compactAgentResult } from '../src/agents/response';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { CapabilityRouteDecision, EvidencePacket } from '../src/agents/contracts';

const zoo = 'jNQXAC9IVRw';
const bunny = 'aqz-KE-bpKQ';
const other = 'DC471a9qrU4';
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };

const packet = (kind: EvidencePacket['kind'], videoId: string, options: { artifact?: string; text?: string; linked?: boolean; id?: string } = {}): EvidencePacket => {
  const sourceId = `${kind}:${videoId}`;
  return { packetId: options.id ?? `${kind}:${videoId}:${options.artifact ?? 'none'}`, kind,
    sources: [{ id: sourceId, provider: 'youtube', kind: 'video', videoId }],
    excerpts: options.text === undefined ? [] : [{ id: `${options.id ?? kind}:${videoId}:0`, sourceId: options.linked === false ? 'elsewhere' : sourceId, text: options.text }],
    artifacts: options.artifact ? [{ type: options.artifact, data: { videoId } }] : [], warnings: [], usage: [] };
};
const frames = (videoId: string, options: { text?: string; linked?: boolean; id?: string } = {}) =>
  packet('youtube_frames', videoId, { artifact: 'youtube_frame_analysis', text: 'The person stands left of the enclosure.', ...options });
const storyboard = (videoId: string) => packet('youtube_storyboard', videoId, { artifact: 'youtube_storyboard_analysis', text: 'A large rabbit stands in a meadow.' });
const transcript = (videoId: string, analyzed = true) => packet('youtube_transcript', videoId,
  { artifact: analyzed ? 'youtube_transcript_analysis' : undefined, text: 'Spoken line.' });
const metadata = (videoId: string) => packet('youtube_video', videoId, { text: `${videoId} metadata.` });
const inspect = { route: 'inspect_video', videoId: zoo };

describe('reviewedVideoIds', () => {
  it('counts analyzed frame and storyboard observations', () => {
    expect([...reviewedVideoIds([frames(zoo)], inspect)]).toEqual([zoo]);
    expect([...reviewedVideoIds([storyboard(bunny)], inspect)]).toEqual([bunny]);
  });

  it('deduplicates one video across transcripts, repeated analyses and saved-asset analyses', () => {
    expect(reviewedVideoIds([transcript(zoo), frames(zoo), frames(zoo, { id: 'repeat' }), storyboard(zoo)], inspect).size).toBe(1);
  });

  it('ignores retrievals, manifests, empty, blank and unlinked visual analyses', () => {
    expect(reviewedVideoIds([
      packet('youtube_frames', zoo),
      packet('youtube_storyboard', zoo, { artifact: 'youtube_storyboard_retrieval', text: 'Sheet 1 of 3 retrieved.' }),
      packet('youtube_frames', zoo, { artifact: 'youtube_frame_analysis' }),
      frames(zoo, { text: '   ' }),
      frames(zoo, { linked: false }),
      metadata(zoo),
      packet('youtube_comments', zoo, { text: 'Great video.' }),
    ], inspect).size).toBe(0);
  });

  it('counts only comparison subjects', () => {
    expect([...reviewedVideoIds([frames(zoo), frames(other), transcript(bunny)], { route: 'topic_research', comparisonVideoIds: [zoo, bunny] })].sort())
      .toEqual([bunny, zoo].sort());
  });

  it('keeps the discovery rule that a transcript counts only after analysis', () => {
    expect(reviewedVideoIds([transcript(zoo, false)], { route: 'topic_research' }).size).toBe(0);
    expect(reviewedVideoIds([transcript(zoo, false)], inspect).size).toBe(1);
    expect(reviewedVideoIds([transcript(zoo)], { route: 'topic_research' }).size).toBe(1);
  });
});

function context(): AgentToolContext {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider operation'); };
  const ctx = {
    runId: 'coverage-run', signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
    provider: { search: unexpected, browse: unexpected, trends: unexpected, video: unexpected, tracks: unexpected,
      transcript: unexpected, comments: unexpected, endscreen: unexpected, channel: unexpected, channelVideos: unexpected,
      channelPlaylists: unexpected, playlist: unexpected,
      frames: vi.fn(async (request: { videoId: string; timestampsMs: number[] }) => ({ cacheStatus: 'miss' as const, value: {
        videoId: request.videoId, frames: request.timestampsMs.map(timestampMs => ({ timestampMs, mimeType: 'image/jpeg' as const,
          width: 320, height: 240, imageBase64: '/9j/2Q==' })), failures: [], meta: { partial: false, warnings: [] } } })) },
    analyzeFrames: vi.fn(async () => ({ findings: [
      { observation: 'The person stands left of the elephant enclosure.', timestampsMs: [3000] },
      { observation: 'The person has moved to the right of the frame.', timestampsMs: [16000] }], warnings: [] })),
    executeEvidenceTool: (execution: { execute: () => Promise<EvidencePacket> }) => execution.execute(),
    finalize: vi.fn(async (_id: string, input: object) => ({ ...input, runId: 'coverage-run', conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(), billing: { creditsCharged: 3, creditsRemaining: 100 } })),
  } as unknown as AgentToolContext;
  attachTestAssetStore(ctx);
  return ctx;
}
const toolCall = (id: string, toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage, warnings: [] });
const finishNow = (intent: string) => new MockLanguageModelV4({ doGenerate: async () => toolCall('finish', 'finalize_answer',
  { intent, confidence: 'medium', artifacts: [], warnings: [], blocks: [{ text: 'x', evidenceIds: ['ref_1'] }] }) });
const finalizerCiting = (refs: string[]) => new MockLanguageModelV4({ doGenerate: async () => ({
  content: [{ type: 'text', text: JSON.stringify({ confidence: 'medium', warnings: [],
    blocks: refs.map(ref => ({ text: `Observation supported by ${ref}.`, evidenceIds: [ref] })) }) }],
  finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }) });
function finalized(ctx: AgentToolContext, decision: CapabilityRouteDecision) {
  const input = vi.mocked(ctx.finalize).mock.calls.at(-1)![1];
  const view = compactAgentResult({ ...input, answer: input.answer.replace(/\[cite:[^\]]+\]/g, ''), citations: [], runId: 'coverage-run',
    conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(),
    billing: { creditsCharged: 3, creditsRemaining: 100 } } as never, [], decision);
  return { codes: input.warnings.map(warning => warning.code), messages: input.warnings.map(warning => warning.message), view,
    coverage: input.artifacts.find(artifact => artifact.type === 'research_coverage')?.data };
}

describe('QA004 research coverage for visual reviews', () => {
  it('reports one reviewed video after exact frames are retrieved and analyzed', async () => {
    const ctx = context();
    const steps = [
      ['get_video_frames', { videoId: zoo, timestampsMs: [3000, 16000] }],
      ['analyze_video_frames', { assetVersions: ['1'.padStart(64, '0'), '2'.padStart(64, '0')], focus: 'Compare position and background.' }],
      ['finalize_answer', { intent: 'inspect_video', confidence: 'medium', artifacts: [], warnings: [], blocks: [{ text: 'x', evidenceIds: ['ref_1'] }] }],
    ] as const;
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => { const [name, input] = steps[Math.min(step, 2)]!; return toolCall(`s${step++}`, name, input); } });
    const decision = { route: 'inspect_video' as const, videoId: zoo, useStoryboard: true, visualEvidence: 'required' as const,
      visualRequirements: ['person position', 'background'] };
    await runResearchAgentWithModel({ model, finalizationModel: finalizerCiting(['ref_1']), context: ctx, message: 'Exact frames at 00:03 and 00:16.',
      decision, recoveredEvidence: [metadata(zoo)], toolNames: ['get_video_frames', 'analyze_video_frames', 'finalize_answer'] });
    const result = finalized(ctx, decision);
    expect(ctx.analyzeFrames).toHaveBeenCalledOnce();
    expect(result.coverage).toEqual({ targetVideos: 1, reviewedVideos: 1 });
    expect(result.view).toMatchObject({ outcome: 'answered', coverage: { targetVideos: 1, reviewedVideos: 1 } });
  });

  it('counts a retained storyboard analysis reused by a new request', async () => {
    const ctx = context();
    const decision = { route: 'inspect_video' as const, videoId: bunny, useStoryboard: true, visualEvidence: 'helpful' as const };
    await runResearchAgentWithModel({ model: finishNow('inspect_video'), finalizationModel: finalizerCiting(['ref_1']), context: ctx,
      message: 'Describe the storyboard.', decision, recoveredEvidence: [metadata(bunny), storyboard(bunny)], toolNames: ['finalize_answer'] });
    expect(finalized(ctx, decision).coverage).toEqual({ targetVideos: 1, reviewedVideos: 1 });
  });

  it('does not count retrieved frames that were never analyzed', async () => {
    const ctx = context();
    const decision = { route: 'inspect_video' as const, videoId: zoo, useStoryboard: true, visualEvidence: 'helpful' as const };
    await runResearchAgentWithModel({ model: finishNow('inspect_video'), finalizationModel: finalizerCiting(['ref_1']), context: ctx,
      message: 'Describe it.', decision, recoveredEvidence: [metadata(zoo), packet('youtube_frames', zoo)], toolNames: ['finalize_answer'] });
    expect(finalized(ctx, decision).coverage).toEqual({ targetVideos: 1, reviewedVideos: 0 });
  });

  it('answers a frames-only comparison of both subjects without a transcript shortfall', async () => {
    const ctx = context();
    const decision = { route: 'topic_research' as const, comparisonVideoIds: [zoo, bunny], useStoryboard: true,
      visualEvidence: 'required' as const, visualRequirements: ['live action or animation'] };
    await runResearchAgentWithModel({ model: finishNow('topic_research'), finalizationModel: finalizerCiting(['ref_1', 'ref_2', 'ref_3', 'ref_4']),
      context: ctx, message: 'Compare one frame of each video.', decision, recoveredSearchUsed: true,
      recoveredEvidence: [metadata(zoo), metadata(bunny), frames(zoo), frames(bunny)], toolNames: ['finalize_answer'] });
    const result = finalized(ctx, decision);
    expect(result.coverage).toEqual({ targetVideos: 2, reviewedVideos: 2, requiredVideos: 2 });
    expect(result.codes).not.toContain('PARTIAL_EVIDENCE');
    expect(result.view.outcome).toBe('answered');
  });

  it('keeps a content shortfall partial when only one subject was reviewed', async () => {
    const ctx = context();
    const decision = { route: 'topic_research' as const, comparisonVideoIds: [zoo, bunny], useStoryboard: true,
      visualEvidence: 'helpful' as const };
    await runResearchAgentWithModel({ model: finishNow('topic_research'), finalizationModel: finalizerCiting(['ref_1', 'ref_2', 'ref_3']),
      context: ctx, message: 'Compare both videos.', decision, recoveredSearchUsed: true,
      recoveredEvidence: [metadata(zoo), metadata(bunny), frames(zoo)], toolNames: ['finalize_answer'] });
    const result = finalized(ctx, decision);
    expect(result.coverage).toEqual({ targetVideos: 2, reviewedVideos: 1, requiredVideos: 2 });
    expect(result.messages).toContain('The user requested 2 source videos; usable transcript or analyzed visual evidence was reviewed from 1.');
    expect(result.view.outcome).toBe('partial');
  });
});
