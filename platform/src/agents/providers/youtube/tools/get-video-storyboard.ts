import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import { storyboardSchema } from '../storyboard';
import { safeIdPart, videoIdSchema, youtubeVideoUrl, meteredCredits } from './provider-evidence';

export const getVideoStoryboardInputSchema = z.object({
  videoId: videoIdSchema,
  focus: z.string().trim().min(1).max(1_000).optional(),
  maxSheets: z.number().int().min(1).max(20).optional()
    .describe('Choose the number of sheets for a spread overview, up to 20 per call. Image payload limit is 8 MiB. Larger selections take more processing time.'),
  sheetIndexes: z.array(z.number().int().nonnegative()).min(1).max(20).optional()
    .describe('Select zero-based source sheet indexes using the manifest. Choose these or timestampsMs, not both.'),
  timestampsMs: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(20).optional()
    .describe('Select sheets containing these sampled timestamps in milliseconds. Nearby targets share one sheet. These are not exact video frames.'),
}).superRefine((input, ctx) => {
  const inspect = input.maxSheets !== undefined || input.sheetIndexes !== undefined || input.timestampsMs !== undefined;
  if (inspect && !input.focus) ctx.addIssue({ code: 'custom', message: 'Supply a focused visual question for image inspection.' });
  if (input.sheetIndexes && input.timestampsMs) ctx.addIssue({ code: 'custom', message: 'Choose sheetIndexes or timestampsMs, not both.' });
});
export function createGetVideoStoryboardTool(context: AgentToolContext) {
  return tool({
    description: 'First call with videoId only to get storyboard metadata without downloading images or running vision. Use totalSheets, framesPerSheet, intervalMs, lastSampleMs, and tile dimensions to choose coverage. Then inspect with focus plus maxSheets for a spread overview, sheetIndexes for exact sheets, or timestampsMs for sampled moments. Sheet i starts at i * framesPerSheet * intervalMs; its last sample is min((i + 1) * framesPerSheet - 1, totalFrames - 1) * intervalMs. Choose the number needed for the task within the research time and cost budgets. Up to 20 sheets and 8 MiB per call; follow up on other sheets as needed. Metadata is not visual evidence. Images are sampled previews and may not resolve small text.',
    inputSchema: getVideoStoryboardInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoStoryboard(input, context, toolCallId),
  });
}
export function executeGetVideoStoryboard(input: z.infer<typeof getVideoStoryboardInputSchema>, context: AgentToolContext, toolCallId: string) {
  const parsed = getVideoStoryboardInputSchema.parse(input);
  const metadataOnly = parsed.maxSheets === undefined && parsed.sheetIndexes === undefined && parsed.timestampsMs === undefined;
  return context.executeEvidenceTool({
    toolCallId, toolName: 'get_video_storyboard', operation: 'storyboard',
    semanticKey: `storyboard:${JSON.stringify(parsed)}`,
    execute: async () => {
      context.signal.throwIfAborted();
      if ((!metadataOnly && !context.analyzeStoryboard) || !context.provider.storyboard) throw new Error('Storyboard analysis is unavailable.');
      const response = await context.provider.storyboard(parsed.videoId, parsed.timestampsMs, {
        maxSheets: parsed.maxSheets ?? 20, sheetIndexes: parsed.sheetIndexes, metadataOnly,
      });
      context.signal.throwIfAborted();
      const storyboard = storyboardSchema.parse(response.value);
      if (storyboard.videoId !== parsed.videoId) throw new Error('Storyboard video ID mismatch.');
      if (metadataOnly !== (storyboard.selection?.mode === 'metadata')) throw new Error('Storyboard response does not match the requested operation.');
      const analysis = metadataOnly ? { findings: [], warnings: [] } : await context.analyzeStoryboard!({ storyboard, focus: parsed.focus!, signal: context.signal,
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
        artifacts: [{ type: 'youtube_storyboard_analysis', title: `${metadataOnly ? 'Storyboard metadata' : 'Sampled visual evidence'} for ${parsed.videoId}`,
          data: { videoId: parsed.videoId, focus: parsed.focus, selection: storyboard.selection, manifest: storyboard.manifest,
            sampledRanges: storyboard.sheets.map(sheet => ({ startMs: sheet.firstFrameIndex * sheet.intervalMs,
              endMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs })), totalFrames: storyboard.frameCount,
            sampledFrames: storyboard.sheets.reduce((sum, sheet) => sum + sheet.frameCount, 0), intervalMs: storyboard.intervalMs } }],
        warnings: [
          ...(metadataOnly
            ? []
            : [{ code: 'SAMPLED_VISUAL_EVIDENCE', message: 'Observations cover sampled storyboard frames only. Brief events and small text may be missed.' }]),
          ...storyboard.meta.warnings.map(message => ({ code: 'PARTIAL_STORYBOARD', message })),
          ...analysis.warnings.map(message => ({ code: 'VISUAL_ANALYSIS_WARNING', message })),
        ],
        usage: [{ operation: 'storyboard', credits: meteredCredits('storyboard')(response.cacheStatus), cacheStatus: response.cacheStatus }],
      });
    },
  });
}
