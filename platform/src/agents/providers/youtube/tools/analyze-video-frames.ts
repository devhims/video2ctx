import { recordedFrameSelections } from '../../../runtime/frame-selection';
import { tool } from 'ai';
import { z } from 'zod';
import { framesSchema } from '../../../../lib/youtube-frames-contract';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import { readAnalysisAssets, storedVisualInputSchema } from './stored-analysis';
import { safeIdPart, youtubeVideoUrl } from './provider-evidence';
import { VISUAL_PROVENANCE_VERSION, visualAnalysisExcerpts } from '../visual-provenance';

export const analyzeVideoFramesInputSchema = storedVisualInputSchema.extend({
  assetVersions: storedVisualInputSchema.shape.assetVersions.max(6),
});
export function createAnalyzeVideoFramesTool(context: AgentToolContext) {
  return tool({
    description:
      'Analyze saved frame assetVersions with a focused visual question. Reads the original images from this session only; never extracts frames again. The runtime may load missing video metadata through get_video. Reuse these versions for follow-up questions. Returns timestamped observations with evidence IDs. Missing or deleted assets require explicit retrieval.',
    inputSchema: analyzeVideoFramesInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeAnalyzeVideoFrames(input, context, toolCallId),
  });
}
export function executeAnalyzeVideoFrames(
  input: z.infer<typeof analyzeVideoFramesInputSchema>,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = analyzeVideoFramesInputSchema.parse(input);
  const versions = [...parsed.assetVersions].sort();
  return context.executeEvidenceTool({
    input: parsed,
    toolCallId,
    toolName: 'analyze_video_frames',
    operation: 'frames',
    semanticKey: `frame-analysis:${JSON.stringify({ assetVersions: versions, focus: parsed.focus })}`,
    execute: async () => {
      if (!context.analyzeFrames) throw new Error('Frame analysis is unavailable.');
      const { assets, assertAvailable } = await readAnalysisAssets(context, versions, 'frame', toolCallId);
      const values = assets.map(({ asset, value }) => {
        const frames = framesSchema.parse(value);
        if (frames.videoId !== asset.videoId || frames.frames.length !== 1)
          throw new Error('Invalid saved frame mapping.');
        return frames;
      });
      const videoId = values[0]!.videoId;
      if (values.some((value) => value.videoId !== videoId))
        throw new Error('Select frames from one video per analysis.');
      const frames = framesSchema.parse({
        videoId,
        frames: values.flatMap((value) => value.frames).sort((a, b) => a.timestampMs - b.timestampMs),
        failures: [],
        meta: { partial: false, warnings: [...new Set(values.flatMap((value) => value.meta.warnings))] },
      });
      // Every preflight check passed: admit the saved inputs as delivered source content,
      // billed once per run per unit, immediately before inference. A later analyst
      // failure keeps the charge; a rejected selection above never reaches this line.
      context.deliverSavedAssets?.(versions);
      const packet = await analyzeFrameEvidence(frames, parsed.focus, context, toolCallId);
      assertAvailable();
      packet.assetVersions = versions;
      packet.artifacts[0]!.data.sessionReused = true;
      // Carry the recorded selections for the analyzed positions from the request that retrieved them.
      const selections = recordedFrameSelections(context.getEvidence?.() ?? [], versions, frames.frames.map(frame => frame.timestampMs));
      if (selections) packet.artifacts[0]!.data.selections = selections;
      if (assets.some(({ asset }) => !asset.current)) packet.warnings.unshift({
        code: 'SUPERSEDED_SESSION_EVIDENCE', message: 'Analysis uses an older stored frame version.',
      });
      packet.warnings = packet.warnings.slice(0, 50);
      return evidencePacketSchema.parse(packet);
    },
  });
}

/** Analyze already validated bytes. Persistence and input admission belong to the caller. */
export async function analyzeFrameEvidence(frames: z.infer<typeof framesSchema>, focus: string, context: AgentToolContext, toolCallId: string) {
  if (!context.analyzeFrames) throw new Error('Frame analysis is unavailable.');
  if (!frames.frames.length) throw new Error('No frames are available for analysis.');
  const videoId = frames.videoId;
  const analysis = await context.analyzeFrames!({
    frames,
    focus,
    researchQuestion: context.researchQuestion,
    signal: context.signal,
    modelCallId: `frame-analyst:${context.runId}:${toolCallId}`,
  });
  context.signal.throwIfAborted();
  // Recheck availability after inference so deletion cannot recreate derived evidence.
  const sourceId = `youtube:${videoId}:frames`;
  const visual = visualAnalysisExcerpts({
    kind: 'requested', idPrefix: `frames:${videoId}:${safeIdPart(toolCallId)}`, sourceId,
    findings: analysis.findings.map(finding => ({ observation: finding.observation, frames: finding.timestampsMs })),
    sharedFindings: (analysis.sharedFindings ?? []).map(finding => ({ observation: finding.observation, frames: finding.timestampsMs })),
    timeOf: time => time,
    assertAvailable: time => {
      if (!frames.frames.some((frame) => frame.timestampMs === time)) throw new Error('Analyst cited an unavailable frame.');
    },
  });
  return evidencePacketSchema.parse({
    packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`,
    kind: 'youtube_frames',
    sources: [
      { id: sourceId, provider: 'youtube', kind: 'frames', videoId, url: youtubeVideoUrl(videoId) },
    ],
    excerpts: visual.excerpts,
    artifacts: [
      {
        type: 'youtube_frame_analysis',
        title: `Frame analysis for ${videoId}`,
        data: {
          videoId,
          focus,
          sessionReused: false,
          requestedTimestampsMs: [...frames.frames.map(frame => frame.timestampMs), ...frames.failures.map(failure => failure.timestampMs)].sort((a, b) => a - b),
          frames: frames.frames.map(({ imageBase64, ...mapping }) => mapping),
          failures: frames.failures,
          provenanceVersion: VISUAL_PROVENANCE_VERSION,
          sharedObservations: visual.sharedObservations,
        },
      },
    ],
    warnings: [
      { code: 'SELECTED_FRAME_EVIDENCE', message: 'Observations cover selected still frames only.' },
      ...frames.meta.warnings.map((message) => ({ code: 'FRAME_EXTRACTION_WARNING', message })),
      ...analysis.warnings.map((message) => ({ code: 'VISUAL_ANALYSIS_WARNING', message })),
    ],
    assetVersions: [],
    usage: [],
  });
}
