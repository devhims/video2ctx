import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { EvidencePacket } from '../src/agents/contracts';
import { createCapabilityToolSet } from '../src/agents/providers/youtube/tool-library';
import { executeGetVideoTranscriptForModel } from '../src/agents/providers/youtube/tools/get-video-transcript';
import { executeGetVideoFrames } from '../src/agents/providers/youtube/tools/get-video-frames';
import { executeGetVideoStoryboard } from '../src/agents/providers/youtube/tools/get-video-storyboard';
import { executeAnalyzeVideoTranscript } from '../src/agents/providers/youtube/tools/analyze-video-transcripts';
import { executeAnalyzeVideoFrames } from '../src/agents/providers/youtube/tools/analyze-video-frames';
import { executeAnalyzeVideoStoryboard } from '../src/agents/providers/youtube/tools/analyze-video-storyboard';
import { attachTestAssetStore } from './fixtures/analysis-session';
import { evidencePacketForModel } from '../src/agents/runtime/model-evidence';

const videoId = 'abcdefghijk';
function setup() {
  const packets: EvidencePacket[] = [];
  const transcript = {
    videoId,
    track: {
      id: 'en',
      name: 'English',
      languageCode: 'en',
      kind: 'manual',
      isTranslatable: true,
      isDefault: true,
    },
    segments: [{ text: 'A blue chart.', startMs: 0, endMs: 1000, durationMs: 1000 }],
    text: 'A blue chart.',
    meta: { source: 'allthingsyoutube', partial: false, fetchedAt: '2026-09-19T00:00:00Z', warnings: [] },
  };
  const frames = {
    videoId,
    frames: [{ timestampMs: 0, width: 640, height: 360, mimeType: 'image/jpeg', imageBase64: '/9j/2Q==' }],
    failures: [],
    meta: { partial: false, warnings: [] },
  };
  const storyboard = {
    videoId,
    frameCount: 2,
    intervalMs: 1000,
    manifest: {
      totalSheets: 1,
      framesPerSheet: 2,
      tileWidth: 100,
      tileHeight: 100,
      columns: 2,
      rows: 1,
      lastSampleMs: 1000,
    },
    selection: { mode: 'indexes' },
    sheets: [
      {
        imageBase64: '/9j/2Q==',
        tileWidth: 100,
        tileHeight: 100,
        columns: 2,
        rows: 1,
        firstFrameIndex: 0,
        frameCount: 2,
        intervalMs: 1000,
      },
    ],
    meta: { partial: false, warnings: [] },
  };
  const provider = {
    transcript: vi.fn(async () => ({ value: transcript, cacheStatus: 'miss' })),
    frames: vi.fn(async () => ({ value: frames, cacheStatus: 'miss' })),
    storyboard: vi.fn(async () => ({ value: storyboard, cacheStatus: 'miss' })),
  };
  const context: AgentToolContext = {
    runId: 'test-run',
    signal: new AbortController().signal,
    provider: provider as unknown as AgentToolContext['provider'],
    transcriptPolicy: {
      mode: 'contextual_analysis',
      researchQuestion: 'Describe the chart.',
      analyze: vi.fn(async () => ({
        summary: 'A blue chart.',
        findings: [{ claim: 'The chart is blue.', excerptIds: ['caption'] }],
        excerpts: [{ id: 'caption', text: 'A blue chart.', startMs: 0, endMs: 1000 }],
        coverage: { completeTranscriptRead: true as const, segmentCount: 1, startMs: 0, endMs: 1000 },
        warnings: [],
      })),
    },
    analyzeFrames: vi.fn(async () => ({
      findings: [{ observation: 'A blue chart.', timestampsMs: [0] }],
      warnings: [],
    })),
    analyzeStoryboard: vi.fn(async () => ({
      findings: [{ observation: 'A blue chart.', frameIndexes: [0] }],
      warnings: [],
    })),
    executeEvidenceTool: async (execution) => {
      const packet = await execution.execute();
      packets.push(packet);
      return packet;
    },
    getEvidence: () => packets,
    finalize: vi.fn(),
  };
  const store = attachTestAssetStore(context);
  const versions = {
    transcript: store.put('transcript', videoId, transcript),
    frame: store.put('frame', videoId, frames),
    storyboard_sheet: store.put('storyboard_sheet', videoId, storyboard, {
      sheetIndex: 0,
      manifestVersion: 'manifest',
    }),
  };
  return { context, provider, store, versions, packets, transcript, frames, storyboard };
}
const kinds = ['transcript', 'frame', 'storyboard_sheet'] as const;
function analyze(
  kind: (typeof kinds)[number],
  version: string,
  context: AgentToolContext,
  focus = 'Describe the chart.',
) {
  return kind === 'transcript'
    ? executeAnalyzeVideoTranscript({ assetVersion: version, focus }, context, focus)
    : kind === 'frame'
      ? executeAnalyzeVideoFrames({ assetVersions: [version], focus }, context, focus)
      : executeAnalyzeVideoStoryboard({ assetVersions: [version], focus }, context, focus);
}
function analyst(context: AgentToolContext, kind: (typeof kinds)[number]) {
  if (context.transcriptPolicy.mode !== 'contextual_analysis') throw Error('Expected analyst');
  return kind === 'transcript'
    ? context.transcriptPolicy.analyze
    : kind === 'frame'
      ? context.analyzeFrames!
      : context.analyzeStoryboard!;
}
describe('retrieval and saved-asset analysis boundary', () => {
  it('retrieves all three asset types without invoking an analyst, and keeps raw research captions out of the model', async () => {
    const { context, packets, storyboard } = setup();
    packets.push({
      packetId: 'manifest',
      kind: 'youtube_storyboard',
      sources: [],
      excerpts: [],
      usage: [],
      warnings: [],
      artifacts: [
        {
          type: 'youtube_storyboard_retrieval',
          data: { videoId, manifest: storyboard.manifest, intervalMs: 1000 },
        },
      ],
    });
    const transcript = await executeGetVideoTranscriptForModel({ videoId }, context, 'transcript');
    const frames = await executeGetVideoFrames({ videoId, timestampsMs: [0] }, context, 'frames');
    const sheets = await executeGetVideoStoryboard({ videoId, sheetIndexes: [0] }, context, 'storyboard');
    for (const packet of [transcript, frames, sheets]) {
      expect(packet.excerpts).toEqual([]);
      expect(packet.assetVersions).toHaveLength(1);
    }
    for (const kind of kinds) expect(analyst(context, kind)).not.toHaveBeenCalled();
    expect(packets.find((packet) => packet.kind === 'youtube_transcript')!.excerpts[0]!.text).toBe(
      'A blue chart.',
    );
  });
  it('keeps incomplete captions readable in the current run without storing a reusable asset', async () => {
    const { context, transcript, store } = setup();
    store.saved.clear();
    transcript.meta.partial = true;
    const packet = await executeGetVideoTranscriptForModel({ videoId }, context, 'partial');
    expect(packet.assetVersions).toEqual([]);
    expect(store.saved.size).toBe(0);
    expect(evidencePacketForModel(packet).excerpts?.[0]?.text).toBe('A blue chart.');
    expect(packet.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PARTIAL_TRANSCRIPT' })]),
    );
    expect(analyst(context, 'transcript')).not.toHaveBeenCalled();
  });
  it('does not expose an analysis focus on any retrieval tool schema', () => {
    const { context } = setup();
    const tools = createCapabilityToolSet(context, [
      'get_video_transcript',
      'get_video_frames',
      'get_video_storyboard',
    ]);
    for (const tool of Object.values(tools))
      expect(z.toJSONSchema(tool.inputSchema as z.ZodType).properties).not.toHaveProperty('focus');
  });
  it.each(kinds)('analyzes %s for independent questions using only saved bytes', async (kind) => {
    const { context, provider, versions } = setup();
    const first = await analyze(kind, versions[kind], context);
    const second = await analyze(kind, versions[kind], context, 'What color is it?');
    expect(first.assetVersions).toEqual([versions[kind]]);
    expect(second.usage).toEqual([]);
    expect(analyst(context, kind)).toHaveBeenCalledTimes(2);
    for (const fetch of Object.values(provider)) expect(fetch).not.toHaveBeenCalled();
  });
  it.each(kinds)('rejects missing, wrong-kind, and out-of-scope %s assets before inference', async (kind) => {
    const { context, provider, versions } = setup();
    await expect(analyze(kind, 'f'.repeat(64), context)).rejects.toThrow('unavailable or deleted');
    const wrongKind = kind === 'frame' ? 'transcript' : 'frame';
    await expect(analyze(kind, versions[wrongKind], context)).rejects.toThrow('requires saved');
    context.pinnedVideoId = 'video000001';
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('pinned to video');
    expect(analyst(context, kind)).not.toHaveBeenCalled();
    for (const fetch of Object.values(provider)) expect(fetch).not.toHaveBeenCalled();
  });
  it.each(kinds)('does not persist %s analysis if its asset is deleted during inference', async (kind) => {
    const { context, store, versions, packets } = setup();
    const fn = vi.mocked(analyst(context, kind) as (...args: unknown[]) => Promise<unknown>);
    const implementation = fn.getMockImplementation()!;
    fn.mockImplementationOnce(async (input: unknown) => {
      store.saved.delete(versions[kind]);
      return implementation(input);
    });
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('unavailable or deleted');
    expect(packets).toEqual([]);
  });
  it.each(kinds)('requires explicit retrieval in a refresh run before analyzing %s', async (kind) => {
    const { context, versions, packets } = setup();
    context.refreshEvidence = true;
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('Fresh evidence was requested');
    expect(analyst(context, kind)).not.toHaveBeenCalled();
    const artifact =
      kind === 'transcript'
        ? 'youtube_complete_transcript'
        : kind === 'frame'
          ? 'youtube_frame_retrieval'
          : 'youtube_storyboard_retrieval';
    packets.push({
      packetId: `packet:${context.runId}:refresh`,
      kind: 'youtube_transcript',
      assetVersions: [versions[kind]],
      sources: [],
      excerpts: [],
      artifacts: [{ type: artifact, data: {} }],
      warnings: [],
      usage: [],
    });
    await analyze(kind, versions[kind], context);
    expect(analyst(context, kind)).toHaveBeenCalledOnce();
  });
  it('rejects mixed videos and duplicate timestamps before frame analysis', async () => {
    const { context, store, versions, frames } = setup();
    const other = store.put('frame', 'video000001', { ...frames, videoId: 'video000001' });
    await expect(
      executeAnalyzeVideoFrames(
        { assetVersions: [versions.frame, other], focus: 'Compare' },
        context,
        'mixed',
      ),
    ).rejects.toThrow('one video');
    const duplicate = store.put('frame', videoId, frames);
    await expect(
      executeAnalyzeVideoFrames(
        { assetVersions: [versions.frame, duplicate], focus: 'Compare' },
        context,
        'duplicate',
      ),
    ).rejects.toThrow();
    expect(context.analyzeFrames).not.toHaveBeenCalled();
  });
});
