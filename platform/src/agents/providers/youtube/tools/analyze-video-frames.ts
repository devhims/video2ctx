import { tool } from 'ai';
import { z } from 'zod';
import { framesSchema } from '../../../../lib/youtube-frames-contract';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import { readAnalysisAssets, storedVisualInputSchema } from './stored-analysis';
import { safeIdPart, youtubeVideoUrl } from './provider-evidence';

export const analyzeVideoFramesInputSchema = storedVisualInputSchema.extend({
  assetVersions: storedVisualInputSchema.shape.assetVersions.max(6),
});
export function createAnalyzeVideoFramesTool(context: AgentToolContext) {
  return tool({
    description:
      'Analyze saved frame assetVersions with a focused visual question. Reads the original images from this session only; never extracts frames or calls YouTube. Reuse these versions for follow-up questions. Returns timestamped observations with evidence IDs. Missing or deleted assets require explicit retrieval.',
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
    toolCallId,
    toolName: 'analyze_video_frames',
    operation: 'frames',
    semanticKey: `frame-analysis:${JSON.stringify({ assetVersions: versions, focus: parsed.focus })}`,
    execute: async () => {
      if (!context.analyzeFrames) throw new Error('Frame analysis is unavailable.');
      const assets = await readAnalysisAssets(context, versions, 'frame');
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
      const analysis = await context.analyzeFrames({
        frames,
        focus: parsed.focus,
        researchQuestion: context.researchQuestion,
        signal: context.signal,
        modelCallId: `frame-analyst:${context.runId}:${toolCallId}`,
      });
      context.signal.throwIfAborted();
      // Recheck availability after inference so deletion cannot recreate derived evidence.
      await readAnalysisAssets(context, versions, 'frame');
      const sourceId = `youtube:${videoId}:frames`;
      return evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`,
        kind: 'youtube_frames',
        sources: [
          { id: sourceId, provider: 'youtube', kind: 'frames', videoId, url: youtubeVideoUrl(videoId) },
        ],
        excerpts: analysis.findings.flatMap((finding, index) =>
          [...new Set(finding.timestampsMs)].map((time) => {
            if (!frames.frames.some((frame) => frame.timestampMs === time))
              throw new Error('Analyst cited an unavailable frame.');
            return {
              id: `frames:${videoId}:${safeIdPart(toolCallId)}:${index}:${time}`,
              sourceId,
              text: `Visual observation at requested frame: ${finding.observation}`,
              startMs: time,
              endMs: time,
            };
          }),
        ),
        artifacts: [
          {
            type: 'youtube_frame_analysis',
            title: `Saved frame analysis for ${videoId}`,
            data: {
              videoId,
              focus: parsed.focus,
              sessionReused: true,
              requestedTimestampsMs: frames.frames.map((frame) => frame.timestampMs),
              frames: frames.frames.map(({ imageBase64, ...mapping }) => mapping),
              failures: [],
            },
          },
        ],
        warnings: [
          { code: 'SELECTED_FRAME_EVIDENCE', message: 'Observations cover selected still frames only.' },
          ...frames.meta.warnings.map((message) => ({ code: 'FRAME_EXTRACTION_WARNING', message })),
          ...analysis.warnings.map((message) => ({ code: 'VISUAL_ANALYSIS_WARNING', message })),
          ...assets
            .filter(({ asset }) => !asset.current)
            .map(() => ({
              code: 'SUPERSEDED_SESSION_EVIDENCE',
              message: 'Analysis uses an older stored frame version.',
            })),
        ],
        assetVersions: versions,
        usage: [],
      });
    },
  });
}
