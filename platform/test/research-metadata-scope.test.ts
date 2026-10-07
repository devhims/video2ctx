import { MockLanguageModelV4 } from 'ai/test';
import { attachTestAssetStore } from './fixtures/analysis-session';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { classifyCapabilityWithModel } from '../src/agents/research/capability-router';
import { citedMetadataVideoIds } from '../src/agents/research/research-coverage';
import { compactAgentResult } from '../src/agents/response';
import { capabilityRouteDecisionSchema, hasMetadataScope, type CapabilityRouteDecision, type EvidencePacket } from '../src/agents/contracts';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';

// QA021: research explicitly limited to discovery and video metadata.
type TopicRoute = Extract<CapabilityRouteDecision, { route: 'topic_research' }>;
const first = 'l8mWvDUwOt4';
const second = 'lg_Ri5vpiNU';
const comments = 'DC471a9qrU4';
const zoo = 'jNQXAC9IVRw';
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
const LIVE_COMPARISON_PROMPT = `Compare these two videos using video metadata only: https://www.youtube.com/watch?v=${comments} and https://www.youtube.com/watch?v=${zoo}. For each video, give its exact title, channel name, video ID, duration in MM:SS, and direct link. Then state which video is longer and the duration difference in seconds. Do not search for alternatives or fetch transcripts, comments, frames, storyboards, or audio. Do not summarize or claim to have reviewed either video's content. If a required metadata field is missing, say so instead of guessing.`;

const metadata = (videoId: string): EvidencePacket => ({ packetId: `metadata:${videoId}`, kind: 'youtube_video',
  sources: [{ id: `video:${videoId}`, provider: 'youtube', kind: 'video', videoId, title: `Title ${videoId}` }],
  excerpts: [{ id: `metadata:${videoId}:0`, sourceId: `video:${videoId}`, text: `Title ${videoId} · Channel · 2:01` }],
  artifacts: [], warnings: [], usage: [] });
const search: EvidencePacket = { packetId: 'search', kind: 'youtube_search',
  sources: [first, second].map((videoId, index) => ({ id: `search-source:${index}`, provider: 'youtube' as const, kind: 'search' as const, videoId })),
  excerpts: [first, second].map((videoId, index) => ({ id: `search:${index}`, sourceId: `search-source:${index}`, text: `${videoId} · 2:01` })),
  artifacts: [], warnings: [], usage: [] };
const transcript = (videoId: string): EvidencePacket => ({ packetId: `transcript:${videoId}`, kind: 'youtube_transcript',
  sources: [{ id: `transcript:${videoId}`, provider: 'youtube', kind: 'transcript', videoId }],
  excerpts: [{ id: `transcript:${videoId}:0`, sourceId: `transcript:${videoId}`, text: `Spoken words in ${videoId}.` }],
  artifacts: [{ type: 'youtube_transcript_analysis', data: { videoId } }], warnings: [], usage: [] });

const discovery = (scope?: 'metadata', extra: Partial<TopicRoute> = {}) => ({ route: 'topic_research' as const, requiredVideoCount: 2,
  researchVideoCount: 2, researchBreadth: 'focused' as const, searchQuery: 'Python list comprehensions', useStoryboard: false,
  visualEvidence: 'none' as const, ...(scope ? { evidenceScope: scope } : {}), ...extra }) as TopicRoute;
const comparison = (scope?: 'metadata') => ({ route: 'topic_research' as const, comparisonVideoIds: [comments, zoo], researchVideoCount: 2,
  useStoryboard: false, visualEvidence: 'none' as const, ...(scope ? { evidenceScope: scope } : {}) }) as TopicRoute;

function context(): AgentToolContext {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider operation'); };
  const ctx = {
    runId: 'metadata-run', signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
    provider: { search: unexpected, browse: unexpected, trends: unexpected, tracks: unexpected, transcript: vi.fn(unexpected), comments: unexpected,
      endscreen: unexpected, channel: unexpected, channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected,
      video: vi.fn(async (id: string) => ({ cacheStatus: 'hit' as const, value: { type: 'video', id, title: `Title ${id}`, description: '',
        channel: { id: `channel-${id}`, name: `Channel ${id}`, url: `https://www.youtube.com/channel/channel-${id}` }, thumbnails: [],
        durationSeconds: 121, durationText: '2:01', publishedTimeText: '1 year ago', viewCount: 10, viewCountText: '10 views', isLive: false,
        hasCaptions: true, url: `https://www.youtube.com/watch?v=${id}`, keywords: [], availability: { status: 'OK', playable: true },
        meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] } } })) },
    executeEvidenceTool: (execution: { execute: () => Promise<EvidencePacket> }) => execution.execute(),
    finalize: vi.fn(async (_id: string, input: object) => ({ ...input, runId: 'metadata-run', conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(), billing: { creditsCharged: 2, creditsRemaining: 100 } })),
  } as unknown as AgentToolContext;
  attachTestAssetStore(ctx);
  return ctx;
}
const toolCall = (id: string, toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage, warnings: [] });
const finishNow = () => new MockLanguageModelV4({ doGenerate: async () => toolCall('finish', 'finalize_answer',
  { intent: 'topic_research', confidence: 'medium', artifacts: [], warnings: [], blocks: [{ text: 'x', evidenceIds: ['ref_1'] }] }) });
type Choice = (packet: { kind: string; sources: { videoId?: string }[] }) => boolean;
/** Answers by citing the prompt's aliased excerpts whose packets the choice selects. */
function finalizerCiting(choose: Choice, warnings: unknown[] = []) {
  return new MockLanguageModelV4({ doGenerate: async call => {
    if (call.responseFormat?.type !== 'json') return { content: [{ type: 'text', text: 'Context is ready.' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
    const user = call.prompt.find(message => message.role === 'user');
    const text = user && Array.isArray(user.content) ? user.content.find(part => part.type === 'text') : undefined;
    const evidence: { kind: string; sources: { videoId?: string }[]; excerpts: { id: string }[] }[] = JSON.parse(text && 'text' in text ? text.text : '{}').evidence ?? [];
    const refs = evidence.filter(choose).flatMap(packet => packet.excerpts.map(excerpt => excerpt.id));
    return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'medium', warnings,
      blocks: refs.map(ref => ({ text: `Metadata detail ${ref}.`, evidenceIds: [ref] })) }) }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
  } });
}
const kind = (name: string): Choice => packet => packet.kind === name;
function finalized(ctx: AgentToolContext, decision: CapabilityRouteDecision) {
  const input = vi.mocked(ctx.finalize).mock.calls.at(-1)![1];
  const view = compactAgentResult({ ...input, answer: input.answer.replace(/\[cite:[^\]]+\]/g, ''), citations: [], runId: 'metadata-run',
    conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(),
    billing: { creditsCharged: 2, creditsRemaining: 100 } } as never, [], decision);
  return { input, view, codes: input.warnings.map(warning => warning.code), messages: input.warnings.map(warning => warning.message),
    coverage: input.artifacts.find(artifact => artifact.type === 'research_coverage')?.data };
}
async function run(decision: TopicRoute, recoveredEvidence: EvidencePacket[], choose: Choice, ctx = context(), warnings: unknown[] = []) {
  const finalizer = finalizerCiting(choose, warnings);
  const model = finishNow();
  await runResearchAgentWithModel({ model, finalizationModel: finalizer, context: ctx, message: 'Find exactly two videos using metadata only.',
    decision, recoveredSearchUsed: true, recoveredEvidence, toolNames: ['get_video', 'finalize_answer'] });
  return { ...finalized(ctx, decision), ctx, model, finalizer };
}

describe('QA021 metadata-scoped completeness', () => {
  it('answers a metadata-only discovery when both reported videos cite get_video metadata', async () => {
    const result = await run(discovery('metadata'), [search, metadata(first), metadata(second)], kind('youtube_video'));
    const prompt = JSON.stringify(result.model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('This metadata-only scope overrides the transcript research steps above');
    expect(prompt).not.toContain('Analyze selected transcripts together.');
    expect(result.coverage).toEqual({ targetVideos: 2, reviewedVideos: 0, requiredVideos: 2, metadataVideos: 2 });
    expect(result.codes).not.toContain('PARTIAL_EVIDENCE');
    expect(result.view).toMatchObject({ outcome: 'answered', coverage: { reviewedVideos: 0, metadataVideos: 2 } });
    expect(result.ctx.provider.transcript).not.toHaveBeenCalled();
  });

  it('does not let search candidates or uncited metadata fulfill the count', async () => {
    const result = await run(discovery('metadata'), [search, metadata(first), metadata(second)], kind('youtube_search'));
    expect(result.coverage).toMatchObject({ metadataVideos: 0 });
    expect(result.messages).toContain('The user requested 2 videos from metadata; the answer cites video metadata for 0.');
    expect(result.view.outcome).toBe('partial');
  });

  it('stays partial when only one reported video cites metadata', async () => {
    const result = await run(discovery('metadata'), [search, metadata(first), metadata(second)],
      packet => packet.kind === 'youtube_video' && packet.sources.some(source => source.videoId === first));
    expect(result.coverage).toMatchObject({ metadataVideos: 1, requiredVideos: 2 });
    expect(result.view.outcome).toBe('partial');
  });

  it('does not substitute content reviews for requested metadata verification or show that content to the finalizer', async () => {
    const result = await run(discovery('metadata'), [search, metadata(first), metadata(second), transcript(first), transcript(second)],
      packet => packet.kind === 'youtube_video' && packet.sources.some(source => source.videoId === first));
    expect(result.coverage).toMatchObject({ reviewedVideos: 2, metadataVideos: 1, requiredVideos: 2 });
    expect(result.messages).toContain('The user requested 2 videos from metadata; the answer cites video metadata for 1.');
    expect(result.view.outcome).toBe('partial');
    expect(JSON.stringify(result.finalizer.doGenerateCalls.map(call => call.prompt))).not.toContain('Spoken words');
  });

  it('keeps content semantics and the transcript shortfall without an explicit scope', async () => {
    const result = await run(discovery(), [search, metadata(first), metadata(second)], kind('youtube_video'));
    const prompt = JSON.stringify(result.model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('Analyze selected transcripts together.');
    expect(prompt).not.toContain('metadata-only scope');
    expect(result.coverage).toEqual({ targetVideos: 2, reviewedVideos: 0, requiredVideos: 2 });
    expect(result.messages).toContain('The user requested 2 source videos; usable transcript or analyzed visual evidence was reviewed from 0.');
    expect(result.view.outcome).toBe('partial');
  });

  it.each([['helpful'], ['required'], [undefined]] as const)('treats a persisted metadata scope with visualEvidence %s as content', async visualEvidence => {
    const decision = { ...discovery('metadata'), visualEvidence, ...(visualEvidence === 'required' ? { visualRequirements: ['slides'] } : {}) } as TopicRoute;
    if (visualEvidence === undefined) delete (decision as { visualEvidence?: unknown }).visualEvidence;
    expect(hasMetadataScope(decision)).toBe(false);
    const result = await run(decision, [search, metadata(first), metadata(second)], kind('youtube_video'));
    expect(result.coverage).not.toHaveProperty('metadataVideos');
    expect(result.codes).toContain('PARTIAL_EVIDENCE');
    expect(JSON.stringify(result.model.doGenerateCalls[0]?.prompt)).not.toContain('Evidence scope: metadata only');
  });

  it('keeps independent warnings in metadata scope', async () => {
    const result = await run(discovery('metadata', { channelId: '@jawed' }), [search, metadata(first), metadata(second)], kind('youtube_video'),
      context(), [{ code: 'ANSWER_SCOPE_SHORTFALL', message: 'One duration could not be verified.' }]);
    expect(result.codes).toEqual(expect.arrayContaining(['PARTIAL_EVIDENCE', 'CHANNEL_INSPECTION_INCOMPLETE']));
    expect(result.view.outcome).toBe('partial');
  });

  it('answers the fixed two-video metadata comparison after two get_video calls (2026-10-06 22:37 shape)', async () => {
    const ctx = context();
    let step = 0;
    const model = new MockLanguageModelV4({ doGenerate: async call => {
      if (step === 0) expect(JSON.stringify(call.prompt)).toContain('Evidence scope: metadata only');
      const calls = [['get_video', { videoId: comments }], ['get_video', { videoId: zoo }],
        ['finalize_answer', { intent: 'topic_research', confidence: 'medium', artifacts: [], warnings: [], blocks: [{ text: 'x', evidenceIds: ['ref_1'] }] }]] as const;
      const [name, input] = calls[Math.min(step, 2)]!;
      return toolCall(`step-${step++}`, name, input);
    } });
    const decision = comparison('metadata');
    const finalizer = finalizerCiting(kind('youtube_video'));
    await runResearchAgentWithModel({ model, finalizationModel: finalizer, context: ctx, message: LIVE_COMPARISON_PROMPT, decision,
      toolNames: ['get_video', 'get_video_transcript', 'finalize_answer'] });
    const result = finalized(ctx, decision);
    expect(ctx.provider.video).toHaveBeenCalledTimes(2);
    expect(ctx.provider.transcript).not.toHaveBeenCalled();
    expect(JSON.stringify(finalizer.doGenerateCalls.at(-1)?.prompt)).toContain('route.evidenceScope is metadata');
    expect(result.coverage).toEqual({ targetVideos: 2, reviewedVideos: 0, requiredVideos: 2, metadataVideos: 2 });
    expect(result.codes).not.toContain('PARTIAL_EVIDENCE');
    expect(result.view.outcome).toBe('answered');
  });

  it('reproduces the transcript shortfall for the same comparison without an explicit scope', async () => {
    const result = await run(comparison(), [metadata(comments), metadata(zoo)], kind('youtube_video'));
    expect(result.messages).toContain('The user requested 2 source videos; usable transcript or analyzed visual evidence was reviewed from 0.');
    expect(result.view.outcome).toBe('partial');
  });
});

describe('QA021 finalizer does not read excluded saved content', () => {
  const versions = [comments, zoo].map((_, index) => String(index + 7).repeat(64));
  function savedSession(ctx: AgentToolContext) {
    const saved = [comments, zoo].map((videoId, index) => ({ ...transcript(videoId), packetId: `saved:${videoId}`, assetVersions: [versions[index]!],
      artifacts: [{ type: 'youtube_complete_transcript', data: { requiresAnalysis: false } }] }));
    const readTranscriptEvidence = vi.fn(async (version: string) => ({ packets: [saved[versions.indexOf(version)]!] }));
    const readEvidence = vi.fn(async (version: string) => ({ packets: [saved[versions.indexOf(version)]!] }));
    const evidence = vi.fn((version?: string) => saved.filter(packet => packet.assetVersions.includes(version!)));
    const searchTools = vi.fn(async (_onFound: unknown, _signal: unknown, _options?: { evidence?: boolean }) => ({}));
    ctx.session = { brief: () => ({ assets: [comments, zoo].map((videoId, index) => ({ version: versions[index]!, kind: 'transcript' as const, videoId,
      current: true, collectedAt: 1, details: {} })), memories: [] }), readTranscriptEvidence, readEvidence, evidence, searchTools } as never;
    const deliverEvidence = vi.fn((packets: EvidencePacket[]) => ({ admitted: packets, withheld: [], unavailable: [], receipts: [] }));
    ctx.deliverEvidence = deliverEvidence as never;
    return { readTranscriptEvidence, readEvidence, evidence, deliverEvidence, searchTools };
  }
  // The context step asks for a saved transcript, which metadata scope must not admit.
  const contextFinalizer = (choose: Choice) => {
    const answer = finalizerCiting(choose);
    let contextStep = 0;
    return new MockLanguageModelV4({ doGenerate: async call => call.responseFormat?.type === 'json' ? answer.doGenerate(call)
      : contextStep++ === 0 ? toolCall('read', 'read_session_evidence', { version: versions[0] })
        : { content: [{ type: 'text', text: 'Context is ready.' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] } });
  };
  const deliveredKinds = (deliver: ReturnType<typeof savedSession>['deliverEvidence']) => deliver.mock.calls.flatMap(([packets]) => packets.map(packet => packet.kind));

  it('skips comparison transcript preload and filters context reads in metadata scope', async () => {
    const ctx = context();
    const spies = savedSession(ctx);
    const decision = comparison('metadata');
    const finalizer = contextFinalizer(kind('youtube_video'));
    await runResearchAgentWithModel({ model: finishNow(), finalizationModel: finalizer, context: ctx, message: LIVE_COMPARISON_PROMPT, decision,
      recoveredSearchUsed: true, recoveredEvidence: [metadata(comments), metadata(zoo)], toolNames: ['finalize_answer'] });
    expect(spies.readTranscriptEvidence).not.toHaveBeenCalled();
    expect(spies.readEvidence).toHaveBeenCalledOnce();
    // Content search is disabled, so filtered hits cannot read as an exhausted credit reserve.
    expect(spies.searchTools).toHaveBeenCalledWith(expect.any(Function), expect.anything(), { evidence: false });
    expect(deliveredKinds(spies.deliverEvidence)).not.toContain('youtube_transcript');
    expect(JSON.stringify(finalizer.doGenerateCalls.at(-1)?.prompt)).not.toContain('Spoken words');
    expect(finalized(ctx, decision).view.outcome).toBe('answered');
  });

  it('skips the synchronous recovery restore in metadata scope', async () => {
    const ctx = context();
    const spies = savedSession(ctx);
    await runResearchAgentWithModel({ model: finishNow(), finalizationModel: finalizerCiting(kind('youtube_video')), context: ctx,
      message: LIVE_COMPARISON_PROMPT, decision: comparison('metadata'), finalizationDeadlineAt: Date.now() - 1_000,
      recoveredSearchUsed: true, recoveredEvidence: [metadata(comments), metadata(zoo)], toolNames: ['finalize_answer'] });
    expect(spies.evidence).not.toHaveBeenCalled();
    expect(deliveredKinds(spies.deliverEvidence)).not.toContain('youtube_transcript');
  });

  it('still preloads and admits saved transcripts for an ordinary content comparison', async () => {
    const ctx = context();
    const spies = savedSession(ctx);
    await runResearchAgentWithModel({ model: finishNow(), finalizationModel: contextFinalizer(kind('youtube_transcript')), context: ctx,
      message: 'Compare what both videos say.', decision: comparison(), recoveredSearchUsed: true,
      recoveredEvidence: [metadata(comments), metadata(zoo)], toolNames: ['finalize_answer'] });
    expect(spies.readTranscriptEvidence).toHaveBeenCalledTimes(2);
    expect(spies.searchTools).toHaveBeenCalledWith(expect.any(Function), expect.anything(), { evidence: true });
    expect(deliveredKinds(spies.deliverEvidence)).toContain('youtube_transcript');
  });
});

describe('QA021 metadata scope classification', () => {
  const classifier = (...outputs: Record<string, unknown>[]) => {
    let call = 0;
    return new MockLanguageModelV4({ doGenerate: async () => toolCall(`classify-${call}`, 'classify_request',
      { answerDetail: 'standard', ...outputs[Math.min(call++, outputs.length - 1)] }) });
  };
  const classify = (message: string, model: MockLanguageModelV4, fallbackModel?: MockLanguageModelV4) =>
    classifyCapabilityWithModel({ message, model, fallbackModel, signal: new AbortController().signal });
  const discoveryCandidate = { route: 'topic_research', researchBreadth: 'focused', searchQuery: 'Python list comprehensions',
    explicitSourceCount: 2, visualEvidence: 'none', evidenceScope: 'metadata' };

  it('persists an explicitly classified metadata scope for discovery', async () => {
    await expect(classify('Find exactly two Python list comprehension videos using search and video metadata only.', classifier(discoveryCandidate)))
      .resolves.toMatchObject({ route: 'topic_research', requiredVideoCount: 2, evidenceScope: 'metadata' });
  });

  it('persists an explicitly classified metadata scope for the fixed two-video comparison', async () => {
    const decision = await classify(LIVE_COMPARISON_PROMPT, classifier({ route: 'topic_research', comparisonVideoIds: [comments, zoo],
      visualEvidence: 'none', evidenceScope: 'metadata' }));
    expect(decision).toMatchObject({ route: 'topic_research', comparisonVideoIds: [comments, zoo], evidenceScope: 'metadata' });
    expect(hasMetadataScope(decision)).toBe(true);
  });

  it.each([
    ['visual evidence', { ...discoveryCandidate, visualEvidence: 'helpful' }],
    ['a content scope', { ...discoveryCandidate, evidenceScope: 'content' }],
    ['no stated scope', { ...discoveryCandidate, evidenceScope: undefined }],
  ])('keeps content semantics with %s', async (_label, candidate) => {
    const decision = await classify('Find two Python list comprehension videos.', classifier(candidate));
    expect(decision).not.toHaveProperty('evidenceScope');
  });

  it('does not carry metadata scope into inspection or finalization', async () => {
    const inspected = await classify(`Give the duration of https://www.youtube.com/watch?v=${zoo} using metadata only.`,
      classifier({ route: 'inspect_video', videoId: zoo, visualEvidence: 'none', evidenceScope: 'metadata' }));
    expect(inspected).toMatchObject({ route: 'inspect_video' });
    expect(inspected).not.toHaveProperty('evidenceScope');
    const finalized = await classify('What did I ask first?', classifier({ route: 'finalize', responseIntent: 'context_answer', contextScope: 'history',
      reason: 'History.', evidenceScope: 'metadata' }));
    expect(finalized).toMatchObject({ route: 'finalize' });
    expect(finalized).not.toHaveProperty('evidenceScope');
  });

  it('repairs an invalid scope value instead of accepting it', async () => {
    const model = classifier({ ...discoveryCandidate, evidenceScope: 'metadata_only' }, { ...discoveryCandidate, evidenceScope: undefined });
    const decision = await classify('Find two Python list comprehension videos using metadata only.', model);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(decision).not.toHaveProperty('evidenceScope');
  });

  it('drops metadata scope on every last-resort path', async () => {
    const { route: _route, ...missingRoute } = discoveryCandidate;
    const recovered = await classify('Find two Python list comprehension videos using metadata only.', classifier(missingRoute), classifier(missingRoute));
    expect(recovered).toMatchObject({ route: 'topic_research', requiredVideoCount: 2 });
    expect(recovered).not.toHaveProperty('evidenceScope');
    const corrupted = { ...discoveryCandidate, route: 'research' };
    const assembled = await classify('Find two Python list comprehension videos using metadata only.', classifier(corrupted), classifier(corrupted));
    expect(assembled).toMatchObject({ route: 'topic_research' });
    expect(assembled).not.toHaveProperty('evidenceScope');
  });

  it('parses legacy and persisted routes for recovery without changing their semantics', () => {
    const legacy = capabilityRouteDecisionSchema.parse({ route: 'topic_research', researchVideoCount: 2, requiredVideoCount: 2, researchBreadth: 'focused' });
    expect(hasMetadataScope(legacy)).toBe(false);
    const persisted = capabilityRouteDecisionSchema.parse(JSON.parse(JSON.stringify(comparison('metadata'))));
    expect(persisted).toMatchObject({ evidenceScope: 'metadata' });
    expect(hasMetadataScope(persisted)).toBe(true);
    expect(capabilityRouteDecisionSchema.safeParse({ ...comparison('metadata'), evidenceScope: 'metadata_only' }).success).toBe(false);
  });
});

describe('citedMetadataVideoIds', () => {
  it('counts only cited, nonblank, source-linked get_video excerpts and comparison subjects', () => {
    const blank = { ...metadata(second), excerpts: [{ ...metadata(second).excerpts[0]!, text: ' ' }] };
    const unlinked = { ...metadata(zoo), excerpts: [{ ...metadata(zoo).excerpts[0]!, sourceId: 'elsewhere' }] };
    const answer = `[cite:metadata:${first}:0] [cite:metadata:${second}:0] [cite:metadata:${zoo}:0] [cite:search:0]`;
    expect([...citedMetadataVideoIds([metadata(first), blank, unlinked, search], answer)]).toEqual([first]);
    expect(citedMetadataVideoIds([metadata(first), metadata(comments)], `[cite:metadata:${first}:0][cite:metadata:${comments}:0]`, [comments, zoo]).size).toBe(1);
  });
});
