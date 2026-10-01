import { attachTestAssetStore } from './fixtures/analysis-session';
import { executeAnalyzeVideoTranscript } from '../src/agents/providers/youtube/tools/analyze-video-transcripts';
import { evidencePacketForModel } from '../src/agents/runtime/model-evidence';
import type { SearchResponse, Transcript, VideoSummary } from 'all-things-youtube';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';
import {
  executeGetVideoTranscript,
  executeGetVideoTranscriptForModel,
} from '../src/agents/providers/youtube/tools/get-video-transcript';
import { createInspectVideoTools, INSPECT_VIDEO_TOOL_NAMES } from '../src/agents/research/capabilities/inspect-video';
import { createResearchTopicTools, RESEARCH_TOPIC_TOOL_NAMES } from '../src/agents/research/capabilities/research-topic';
import { createCapabilityToolSet } from '../src/agents/providers/youtube/tool-library';
import { YOUTUBE_PROVIDER_TOOL_NAMES } from '../src/agents/providers/youtube/tool-names';
import { executeSearchYouTube, searchYouTubeInputSchema } from '../src/agents/providers/youtube/tools/search-youtube';
import type { EvidencePacket } from '../src/agents/contracts';

async function retrieveAndAnalyzeTranscript(input: Parameters<typeof executeGetVideoTranscript>[0], context: AgentToolContext, id: string) {
  attachTestAssetStore(context);
  const retrieved = await executeGetVideoTranscript(input,context,`${id}-retrieve`);
  return executeAnalyzeVideoTranscript({assetVersion:retrieved.assetVersions![0]!,focus:input.focus!},context,id);
}

describe('YouTube agent evidence tools', () => {
  it('maps one search tool call to one provider request and bounds candidates', async () => {
    const videos = Array.from({ length: 15 }, (_, index) => video(`video0000${String(index).padStart(2, '0')}`.slice(-11), index));
    videos[0]!.isLive = true;
    videos[1]!.isLive = false;
    // Older cached provider results may omit the flag.
    Reflect.deleteProperty(videos[2]!, 'isLive');
    const search = vi.fn(async (): Promise<{ value: SearchResponse; cacheStatus: 'miss' }> => ({
      cacheStatus: 'miss',
      value: {
        query: 'agent UI design skills',
        results: videos,
        videos,
        channels: [],
        playlists: [],
        continuation: 'next-page',
        meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: true, warnings: ['partial data'] },
      },
    }));
    const context = toolContext({ search });

    const packet = await executeSearchYouTube({
      query: 'agent UI design skills',
      type: 'video',
      captionsOnly: true,
    }, context, 'call-search-1');

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('agent UI design skills', expect.objectContaining({ type: 'video', captionsOnly: true }));
    const projected = evidencePacketForModel(packet);
    const candidates = packet.artifacts.find(a => a.type === 'youtube_search_candidates')!.data.candidates as Array<Record<string, unknown>>;
    expect(candidates[0]!.isLive).toBe(true);
    expect(candidates[1]!.isLive).toBe(false);
    expect(candidates[2]!.isLive).toBeUndefined();
    expect(projected.excerpts![0]!.text).toContain('Live now: yes');
    expect(projected.excerpts![1]!.text).toContain('Live now: no');
    expect(projected.excerpts![2]!.text).not.toContain('Live now:');
    expect(packet.sources).toHaveLength(12);
    expect(packet.excerpts).toHaveLength(12);
    expect(packet.continuation).toBe('next-page');
    expect(packet.usage).toEqual([{ operation: 'search', credits: 2, cacheStatus: 'miss' }]);
    expect(packet.warnings.map((warning) => warning.code)).toEqual([
      'YOUTUBE_PROVIDER_WARNING',
      'PARTIAL_YOUTUBE_RESULTS',
    ]);
  });

  it('accepts only one query per search invocation', () => {
    expect(searchYouTubeInputSchema.safeParse({ query: ['one', 'two'] }).success).toBe(false);
    expect(searchYouTubeInputSchema.safeParse({ query: 'one focused query' }).success).toBe(true);
  });

  it('maps one transcript call to one provider request and emits analyst-selected evidence', async () => {
    const transcript = vi.fn(async (): Promise<{ value: Transcript; cacheStatus: 'hit' }> => ({
      cacheStatus: 'hit',
      value: {
        videoId: 'abcdefghijk',
        track: {
          id: 'en',
          name: 'English',
          languageCode: 'en',
          kind: 'manual',
          isTranslatable: true,
          isDefault: true,
        },
        segments: [
          { startMs: 0, durationMs: 10_000, endMs: 10_000, text: 'Start with visual hierarchy and clear interface constraints.' },
          { startMs: 12_000, durationMs: 10_000, endMs: 22_000, text: 'Agents benefit from concrete design critique.' },
          { startMs: 42_000, durationMs: 8_000, endMs: 50_000, text: 'Prototype interaction states before implementation.' },
        ],
        text: 'Start with visual hierarchy.',
        meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
      },
    }));
    const analyzeTranscript = vi.fn(async () => ({
      summary: 'The video recommends visual hierarchy before implementation.',
      findings: [{
        claim: 'Prototype interaction states before implementation.',
        excerptIds: ['transcript:abcdefghijk:2:42000'],
      }],
      excerpts: [{
        id: 'transcript:abcdefghijk:2:42000',
        text: 'Prototype interaction states before implementation.',
        startMs: 42_000,
        endMs: 50_000,
      }],
      warnings: ['No pricing figures in this video.'],
      coverage: {
        completeTranscriptRead: true as const,
        segmentCount: 3,
        startMs: 0,
        endMs: 50_000,
      },
    }));
    const context = toolContext({ transcript, analyzeTranscript });

    const packet = await retrieveAndAnalyzeTranscript({
      videoId: 'abcdefghijk',
      focus: 'visual hierarchy interaction agents',
    }, context, 'call-transcript-1');

    expect(transcript).toHaveBeenCalledTimes(1);
    expect(transcript).toHaveBeenCalledWith('abcdefghijk', undefined, undefined, expect.any(Function));
    expect(analyzeTranscript).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'abcdefghijk',
      researchQuestion: 'Which design practices help an agent produce a better interface?',
      focus: 'visual hierarchy interaction agents',
    }));
    expect(packet.excerpts).toEqual([expect.objectContaining({
      id: 'transcript:abcdefghijk:2:42000',
      text: 'Prototype interaction states before implementation.',
      startMs: 42_000,
      endMs: 50_000,
    })]);
    expect(packet.artifacts[0]).toMatchObject({
      type: 'youtube_transcript_analysis',
      data: { coverage: { completeTranscriptRead: true, segmentCount: 3 } },
    });
    expect(packet.warnings).toContainEqual({ code: 'TRANSCRIPT_ANALYST_WARNING', message: 'No pricing figures in this video.' });
    expect(packet.usage).toEqual([]);
  });

  it('returns compact analyst findings to Agent Core while retaining full citation evidence', async () => {
    const transcript = vi.fn(async (): Promise<{ value: Transcript; cacheStatus: 'hit' }> => ({
      cacheStatus: 'hit',
      value: {
        videoId: 'abcdefghijk',
        track: {
          id: 'en', name: 'English', languageCode: 'en', kind: 'manual',
          isTranslatable: true, isDefault: true,
        },
        segments: [{
          startMs: 0,
          durationMs: 60_000,
          endMs: 60_000,
          text: 'FULL TRANSCRIPT TEXT retained for exact citation validation.',
        }],
        text: 'FULL TRANSCRIPT TEXT retained for exact citation validation.',
        meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
      },
    }));
    const analyzeTranscript = vi.fn(async () => ({
      summary: 'The video recommends TypeScript.',
      findings: [{
        claim: 'TypeScript improves frontend feedback loops.',
        excerptIds: ['transcript:abcdefghijk:window:0:0'],
      }],
      excerpts: [{
        id: 'transcript:abcdefghijk:window:0:0',
        text: 'FULL TRANSCRIPT TEXT retained for exact citation validation.',
        startMs: 0,
        endMs: 60_000,
      }],
      warnings: [],
      coverage: {
        completeTranscriptRead: true as const,
        segmentCount: 1,
        startMs: 0,
        endMs: 60_000,
      },
    }));
    const context = toolContext({ transcript, analyzeTranscript });
    const persisted: EvidencePacket[] = [];
    context.executeEvidenceTool = async (execution) => {
      const packet = await execution.execute();
      persisted.push(packet);
      return packet;
    };

    const analyzed = await retrieveAndAnalyzeTranscript({
      videoId: 'abcdefghijk',
      focus: 'frontend skills',
    }, context, 'call-transcript-model-result');
    const modelResult = evidencePacketForModel(analyzed);

    expect(JSON.stringify(modelResult)).not.toContain('FULL TRANSCRIPT TEXT');
    expect(modelResult).toMatchObject({
      transcriptAnalysis: {
        summary: 'The video recommends TypeScript.',
        findings: [{
          claim: 'TypeScript improves frontend feedback loops.',
          excerptIds: ['transcript:abcdefghijk:window:0:0'],
        }],
      },
    });
    expect(persisted[0]?.excerpts[0]?.text).toBe(
      'FULL TRANSCRIPT TEXT retained for exact citation validation.',
    );
  });
});

describe('TranscriptAnalyst', () => {
  it('accepts compact findings without a generated summary and preserves attributed caveats and exact citations', async () => {
    const claim = 'The speaker reports faster prototypes with reusable skills; cross-agent equivalence was not demonstrated.';
    const result = await analyzeTranscriptWithModel({
      model: transcriptAnalysisModel({ findings: [{ claim, windowIndexes: [0] }],
        warnings: ['The demonstration does not independently establish cross-agent equivalence.'] }),
      videoId: 'abcdefghijk', researchQuestion: 'Which design skills work across agents?', focus: 'Demonstrated benefits and caveats',
      segments: [{ startMs: 0, durationMs: 1000, endMs: 1000, text: 'We made prototypes faster, but only tested this agent.' }],
      signal: new AbortController().signal,
    });
    expect(result.findings).toEqual([{ claim, excerptIds: ['transcript:abcdefghijk:window:0:0'], entities: [], quantities: [], uncertainty: null }]);
    expect(result.excerpts[0]?.text).toBe('We made prototypes faster, but only tested this agent.');
    expect(result.warnings).toEqual(['The demonstration does not independently establish cross-agent equivalence.']);
    expect(result.summary).toBe('Selected 1 relevant transcript finding.');
  });

  it('reads every transcript segment and resolves an application-owned analysis window', async () => {
    const model = transcriptAnalysisModel({
      summary: 'The final segment contains the evidence relevant to the research question.',
      findings: [{
        claim: 'The implementation should follow the prototype.',
        windowIndexes: [1],
      }],
      warnings: [],
    });
    const controller = new AbortController();
    const result = await analyzeTranscriptWithModel({
      model,
      videoId: 'abcdefghijk',
      researchQuestion: 'Which design practices improve implementation quality?',
      focus: 'prototype before implementation',
      segments: [
        { startMs: 0, durationMs: 10_000, endMs: 10_000, text: 'The complete transcript starts here.' },
        { startMs: 12_000, durationMs: 10_000, endMs: 22_000, text: 'This middle segment adds context.' },
        { startMs: 65_000, durationMs: 8_000, endMs: 73_000, text: 'Prototype interaction states before implementation.' },
      ],
      signal: controller.signal,
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(2_400);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('at most 5 distinct findings');
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain('The complete transcript starts here.');
    expect(prompt).toContain('This middle segment adds context.');
    expect(prompt).toContain('Prototype interaction states before implementation.');
    expect(result.excerpts).toEqual([{
      id: 'transcript:abcdefghijk:window:1:65000',
      text: 'Prototype interaction states before implementation.',
      startMs: 65_000,
      endMs: 73_000,
    }]);
    expect(result.coverage).toEqual({
      completeTranscriptRead: true,
      segmentCount: 3,
      startMs: 0,
      endMs: 73_000,
    });
  });

  it('retains up to five supported findings per video', async () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({ claim: `Finding ${i + 1}`, windowIndexes: [i] }));
    const result = await analyzeTranscriptWithModel({
      model: transcriptAnalysisModel({ summary: 'Five relevant points.', findings, warnings: [] }),
      videoId: 'abcdefghijk', researchQuestion: 'List ten lessons from this video', focus: 'Ten distinct lessons',
      segments: findings.map((_, i) => ({ startMs: i * 65_000, durationMs: 1000, endMs: i * 65_000 + 1000, text: `Evidence ${i + 1}` })),
      signal: new AbortController().signal,
    });
    expect(result.findings).toHaveLength(5);
    expect(result.excerpts).toHaveLength(5);
  });

  it('retains ten findings when classification requests ten items', async () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({ claim: `Finding ${i + 1}`, windowIndexes: [i] }));
    const result = await analyzeTranscriptWithModel({
      model: transcriptAnalysisModel({ findings, warnings: [] }), maxFindings: 10,
      videoId: 'abcdefghijk', researchQuestion: 'List ten lessons', focus: 'Ten distinct lessons',
      segments: findings.map((_, i) => ({ startMs: i * 65_000, durationMs: 1000, endMs: i * 65_000 + 1000, text: `Evidence ${i + 1}` })),
      signal: new AbortController().signal,
    });
    expect(result.findings).toHaveLength(10);
    expect(result.excerpts).toHaveLength(10);
  });

  it('rejects analyst output exceeding the five-finding budget', async () => {
    await expect(analyzeTranscriptWithModel({
      model: transcriptAnalysisModel({ summary: 'Too many findings.',
        findings: Array.from({ length: 6 }, (_, i) => ({ claim: `Finding ${i}`, windowIndexes: [0] })), warnings: [] }),
      videoId: 'abcdefghijk', researchQuestion: 'List useful lessons', focus: 'Relevant findings',
      segments: [{ startMs: 0, endMs: 1000, durationMs: 1000, text: 'Transcript evidence.' }],
      signal: new AbortController().signal,
    })).rejects.toThrow();
  });

  it('repairs an out-of-range window reference once before resolving evidence', async () => {
    const model = transcriptAnalysisModel([{
      summary: 'The first attempt referenced an unavailable window.',
      findings: [{ claim: 'Use exact transcript evidence.', windowIndexes: [31] }],
      warnings: [],
    }, {
      summary: 'The transcript recommends exact evidence.',
      findings: [{ claim: 'Use exact transcript evidence.', windowIndexes: [0] }],
      warnings: [],
    }]);
    const controller = new AbortController();

    const result = await analyzeTranscriptWithModel({
      model,
      videoId: 'abcdefghijk',
      researchQuestion: 'What does the video recommend?',
      focus: 'recommendations',
      segments: [{ startMs: 0, durationMs: 10_000, endMs: 10_000, text: 'Use exact transcript evidence.' }],
      signal: controller.signal,
    });

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('31');
    expect(result.excerpts).toEqual([{
      id: 'transcript:abcdefghijk:window:0:0',
      text: 'Use exact transcript evidence.',
      startMs: 0,
      endMs: 10_000,
    }]);
  });
});

describe('YouTube agent capability tool sets', () => {
  it('provides one reusable wrapper for every provider operation', () => {
    const context = toolContext({});
    expect(Object.keys(createCapabilityToolSet(context, YOUTUBE_PROVIDER_TOOL_NAMES)))
      .toEqual([...YOUTUBE_PROVIDER_TOOL_NAMES]);
  });

  it('loads a broad research set without video-operational tools', () => {
    const tools = createResearchTopicTools(toolContext({}));
    expect(Object.keys(tools)).toEqual([...RESEARCH_TOPIC_TOOL_NAMES]);
    expect(tools).not.toHaveProperty('get_video_tracks');
    expect(tools).not.toHaveProperty('get_video_endscreen');
  });

  it('loads only video-specific evidence tools for inspect_video', () => {
    const tools = createInspectVideoTools(toolContext({}, { mode: 'complete_transcript' }));
    expect(Object.keys(tools)).toEqual([...INSPECT_VIDEO_TOOL_NAMES]);
    expect(tools).not.toHaveProperty('search_youtube');
    expect(tools).not.toHaveProperty('research_youtube_trends');
    expect(tools).not.toHaveProperty('get_channel');
  });

  it('returns the complete available transcript directly in inspect mode', async () => {
    const transcript = vi.fn(async (): Promise<{ value: Transcript; cacheStatus: 'hit' }> => ({
      cacheStatus: 'hit',
      value: {
        videoId: 'abcdefghijk',
        track: {
          id: 'en', name: 'English', languageCode: 'en', kind: 'manual',
          isTranslatable: true, isDefault: true,
        },
        segments: [
          { startMs: 0, durationMs: 1_000, endMs: 1_000, text: 'First segment.' },
          { startMs: 1_000, durationMs: 1_000, endMs: 2_000, text: 'Middle segment.' },
          { startMs: 2_000, durationMs: 1_000, endMs: 3_000, text: 'Final segment.' },
        ],
        text: 'First segment. Middle segment. Final segment.',
        meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
      },
    }));
    const context = toolContext({ transcript }, { mode: 'complete_transcript' });

    const packet = await executeGetVideoTranscript({
      videoId: 'abcdefghijk',
    }, context, 'inspect-transcript');

    expect(transcript).toHaveBeenCalledTimes(1);
    expect(packet.excerpts.map((excerpt) => excerpt.text)).toEqual([
      'First segment.', 'Middle segment.', 'Final segment.',
    ]);
    expect(packet.artifacts[0]).toMatchObject({
      type: 'youtube_complete_transcript',
      data: { allReturnedSegmentsIncluded: true, segmentCount: 3, excerptCount: 3 },
    });
  });

  it('identifies transcript-analysis timeouts separately from transcript retrieval failures', async () => {
    const transcript = vi.fn(async (): Promise<{ value: Transcript; cacheStatus: 'hit' }> => ({
      cacheStatus: 'hit',
      value: {
        videoId: 'abcdefghijk',
        track: {
          id: 'en', name: 'English', languageCode: 'en', kind: 'manual',
          isTranslatable: true, isDefault: true,
        },
        segments: [{ startMs: 0, durationMs: 1_000, endMs: 1_000, text: 'Retrieved successfully.' }],
        text: 'Retrieved successfully.',
        meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
      },
    }));
    const analyzeTranscript = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    });
    const context = toolContext({ transcript, analyzeTranscript });

    await expect(retrieveAndAnalyzeTranscript({
      videoId: 'abcdefghijk',
      focus: 'the main recommendation',
    }, context, 'timed-out-analysis')).rejects.toThrow(
      'TRANSCRIPT_ANALYSIS_TIMEOUT: The operation was aborted due to timeout',
    );
    expect(transcript).toHaveBeenCalledTimes(1);
    expect(analyzeTranscript).toHaveBeenCalledTimes(1);
  });
});

describe('YouTube agent deterministic finalizer', () => {
  it('builds the public envelope only from exact persisted evidence', () => {
    const packet = evidencePacket();
    const result = buildAgentTurnResult(identity(), admission(), {
      answer: 'Visual hierarchy is a foundational skill. [cite:transcript:abcdefghijk:0]',
      intent: 'topic_research',
      confidence: 'high',
      citations: [{
        packetId: packet.packetId,
        sourceId: packet.sources[0]!.id,
        excerptId: packet.excerpts[0]!.id,
      }],
      artifacts: [],
      warnings: [],
    }, [packet], 3);

    expect(result.citations[0]).toMatchObject({
      id: 'transcript:abcdefghijk:0',
      startMs: 0,
      endMs: 30_000,
    });
    expect(result.billing).toEqual({ creditsCharged: 3, creditsRemaining: 97 });
  });

  it('derives missing citation declarations from persisted inline markers', () => {
    const packet = evidencePacket();
    const result = buildAgentTurnResult(identity(), admission(), {
      answer: 'Visual hierarchy matters. [cite:transcript:abcdefghijk:0]',
      intent: 'topic_research', confidence: 'high', citations: [], artifacts: [], warnings: [],
    }, [packet], 1);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ id: packet.excerpts[0]!.id, excerpt: packet.excerpts[0]!.text });
  });

  it('rejects conflicting persisted excerpts with the same citation ID', () => {
    const packet = evidencePacket();
    const conflicting = { ...packet, packetId: 'other', excerpts: packet.excerpts.map(e => ({ ...e, text: 'Conflicting evidence' })) };
    expect(() => buildAgentTurnResult(identity(), admission(), {
      answer: 'A claim. [cite:transcript:abcdefghijk:0]', intent: 'topic_research',
      confidence: 'high', citations: [], artifacts: [], warnings: [],
    }, [packet, conflicting], 1)).toThrow(expect.objectContaining({ code: 'INVALID_AGENT_CITATION', reason: 'conflicting_evidence' }));
  });

  it('does not manufacture references for an answer without markers', () => {
    expect(() => buildAgentTurnResult(identity(), admission(), {
      answer: 'An unsupported answer.', intent: 'topic_research', confidence: 'low',
      citations: [], artifacts: [], warnings: [],
    }, [evidencePacket()], 1)).toThrow(/inline citation markers/);
  });

  it('rejects citation identifiers that were not persisted', () => {
    const packet = evidencePacket();
    expect(() => buildAgentTurnResult(identity(), admission(), {
      answer: 'An unsupported claim. [cite:transcript:invented:0]',
      intent: 'topic_research',
      confidence: 'low',
      citations: [{
        packetId: packet.packetId,
        sourceId: packet.sources[0]!.id,
        excerptId: 'transcript:invented:0',
      }],
      artifacts: [],
      warnings: [],
    }, [packet], 1)).toThrow(expect.objectContaining({ code: 'INVALID_AGENT_CITATION', reason: 'missing_evidence' }));
  });
});

function toolContext(overrides: Partial<AgentToolContext['provider']> & {
  analyzeTranscript?: Extract<AgentToolContext['transcriptPolicy'], { mode: 'contextual_analysis' }>['analyze'];
}, transcriptPolicy?: AgentToolContext['transcriptPolicy']): AgentToolContext {
  const controller = new AbortController();
  const { analyzeTranscript, ...providerOverrides } = overrides;
  const unexpected = vi.fn(async () => { throw new Error('Unexpected provider call.'); });
  return {
    runId: crypto.randomUUID(),
    signal: controller.signal,
    provider: {
      search: overrides.search ?? vi.fn(async () => { throw new Error('Unexpected search call.'); }),
      browse: unexpected,
      trends: unexpected,
      video: unexpected,
      tracks: unexpected,
      transcript: overrides.transcript ?? vi.fn(async () => { throw new Error('Unexpected transcript call.'); }),
      comments: unexpected,
      endscreen: unexpected,
      channel: unexpected,
      channelVideos: unexpected,
      channelPlaylists: unexpected,
      playlist: unexpected,
      ...providerOverrides,
    },
    transcriptPolicy: transcriptPolicy ?? {
      mode: 'contextual_analysis',
      researchQuestion: 'Which design practices help an agent produce a better interface?',
      analyze: analyzeTranscript ?? vi.fn(async () => { throw new Error('Unexpected transcript analysis.'); }),
    },
    executeEvidenceTool: (execution) => execution.execute(),
    finalize: vi.fn(async () => { throw new Error('Unexpected finalize call.'); }),
  };
}

type TranscriptAnalysisOutput = {
  summary?: string;
  findings: Array<{ claim: string; windowIndexes: number[] }>;
  warnings: string[];
};

function transcriptAnalysisModel(output: TranscriptAnalysisOutput | TranscriptAnalysisOutput[]): MockLanguageModelV4 {
  const outputs = Array.isArray(output) ? output : [output];
  let callIndex = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(outputs[Math.min(callIndex++, outputs.length - 1)]) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: 50, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function video(id: string, index: number): VideoSummary {
  return {
    type: 'video',
    id,
    title: `Design agents lesson ${index}`,
    description: 'A practical lesson about UI design and agent workflows.',
    channel: { id: `channel-${index}`, name: `Design Channel ${index}`, url: `https://www.youtube.com/channel/channel-${index}` },
    thumbnails: [],
    viewCount: 1_000 + index,
    viewCountText: `${1_000 + index} views`,
    publishedTimeText: '1 month ago',
    durationSeconds: 600,
    durationText: '10:00',
    isLive: false,
    hasCaptions: true,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function evidencePacket(): EvidencePacket {
  return {
    packetId: 'packet:run:transcript',
    kind: 'youtube_transcript',
    sources: [{
      id: 'youtube:abcdefghijk:transcript',
      provider: 'youtube',
      kind: 'transcript',
      videoId: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    }],
    excerpts: [{
      id: 'transcript:abcdefghijk:0',
      sourceId: 'youtube:abcdefghijk:transcript',
      text: 'Visual hierarchy helps users understand an interface.',
      startMs: 0,
      endMs: 30_000,
    }],
    artifacts: [],
    warnings: [],
    usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'hit' }],
  };
}

function identity() {
  return {
    runId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(),
    agentMessageId: crypto.randomUUID(),
  };
}

function admission() {
  return {
    userId: 'user-1',

    creditsRemaining: 100,
  };
}

describe('long transcript retrieval', () => {
  function longTranscript(): Transcript {
    const segments = Array.from({ length: 6001 }, (_, i) => ({ startMs: i * 3000,
      endMs: (i + 1) * 3000, durationMs: 3000, text: `Caption ${i}.` }));
    return { videoId: 'abcdefghijk', track: { id: 'en', name: 'English', languageCode: 'en',
      kind: 'manual', isTranslatable: true, isDefault: true }, segments,
      text: segments.map(segment => segment.text).join(' '),
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] } };
  }
  it('returns bounded inspect evidence and preserves every saved segment', async () => {
    const original = longTranscript();
    const ctx = toolContext({ transcript: async () => ({ value: original, cacheStatus: 'hit' }) }, { mode: 'complete_transcript' });
    attachTestAssetStore(ctx);
    const packet = await executeGetVideoTranscript({ videoId: original.videoId }, ctx, 'long-inspect');
    expect(packet.excerpts).toHaveLength(5000);
    expect(packet.artifacts[0]?.data).toMatchObject({ allReturnedSegmentsIncluded: false,
      segmentCount: 6001, excerptCount: 6001, returnedExcerptCount: 5000, nextOffset: 5000, endMs: 18003000 });
    expect(packet.warnings).toContainEqual(expect.objectContaining({ code: 'TRANSCRIPT_CONTEXT_TRUNCATED' }));
    const stored = await ctx.session!.readAsset!(packet.assetVersions![0]!);
    expect((stored!.value as Transcript).segments).toEqual(original.segments);
  });
  it('passes all segments, including the final one, to research analysis', async () => {
    const original = longTranscript();
    const analyze = vi.fn(async () => ({ summary: 'Late caption found.', findings: [], excerpts: [], warnings: [],
      coverage: { completeTranscriptRead: true as const, segmentCount: 6001, startMs: 0, endMs: 18003000 } }));
    const ctx = toolContext({ transcript: async () => ({ value: original, cacheStatus: 'hit' }), analyzeTranscript: analyze });
    attachTestAssetStore(ctx);
    const packet = await executeGetVideoTranscriptForModel({ videoId: original.videoId }, ctx, 'long-research');
    expect(packet.excerpts).toEqual([]);
    await executeAnalyzeVideoTranscript({ assetVersion: packet.assetVersions![0]!, focus: 'Last caption' }, ctx, 'long-analysis');
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ segments: original.segments }));
  });
});

describe('metadata caption preflight', () => {
  it.each(['available', 'unknown', 'unavailable'] as const)('exposes %s and skips only confirmed absence', async status => {
    const { executeGetVideo } = await import('../src/agents/providers/youtube/tools/get-video');
    const transcriptFetch = vi.fn(async () => { throw new Error('unexpected provider call'); });
    const ctx = toolContext({ video: async () => ({ cacheStatus: 'miss', value: {
      ...video('abcdefghijk', 0), keywords: [], availability: { status: 'OK', playable: true, embeddable: true, isPrivate: false, isLive: false },
      captionAvailability: { status, languages: status === 'available' ? ['en'] : [], checkedAt: new Date().toISOString() },
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
    } }), transcript: transcriptFetch }, { mode: 'complete_transcript' });
    ctx.transcriptSelection = { allowReplacement: false, attempted: new Set(), unavailable: new Set() };
    const packet = await executeGetVideo({ videoId: 'abcdefghijk' }, ctx, 'metadata');
    expect(JSON.stringify(evidencePacketForModel(packet))).toContain(`Caption availability: ${status}`);
    expect(ctx.transcriptSelection.unavailable.has('abcdefghijk')).toBe(status === 'unavailable');
    if (status === 'unavailable') {
      const skipped = await executeGetVideoTranscript({ videoId: 'abcdefghijk' }, ctx, 'captions');
      expect(skipped.warnings[0]?.code).toBe('CAPTIONS_UNAVAILABLE');
      expect(skipped.excerpts).toEqual([]);
      expect(skipped.usage).toEqual([]);
      expect(transcriptFetch).not.toHaveBeenCalled();
    }
  });
  it('does not suppress captions based on old cached absence', async () => {
    const { executeGetVideo } = await import('../src/agents/providers/youtube/tools/get-video');
    const ctx = toolContext({ video: async () => ({ cacheStatus: 'hit', value: {
      ...video('abcdefghijk', 0), keywords: [], availability: { status: 'OK', playable: true, embeddable: true, isPrivate: false, isLive: false },
      captionAvailability: { status: 'unavailable', languages: [], checkedAt: new Date(Date.now() - 600_000).toISOString() },
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
    } }) });
    ctx.transcriptSelection = { allowReplacement: false, attempted: new Set(), unavailable: new Set() };
    await executeGetVideo({ videoId: 'abcdefghijk' }, ctx, 'metadata');
    expect(ctx.transcriptSelection.unavailable.size).toBe(0);
  });
});

test('preserves a region restriction and suppresses later transcript provider calls', async () => {
  const transcript = vi.fn(async () => { throw Object.assign(new Error('Country restriction'), { code: 'REGION_RESTRICTED' }); });
  const ctx = toolContext({ transcript }, { mode: 'complete_transcript' });
  ctx.transcriptSelection = { allowReplacement: false, attempted: new Set(), unavailable: new Set() };
  await expect(executeGetVideoTranscript({ videoId: 'abcdefghijk' }, ctx, 'first')).rejects.toMatchObject({ code: 'REGION_RESTRICTED' });
  const skipped = await executeGetVideoTranscript({ videoId: 'abcdefghijk', language: 'en' }, ctx, 'retry');
  expect(skipped.warnings[0]?.code).toBe('REGION_RESTRICTED');
  expect(skipped.usage).toEqual([]);
  expect(transcript).toHaveBeenCalledTimes(1);
  expect(ctx.transcriptSelection.unavailable.size).toBe(0);
});

test.each([0, 600_000])('only recent country-restricted metadata suppresses a transcript (%i ms old)', async age => {
  const { executeGetVideo } = await import('../src/agents/providers/youtube/tools/get-video');
  const ctx = toolContext({ video: async () => ({ cacheStatus: 'hit', value: {
    ...video('abcdefghijk', 0), keywords: [],
    availability: { status: 'UNPLAYABLE', restriction: 'region' as const, reason: 'The uploader has not made this video available in your country', playable: false, embeddable: false, isPrivate: false, isLive: false },
    meta: { source: 'allthingsyoutube', fetchedAt: new Date(Date.now() - age).toISOString(), partial: true, warnings: [] },
  } }) }, { mode: 'complete_transcript' });
  ctx.transcriptSelection = { allowReplacement: false, attempted: new Set(), unavailable: new Set() };
  await executeGetVideo({ videoId: 'abcdefghijk' }, ctx, 'metadata-region');
  expect(ctx.transcriptSelection.regionRestricted?.has('abcdefghijk') ?? false).toBe(age === 0);
  if (age === 0) {
    const skipped = await executeGetVideoTranscript({ videoId: 'abcdefghijk' }, ctx, 'skip-region');
    expect(skipped.warnings[0]?.code).toBe('REGION_RESTRICTED');
  }
});
