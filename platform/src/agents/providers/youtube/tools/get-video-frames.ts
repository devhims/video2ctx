import { withPreviewCleanup } from '../../../runtime/preview-lifecycle';
import { retrieveWithAnalysis, retrievalAnalysisSchema, retrySavedAnalysis } from './retrieval-analysis';
import { analyzeFrameEvidence, executeAnalyzeVideoFrames } from './analyze-video-frames';
import { retrievalUsage } from '../../../runtime/evidence-billing';
import { diagnoseVisualTool, visualSpan, countVisualWork } from '../../../../lib/visual-diagnostics';
import { tool } from 'ai';
import { z } from 'zod';
import type { ExtractionAttempt } from '../../../../lib/extraction-diagnostics';
import { frameRequestSchema, validateFrameResponse } from '../../../../lib/youtube-frames';
import { evidencePacketSchema } from '../../../contracts';
import { framePreviewSchema } from '../../../runtime/frame-previews';
import { frameExtractionBudget, FRAME_EXTRACTION_MIN_MS } from '../../../runtime/frame-budget';
import type { AgentToolContext } from '../tool-context';
import { meteredCredits, safeIdPart, youtubeVideoUrl } from './provider-evidence';

export const getVideoFramesInputSchema = frameRequestSchema.extend({
  analysis: retrievalAnalysisSchema,
  focus: z.string().trim().min(1).max(1000).optional(),
});

export function createGetVideoFramesTool(context: AgentToolContext) {
  return tool({
    description: 'Retrieve or reuse up to six video frames at millisecond timestamps. Supply analysis with your question to analyze immediately while images are saved. Omit analysis for retrieval only. Returns saved assetVersions, dimensions, previews and failures, without image bytes. Use analyze_video_frames for questions about versions already saved. If suitable frames already exist in session inventory, analyze them directly. Still images cannot establish motion or speech.',
    inputSchema: getVideoFramesInputSchema.omit({ focus: true }),
    outputSchema: evidencePacketSchema,
    toModelOutput: ({ output }) => ({ type: 'text', value: JSON.stringify({
      ...output, artifacts: output.artifacts.map(artifact => {
        const { combinedTimingsMs: _combinedTimings, visualDiagnostics: _visualDiagnostics, timingsMs: _timings, extractionDiagnostics: _diagnostics, ...data } = artifact.data;
        return { ...artifact, data };
      }),
    }) }),
    execute: (input, { toolCallId }) => executeGetVideoFrames(input, context, toolCallId),
  });
}

export function executeGetVideoFrames(input: z.input<typeof getVideoFramesInputSchema>, context: AgentToolContext, toolCallId: string) {
  const parsed = getVideoFramesInputSchema.parse(input);
  const request = { videoId: parsed.videoId, maxWidth: parsed.maxWidth,
    timestampsMs: [...new Set(parsed.timestampsMs)].sort((a, b) => a - b) };
  return withPreviewCleanup(context, context => context.executeEvidenceTool({
    retrySavedAnalysis: parsed.analysis ? packet => retrySavedAnalysis(packet, context, toolCallId,
      () => executeAnalyzeVideoFrames({ assetVersions: packet.assetVersions!, focus: parsed.analysis! }, context, `${toolCallId}:analyze`)) : undefined,
    input: parsed,
    toolCallId, toolName: 'get_video_frames', operation: 'frames',
    semanticKey: `frames:${JSON.stringify({ ...request, ...(parsed.analysis ? { analysis: parsed.analysis } : {}) })}`,
    execute: () => diagnoseVisualTool('frames', async () => {
      context.signal.throwIfAborted();
      if (!context.provider.frames) throw new Error('Frame retrieval is unavailable.');
      const extractionTimeoutMs = frameExtractionBudget(context.researchDeadlineAt);
      if (extractionTimeoutMs < FRAME_EXTRACTION_MIN_MS) {
        throw new Error('Insufficient time for frame extraction and analysis. Finalize using the available evidence.');
      }
      countVisualWork('requestedImages', request.timestampsMs.length);
      const startedAt = Date.now();
      const extractionDiagnostics: ExtractionAttempt[] = [];
      let previews: z.infer<typeof framePreviewSchema>[] | undefined;
      let previewFailed = false, previewMs = 0;
      const { response, finish, retrievalMs } = await retrieveWithAnalysis(context, parsed.analysis ? {
        videoId: parsed.videoId, toolCallId,
        content: value => {
          const frames = validateFrameResponse(request, value);
          if (!frames.frames.length) throw new Error('No frames are available for analysis.');
          return { videoId: frames.videoId, frames: frames.frames };
        },
        analyze: (value, analysisContext) => analyzeFrameEvidence(validateFrameResponse(request, value), parsed.analysis!, analysisContext, toolCallId),
      } : undefined, onReady => visualSpan('retrieval', () => context.provider.frames!(request, context.signal, { extractionTimeoutMs },
        event => { extractionDiagnostics.push(event); context.onExtractionDiagnostic?.({ ...event, toolCallId }); }, ...(onReady ? [onReady] : []))), async (response, signal) => {
        const frames = validateFrameResponse(request, response.value);
        if (!context.saveFramePreviews) return;
        const started = Date.now();
        try {
          previews = z.array(framePreviewSchema).max(6).parse(
            await visualSpan('previews', () => context.saveFramePreviews!(frames, signal, response.verifiedImages)));
        } catch {
          signal.throwIfAborted();
          previewFailed = true;
        } finally { previewMs = Date.now() - started; }
      });
      context.signal.throwIfAborted();
      const providerMs = retrievalMs;
      const frames = validateFrameResponse(request, response.value);
      countVisualWork('returnedImages', frames.frames.length);
      console.log(JSON.stringify({ event: 'agent_frame_timings', runId: context.runId, toolCallId,
        extractionMs: retrievalMs, extractionTimeoutMs,
        sessionReused: response.sessionReused === true, frameCount: frames.frames.length, unavailableCount: frames.failures.length }));
      const sourceId = `youtube:${parsed.videoId}:frames`;
      const packet = evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`, kind: 'youtube_frames',
        sources: [{ id: sourceId, provider: 'youtube', kind: 'frames', videoId: parsed.videoId, url: youtubeVideoUrl(parsed.videoId) }],
        excerpts: [],
        artifacts: [{ type: 'youtube_frame_retrieval', title: `Selected frames for ${parsed.videoId}`,
          data: { timingsMs: { ...response.frameTimingsMs, provider: providerMs }, extractionDiagnostics, sessionReused: response.sessionReused === true, videoId: parsed.videoId, requestedTimestampsMs: request.timestampsMs,
            frames: frames.frames.map(({ imageBase64, ...mapping }) => mapping), failures: frames.failures } }],
        warnings: [
          { code: 'SELECTED_FRAME_EVIDENCE', message: 'Observations cover selected still frames only. Timestamps identify requested seek positions.' },
          ...frames.meta.warnings.map(message => ({ code: 'FRAME_EXTRACTION_WARNING', message })),
          ...frames.failures.map(failure => ({ code: 'FRAME_UNAVAILABLE', message: `Frame at ${failure.timestampMs}ms is unavailable (${failure.code}).` })),
        ],
        assetVersions: response.assetVersions,
        usage: [retrievalUsage('frames', response, meteredCredits('frames'))],
      });
      if (previews) packet.artifacts[0]!.data.previews = previews;
      if (previewFailed) packet.warnings.push({ code: 'FRAME_PREVIEW_UNAVAILABLE',
        message: 'The frames were retrieved, but their image previews could not be saved.' });
      const timingsMs = { ...response.frameTimingsMs, provider: providerMs,
        previews: previewMs, toolWork: Date.now() - startedAt };
      packet.artifacts[0]!.data.timingsMs = timingsMs;
      console.info(JSON.stringify({ event: 'frame_stage_timing', runId: context.runId, toolCallId, videoId: parsed.videoId, timingsMs }));
      context.signal.throwIfAborted();
      return finish(packet);
    }, { runId: context.runId, toolCallId }),
  }));
}
