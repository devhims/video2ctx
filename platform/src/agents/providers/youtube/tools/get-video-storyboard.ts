import { diagnoseVisualTool, countVisualWork } from '../../../../lib/visual-diagnostics';
import { withRunDeadline } from '../../../runtime/deadline';
import { storyboardRetrievalBudget, STORYBOARD_RETRIEVAL_MIN_MS } from '../../../runtime/storyboard-budget';
import { timeStoryboardStage } from '../../../../lib/storyboard-timing';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import { storyboardManifestSchema, storyboardSchema, storyboardSheetIndexes, MAX_STORYBOARD_SHEETS } from '../storyboard';
import { storyboardPreviewsSchema } from '../../../runtime/storyboard-previews';
import { safeIdPart, videoIdSchema, youtubeVideoUrl, meteredCredits } from './provider-evidence';

const DEFAULT_STORYBOARD_SHEETS = 3;

const retrievalInput = z.object({
  videoId: videoIdSchema,
  focus: z.string().trim().min(1).max(1_000).optional(),
  maxSheets: z.number().int().min(1).max(MAX_STORYBOARD_SHEETS).optional()
    .describe('Choose the number of sheets for a spread overview, up to 20 per call. Defaults to 3 sheets when no selection is supplied. Image payload limit is 8 MiB. Larger selections take more processing time.'),
  sheetIndexes: z.array(z.number().int().nonnegative()).min(1).max(MAX_STORYBOARD_SHEETS).refine(indexes => new Set(indexes).size === indexes.length, 'Select distinct sheet indexes.').optional()
    .describe('Select zero-based source sheet indexes using the manifest. Choose these or timestampsMs, not both.'),
  timestampsMs: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(MAX_STORYBOARD_SHEETS).optional()
    .describe('Select sheets containing these sampled timestamps in milliseconds. Nearby targets share one sheet. These are not exact video frames.'),
});
function validateInput(input: z.infer<typeof retrievalInput>, ctx: z.RefinementCtx) {
  if (input.sheetIndexes && input.sheetIndexes.length > (input.maxSheets ?? MAX_STORYBOARD_SHEETS)) ctx.addIssue({ code: 'custom', message: 'Selected sheet indexes exceed maxSheets.' });
  if (input.sheetIndexes && input.timestampsMs) ctx.addIssue({ code: 'custom', message: 'Choose sheetIndexes or timestampsMs, not both.' });
}
export const getVideoStoryboardInputSchema = retrievalInput.superRefine(validateInput);
export function createGetVideoStoryboardTool(context: AgentToolContext) {
  return tool({
    description: 'Retrieve storyboard images and their metadata together, without analysis. With videoId alone, retrieve up to 3 sheets spread across the video. Use maxSheets, sheetIndexes or timestampsMs to select other coverage. No preliminary metadata call is needed. maxSheets gives a spread overview; use transcript findings to choose timestamps for targeted inspection. Returns saved assetVersions and sampled coverage, without image bytes. Pass storyboard_sheet versions to analyze_video_storyboard with a question, or analyze versions already in session inventory. Up to 20 sheets and 8 MiB per selection. Metadata alone is not visual evidence.',
    inputSchema: retrievalInput.omit({focus:true}).superRefine(validateInput),
    outputSchema: evidencePacketSchema,
    toModelOutput: ({ output }) => ({ type: 'text', value: JSON.stringify({
      ...output, artifacts: output.artifacts.map(artifact => {
        const { visualDiagnostics: _visualDiagnostics, timingsMs: _timings, ...data } = artifact.data;
        return { ...artifact, data };
      }),
    }) }),
    execute: (input, { toolCallId }) => executeGetVideoStoryboard(input, context, toolCallId),
  });
}
export function executeGetVideoStoryboard(input: z.infer<typeof getVideoStoryboardInputSchema>, context: AgentToolContext, toolCallId: string) {
  const requested = getVideoStoryboardInputSchema.parse(input);
  // Only the old metadata-only shape needs a new key. Preserve existing keys
  // for explicit selections, and use schema order for the default overview.
  const parsed = requested.maxSheets === undefined && !requested.sheetIndexes && !requested.timestampsMs
    ? getVideoStoryboardInputSchema.parse({ ...requested, maxSheets: DEFAULT_STORYBOARD_SHEETS })
    : requested;
  return context.executeEvidenceTool({
    input: parsed,
    toolCallId, toolName: 'get_video_storyboard', operation: 'storyboard',
    semanticKey: `storyboard:${JSON.stringify({ ...parsed, focus: undefined })}`,
    execute: () => diagnoseVisualTool('storyboard', async () => {
      context.signal.throwIfAborted();
      const budget = storyboardRetrievalBudget(context.researchDeadlineAt);
      if (budget < STORYBOARD_RETRIEVAL_MIN_MS)
        throw new Error('Not enough research time to retrieve storyboards and leave time for analysis. Analyze saved images or finish with the evidence available.');
      const deadlineAt = Date.now() + budget;
      return withRunDeadline(deadlineAt, context.signal,
        signal => retrieveVideoStoryboard(parsed, { ...context, signal }, toolCallId, deadlineAt),
        'Storyboard retrieval exceeded its budget. Time remains reserved for visual analysis or finalization.');
    }, { runId: context.runId, toolCallId }),
  });
}

/** A selection retrieves its manifest and images in a single provider request. */
async function retrieveVideoStoryboard(parsed: z.infer<typeof getVideoStoryboardInputSchema>, context: AgentToolContext, toolCallId: string, deadlineAt: number): Promise<EvidencePacket> {
  const startedAt = Date.now();
  context.signal.throwIfAborted();
  if (!context.provider.storyboard) throw new Error('Storyboard retrieval is unavailable.');
  const evidence = context.getEvidence?.() ?? [];
  if (findStoryboardMetadata(parsed.videoId, evidence)) validateStoryboardSelection(parsed, evidence);
  const response = await timeStoryboardStage(parsed.videoId, 'retrieval', () => context.provider.storyboard!(parsed.videoId, parsed.timestampsMs, {
    maxSheets: parsed.maxSheets ?? MAX_STORYBOARD_SHEETS, sheetIndexes: parsed.sheetIndexes, metadataOnly: false, signal: context.signal, deadlineAt,
  }, event => context.onExtractionDiagnostic?.({ ...event, toolCallId })), { runId: context.runId, toolCallId });
  context.signal.throwIfAborted();
  const storyboard = storyboardSchema.parse(response.value);
  if (storyboard.manifest) countVisualWork('requestedImages', storyboardSheetIndexes(storyboard, parsed).length);
  countVisualWork('returnedImages', storyboard.sheets.length);
  if (storyboard.videoId !== parsed.videoId) throw new Error('Storyboard video ID mismatch.');
  if (storyboard.selection?.mode === 'metadata') throw new Error('Storyboard response does not match the requested operation.');
  const timingsMs = { retrieval: Date.now() - startedAt, previews: 0, total: 0 };
  const sourceId = `youtube:${parsed.videoId}:storyboard`;
  const packet = evidencePacketSchema.parse({
    packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`, kind: 'youtube_storyboard',
    sources: [{ id: sourceId, provider: 'youtube', kind: 'storyboard', videoId: parsed.videoId, url: youtubeVideoUrl(parsed.videoId) }],
    excerpts: [],
    artifacts: [{ type: 'youtube_storyboard_retrieval', title: `Sampled visual evidence for ${parsed.videoId}`,
      data: { timingsMs, analysisAssetVersions: response.assetVersions?.filter(version => context.session?.brief().assets.some(asset => asset.version === version && asset.kind === 'storyboard_sheet')),
        videoId: parsed.videoId, sessionReused: response.sessionReused === true, selection: storyboard.selection, manifest: storyboard.manifest,
        sampledRanges: storyboard.sheets.map(sheet => ({ startMs: sheet.firstFrameIndex * sheet.intervalMs,
          endMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs })), totalFrames: storyboard.frameCount,
        sampledFrames: storyboard.sheets.reduce((sum, sheet) => sum + sheet.frameCount, 0), intervalMs: storyboard.intervalMs } }],
    warnings: [
      { code: 'SAMPLED_VISUAL_EVIDENCE', message: 'Observations cover sampled storyboard frames only. Brief events and small text may be missed.' },
      ...storyboard.meta.warnings.map(message => ({ code: 'PARTIAL_STORYBOARD', message })),
    ],
    assetVersions: [...new Set(response.assetVersions ?? [])],
    usage: [{ operation: 'storyboard', credits: response.sessionReused ? 0 : meteredCredits('storyboard')(response.cacheStatus), cacheStatus: response.cacheStatus }],
  });
  if (context.saveStoryboardPreviews) {
    const previewStartedAt = Date.now();
    try {
      packet.artifacts[0]!.data.previews = storyboardPreviewsSchema.parse(
        await timeStoryboardStage(parsed.videoId, 'previews', () => context.saveStoryboardPreviews!(storyboard, context.signal, response.verifiedImages), { runId: context.runId, toolCallId }),
      );
    } catch {
      context.signal.throwIfAborted();
      packet.warnings.push({ code: 'STORYBOARD_PREVIEW_UNAVAILABLE',
        message: 'The storyboard was retrieved, but its image previews could not be saved.' });
    } finally {
      timingsMs.previews = Date.now() - previewStartedAt;
    }
  }
  context.signal.throwIfAborted();
  timingsMs.total = Date.now() - startedAt;
  packet.artifacts[0]!.data.timingsMs = timingsMs;
  return packet;
}

/** Validate against persisted metadata before waking the image provider or vision model. */
function findStoryboardMetadata(videoId: string, evidence: readonly EvidencePacket[]) {
  const artifacts = evidence.flatMap(packet => packet.artifacts);
  const artifact = artifacts.reverse().find(artifact => ['youtube_storyboard_analysis', 'youtube_storyboard_retrieval'].includes(artifact.type) && artifact.data.videoId === videoId && artifact.data.manifest);
  const result = storyboardManifestSchema.safeParse(artifact?.data.manifest);
  const intervalMs = artifact?.data.intervalMs;
  if (!result.success || typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) return;
  return { manifest: result.data, intervalMs };
}

function validateStoryboardSelection(input: z.infer<typeof getVideoStoryboardInputSchema>, evidence: readonly EvidencePacket[]) {
  const metadata = findStoryboardMetadata(input.videoId, evidence);
  if (!metadata) throw new Error('Storyboard metadata is unavailable.');
  storyboardSheetIndexes(metadata, input);
}
