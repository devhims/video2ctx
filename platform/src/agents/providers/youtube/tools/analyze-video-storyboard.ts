import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import { storyboardSchema } from '../storyboard';
import type { AgentToolContext } from '../tool-context';
import { readAnalysisAssets, storedVisualInputSchema } from './stored-analysis';
import { safeIdPart, youtubeVideoUrl } from './provider-evidence';

export function createAnalyzeVideoStoryboardTool(context: AgentToolContext) {
  return tool({
    description:
      'Analyze saved storyboard_sheet assetVersions for a visual question. Use analysisAssetVersions from retrieval or sheet versions from session inventory, not the manifest version. Reads saved images only, with no YouTube call. Observations cover sampled previews, not the complete video.',
    inputSchema: storedVisualInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeAnalyzeVideoStoryboard(input, context, toolCallId),
  });
}
export function executeAnalyzeVideoStoryboard(
  input: z.infer<typeof storedVisualInputSchema>,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = storedVisualInputSchema.parse(input);
  const versions = [...parsed.assetVersions].sort();
  return context.executeEvidenceTool({
    toolCallId,
    toolName: 'analyze_video_storyboard',
    operation: 'storyboard',
    semanticKey: `storyboard-analysis:${JSON.stringify({ assetVersions: versions, focus: parsed.focus })}`,
    execute: async () => {
      if (!context.analyzeStoryboard) throw new Error('Storyboard analysis is unavailable.');
      const assets = await readAnalysisAssets(context, versions, 'storyboard_sheet');
      const values = assets.map(({ asset, value }) => {
        const parsed = storyboardSchema.parse(value);
        if (parsed.videoId !== asset.videoId || parsed.sheets.length !== 1)
          throw new Error('Invalid saved storyboard mapping.');
        return parsed;
      });
      const first = values[0]!;
      if (
        values.some(
          (value) =>
            value.videoId !== first.videoId ||
            value.intervalMs !== first.intervalMs ||
            value.frameCount !== first.frameCount,
        ) ||
        new Set(assets.map(({ asset }) => asset.details.manifestVersion)).size !== 1
      )
        throw new Error('Select sheets from one video and manifest version per analysis.');
      const storyboard = storyboardSchema.parse({
        ...first,
        sheets: values.flatMap((value) => value.sheets).sort((a, b) => a.firstFrameIndex - b.firstFrameIndex),
        selection: {
          mode: 'indexes',
          requestedSheetIndexes: assets.map(({ asset }) => asset.details.sheetIndex),
        },
      });
      if (storyboard.sheets.reduce((sum, sheet) => sum + sheet.imageBase64.length, 0) > 11_184_816)
        throw new Error('Saved storyboard selection exceeds the image budget.');
      const analysis = await context.analyzeStoryboard({
        storyboard,
        focus: parsed.focus,
        signal: context.signal,
        modelCallId: `visual-analyst:${context.runId}:${toolCallId}`,
      });
      context.signal.throwIfAborted();
      await readAnalysisAssets(context, versions, 'storyboard_sheet');
      const videoId = storyboard.videoId;
      const sourceId = `youtube:${videoId}:storyboard`;
      return evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`,
        kind: 'youtube_storyboard',
        sources: [
          { id: sourceId, provider: 'youtube', kind: 'storyboard', videoId, url: youtubeVideoUrl(videoId) },
        ],
        excerpts: analysis.findings.flatMap((finding, index) =>
          [...new Set(finding.frameIndexes)].map((frame) => {
            if (
              !storyboard.sheets.some(
                (sheet) => frame >= sheet.firstFrameIndex && frame < sheet.firstFrameIndex + sheet.frameCount,
              )
            )
              throw new Error(`Visual analyst referenced unavailable frame ${frame}.`);
            const time = frame * storyboard.intervalMs;
            return {
              id: `storyboard:${videoId}:${safeIdPart(toolCallId)}:${index}:${frame}`,
              sourceId,
              text: `Visual observation from sampled frame: ${finding.observation}`,
              startMs: time,
              endMs: time,
            };
          }),
        ),
        artifacts: [
          {
            type: 'youtube_storyboard_analysis',
            title: `Saved storyboard analysis for ${videoId}`,
            data: {
              videoId,
              focus: parsed.focus,
              sessionReused: true,
              selection: storyboard.selection,
              manifest: storyboard.manifest,
              sampledRanges: storyboard.sheets.map((sheet) => ({
                startMs: sheet.firstFrameIndex * sheet.intervalMs,
                endMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs,
              })),
              totalFrames: storyboard.frameCount,
              sampledFrames: storyboard.sheets.reduce((sum, sheet) => sum + sheet.frameCount, 0),
              intervalMs: storyboard.intervalMs,
            },
          },
        ],
        warnings: [
          {
            code: 'SAMPLED_VISUAL_EVIDENCE',
            message:
              'Observations cover sampled storyboard frames only. Brief events and small text may be missed.',
          },
          ...values
            .flatMap((value) => value.meta.warnings)
            .map((message) => ({ code: 'PARTIAL_STORYBOARD', message })),
          ...analysis.warnings.map((message) => ({ code: 'VISUAL_ANALYSIS_WARNING', message })),
          ...assets
            .filter(({ asset }) => !asset.current)
            .map(() => ({
              code: 'SUPERSEDED_SESSION_EVIDENCE',
              message: 'Analysis uses an older stored storyboard version.',
            })),
        ],
        assetVersions: versions,
        usage: [],
      });
    },
  });
}
