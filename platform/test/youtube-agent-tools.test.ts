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

describe('YouTube agent evidence tools', () => {
  it('maps one search tool call to one provider request and bounds candidates', async () => {
    const videos = Array.from({ length: 15 }, (_, index) => video(`video0000${String(index).padStart(2, '0')}`.slice(-11), index));
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
      warnings: [],
      coverage: {
        completeTranscriptRead: true as const,
        segmentCount: 3,
        startMs: 0,
        endMs: 50_000,
      },
    }));
    const context = toolContext({ transcript, analyzeTranscript });

    const packet = await executeGetVideoTranscript({
      videoId: 'abcdefghijk',
      focus: 'visual hierarchy interaction agents',
    }, context, 'call-transcript-1');

    expect(transcript).toHaveBeenCalledTimes(1);
    expect(transcript).toHaveBeenCalledWith('abcdefghijk', undefined);
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
    expect(packet.usage).toEqual([{ operation: 'transcript', credits: 1, cacheStatus: 'hit' }]);
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

    const modelResult = await executeGetVideoTranscriptForModel({
      videoId: 'abcdefghijk',
      focus: 'frontend skills',
    }, context, 'call-transcript-model-result');

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
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(4_000);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('at most 20 distinct findings');
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

  it('retains ten supported findings for a larger inspect request', async () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({ claim: `Finding ${i + 1}`, windowIndexes: [i] }));
    const result = await analyzeTranscriptWithModel({
      model: transcriptAnalysisModel({ summary: 'Ten relevant points.', findings, warnings: [] }),
      videoId: 'abcdefghijk', researchQuestion: 'List ten lessons from this video', focus: 'Ten distinct lessons',
      segments: findings.map((_, i) => ({ startMs: i * 65_000, durationMs: 1000, endMs: i * 65_000 + 1000, text: `Evidence ${i + 1}` })),
      signal: new AbortController().signal,
    });
    expect(result.findings).toHaveLength(10);
    expect(result.excerpts).toHaveLength(10);
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

    await expect(executeGetVideoTranscript({
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
    }, [packet, conflicting], 1)).toThrow(/unambiguously/);
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
    }, [packet], 1)).toThrow(/does not reference persisted evidence/);
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
  summary: string;
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
    assistantMessageId: crypto.randomUUID(),
  };
}

function admission() {
  return {
    userId: 'user-1',
    idempotencyKey: 'idempotency-key-1',
    creditsRemaining: 100,
  };
}
