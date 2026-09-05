import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import { storyboardSchema } from '../storyboard';
import { safeIdPart, videoIdSchema, youtubeVideoUrl, meteredCredits } from './provider-evidence';

export const getVideoStoryboardInputSchema = z.object({
  videoId: videoIdSchema,
  focus: z.string().trim().min(1).max(1_000),
});
export function createGetVideoStoryboardTool(context: AgentToolContext) {
  return tool({
    description: 'Analyze sampled storyboard images for one video using an isolated visual analyst. Supply a focused question about visible slides, interfaces, charts or demonstrations. Returns timestamped visual observations, not speech or complete video coverage.',
    inputSchema: getVideoStoryboardInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoStoryboard(input, context, toolCallId),
  });
}
export function executeGetVideoStoryboard(input: z.infer<typeof getVideoStoryboardInputSchema>, context: AgentToolContext, toolCallId: string) {
  const parsed = getVideoStoryboardInputSchema.parse(input);
  return context.executeEvidenceTool({
    toolCallId, toolName: 'get_video_storyboard', operation: 'storyboard',
    semanticKey: `storyboard:${JSON.stringify(parsed)}`,
    execute: async () => {
      context.signal.throwIfAborted();
      if (!context.analyzeStoryboard || !context.provider.storyboard) throw new Error('Storyboard analysis is unavailable.');
      const response = await context.provider.storyboard(parsed.videoId);
      context.signal.throwIfAborted();
      const storyboard = storyboardSchema.parse(response.value);
      if (storyboard.videoId !== parsed.videoId) throw new Error('Storyboard video ID mismatch.');
      const analysis = await context.analyzeStoryboard({ storyboard, focus: parsed.focus, signal: context.signal,
        modelCallId: `visual-analyst:${context.runId}:${toolCallId}` });
      context.signal.throwIfAborted();
      const sourceId = `youtube:${parsed.videoId}:storyboard`;
      return evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`, kind: 'youtube_storyboard',
        sources: [{ id: sourceId, provider: 'youtube', kind: 'storyboard', videoId: parsed.videoId, url: youtubeVideoUrl(parsed.videoId) }],
        excerpts: analysis.findings.flatMap((finding, findingIndex) => [...new Set(finding.frameIndexes)].map(frame => {
          if (!storyboard.sheets.some(sheet => frame >= sheet.firstFrameIndex && frame < sheet.firstFrameIndex + sheet.frameCount)) {
            throw new Error(`Visual analyst referenced unavailable frame ${frame}.`);
          }
          const time = frame * storyboard.intervalMs;
          return { id: `storyboard:${parsed.videoId}:${safeIdPart(toolCallId)}:${findingIndex}:${frame}`, sourceId,
            text: `Visual observation from sampled frame: ${finding.observation}`, startMs: time, endMs: time };
        })),
        artifacts: [{ type: 'youtube_storyboard_analysis', title: `Sampled visual evidence for ${parsed.videoId}`,
          data: { videoId: parsed.videoId, focus: parsed.focus, totalFrames: storyboard.frameCount,
            sampledFrames: storyboard.sheets.reduce((sum, sheet) => sum + sheet.frameCount, 0), intervalMs: storyboard.intervalMs } }],
        warnings: [
          { code: 'SAMPLED_VISUAL_EVIDENCE', message: 'Observations cover sampled storyboard frames only. Brief events and small text may be missed.' },
          ...storyboard.meta.warnings.map(message => ({ code: 'PARTIAL_STORYBOARD', message })),
          ...analysis.warnings.map(message => ({ code: 'VISUAL_ANALYSIS_WARNING', message })),
        ],
        usage: [{ operation: 'storyboard', credits: meteredCredits('storyboard')(response.cacheStatus), cacheStatus: response.cacheStatus }],
      });
    },
  });
}
