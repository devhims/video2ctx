import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import { storyboardManifestSchema, storyboardSchema } from '../storyboard';
import { storyboardPreviewsSchema } from '../../../runtime/storyboard-previews';
import { safeIdPart, videoIdSchema, youtubeVideoUrl, meteredCredits } from './provider-evidence';

const retrievalInput = z.object({
  videoId: videoIdSchema,
  focus: z.string().trim().min(1).max(1_000).optional(),
  maxSheets: z.number().int().min(1).max(20).optional()
    .describe('Choose the number of sheets for a spread overview, up to 20 per call. Image payload limit is 8 MiB. Larger selections take more processing time.'),
  sheetIndexes: z.array(z.number().int().nonnegative()).min(1).max(20).refine(indexes => new Set(indexes).size === indexes.length, 'Select distinct sheet indexes.').optional()
    .describe('Select zero-based source sheet indexes using the manifest. Choose these or timestampsMs, not both.'),
  timestampsMs: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(20).optional()
    .describe('Select sheets containing these sampled timestamps in milliseconds. Nearby targets share one sheet. These are not exact video frames.'),
});
function validateInput(input: z.infer<typeof retrievalInput>, ctx: z.RefinementCtx) {
  if (input.sheetIndexes && input.sheetIndexes.length > (input.maxSheets ?? 20)) ctx.addIssue({ code: 'custom', message: 'Selected sheet indexes exceed maxSheets.' });
  if (input.sheetIndexes && input.timestampsMs) ctx.addIssue({ code: 'custom', message: 'Choose sheetIndexes or timestampsMs, not both.' });
}
export const getVideoStoryboardInputSchema = retrievalInput.superRefine(validateInput);
export function createGetVideoStoryboardTool(context: AgentToolContext) {
  return tool({
    description: 'Retrieve storyboard assets without analysis. Call with videoId only for metadata, then select maxSheets, sheetIndexes or timestampsMs using that manifest. Returns saved assetVersions and sampled coverage, without image bytes. Pass storyboard_sheet versions to analyze_video_storyboard with a question, or analyze versions already in session inventory. Up to 20 sheets and 8 MiB per selection. Metadata alone is not visual evidence.',
    inputSchema: retrievalInput.omit({focus:true}).superRefine(validateInput),
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoStoryboard(input, context, toolCallId),
  });
}
export function executeGetVideoStoryboard(input: z.infer<typeof getVideoStoryboardInputSchema>, context: AgentToolContext, toolCallId: string) {
  const parsed = getVideoStoryboardInputSchema.parse(input);
  const metadataOnly = parsed.maxSheets === undefined && parsed.sheetIndexes === undefined && parsed.timestampsMs === undefined;
  return context.executeEvidenceTool({
    toolCallId, toolName: 'get_video_storyboard', operation: 'storyboard',
    semanticKey: `storyboard:${JSON.stringify({ ...parsed, focus: undefined })}`,
    execute: async () => {
      context.signal.throwIfAborted();
      if (!context.provider.storyboard) throw new Error('Storyboard retrieval is unavailable.');
      if (!metadataOnly) validateStoryboardSelection(parsed, context);
      const response = await context.provider.storyboard(parsed.videoId, parsed.timestampsMs, {
        maxSheets: parsed.maxSheets ?? 20, sheetIndexes: parsed.sheetIndexes, metadataOnly,
      }, event => context.onExtractionDiagnostic?.({ ...event, toolCallId }));
      context.signal.throwIfAborted();
      const storyboard = storyboardSchema.parse(response.value);
      if (storyboard.videoId !== parsed.videoId) throw new Error('Storyboard video ID mismatch.');
      if (metadataOnly !== (storyboard.selection?.mode === 'metadata')) throw new Error('Storyboard response does not match the requested operation.');
      const sourceId = `youtube:${parsed.videoId}:storyboard`;
      const packet = evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`, kind: 'youtube_storyboard',
        sources: [{ id: sourceId, provider: 'youtube', kind: 'storyboard', videoId: parsed.videoId, url: youtubeVideoUrl(parsed.videoId) }],
        excerpts: [],
        artifacts: [{ type: 'youtube_storyboard_retrieval', title: `${metadataOnly ? 'Storyboard metadata' : 'Sampled visual evidence'} for ${parsed.videoId}`,
          data: { analysisAssetVersions: response.assetVersions?.filter(version => context.session?.brief().assets.some(asset => asset.version === version && asset.kind === 'storyboard_sheet')),
            videoId: parsed.videoId, sessionReused: response.sessionReused === true, selection: storyboard.selection, manifest: storyboard.manifest,
            sampledRanges: storyboard.sheets.map(sheet => ({ startMs: sheet.firstFrameIndex * sheet.intervalMs,
              endMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs })), totalFrames: storyboard.frameCount,
            sampledFrames: storyboard.sheets.reduce((sum, sheet) => sum + sheet.frameCount, 0), intervalMs: storyboard.intervalMs } }],
        warnings: [
          ...(metadataOnly
            ? []
            : [{ code: 'SAMPLED_VISUAL_EVIDENCE', message: 'Observations cover sampled storyboard frames only. Brief events and small text may be missed.' }]),
          ...storyboard.meta.warnings.map(message => ({ code: 'PARTIAL_STORYBOARD', message })),
        ],
        assetVersions: response.assetVersions,
        usage: [{ operation: 'storyboard', credits: response.sessionReused ? 0 : meteredCredits('storyboard')(response.cacheStatus), cacheStatus: response.cacheStatus }],
      });
      if (!metadataOnly && context.saveStoryboardPreviews) {
        try {
          packet.artifacts[0]!.data.previews = storyboardPreviewsSchema.parse(
            await context.saveStoryboardPreviews(storyboard, context.signal),
          );
        } catch {
          context.signal.throwIfAborted();
          packet.warnings.push({ code: 'STORYBOARD_PREVIEW_UNAVAILABLE',
            message: 'The storyboard was retrieved, but its image previews could not be saved.' });
        }
      }
      context.signal.throwIfAborted();
      return packet;
    },
  });
}

/** Validate against persisted metadata before waking the image provider or vision model. */
function validateStoryboardSelection(input: z.infer<typeof getVideoStoryboardInputSchema>, context: AgentToolContext) {
  const artifacts = (context.getEvidence?.() ?? []).flatMap(packet => packet.artifacts);
  const artifact = artifacts.reverse().find(artifact => ['youtube_storyboard_analysis', 'youtube_storyboard_retrieval'].includes(artifact.type) && artifact.data.videoId === input.videoId && artifact.data.manifest);
  const result = storyboardManifestSchema.safeParse(artifact?.data.manifest);
  if (!result.success) throw new Error('Retrieve storyboard metadata first: call get_video_storyboard with videoId only, then select from its available sheets.');
  const manifest = result.data;
  const intervalMs = artifact!.data.intervalMs;
  if (typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('Retrieve storyboard metadata again: sampling interval is unavailable.');
  const endMs = manifest.lastSampleMs + intervalMs;
  const guidance = `Available sheet indexes are 0 through ${manifest.totalSheets - 1}; timestamps must be below ${endMs} ms. Choose only available sheets or timestamps.`;
  if (input.sheetIndexes?.some(index => index >= manifest.totalSheets)) throw new Error(`Invalid storyboard selection. ${guidance}`);
  if (input.timestampsMs?.some(timestamp => timestamp >= endMs)) throw new Error(`Invalid storyboard timestamp. ${guidance}`);
  if (input.timestampsMs) {
    const selected = new Set(input.timestampsMs.map(timestamp => Math.floor(timestamp / (manifest.framesPerSheet * intervalMs))));
    if (selected.size > (input.maxSheets ?? 20)) throw new Error(`Selected timestamps require ${selected.size} sheets, exceeding maxSheets=${input.maxSheets}. ${guidance}`);
  }
}
