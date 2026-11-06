import { executeGetVideo } from './get-video';
import { ApiError } from '../../../../lib/http';
import { eligibleDuration, verifiedFrameMetadata, VideoTooLongError } from '../../../runtime/video-duration-limit';
import { frameSelectionsSchema } from '../../../runtime/frame-selection';
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
import { clockTime } from '../../../runtime/clock-time';
import type { AgentToolContext } from '../tool-context';
import { meteredCredits, safeIdPart, youtubeVideoUrl } from './provider-evidence';

export const getVideoFramesInputSchema = frameRequestSchema.extend({
  analysis: retrievalAnalysisSchema,
  focus: z.string().trim().min(1).max(1000).optional(),
  selections: frameSelectionsSchema.optional(),
});

export function createGetVideoFramesTool(context: AgentToolContext) {
  return tool({
    description: 'Retrieve or reuse up to six video frames at millisecond timestamps. Supply analysis with your question to analyze immediately while images are saved. Omit analysis for retrieval only. Returns saved assetVersions, dimensions and failures, without image bytes. Use analyze_video_frames for questions about versions already saved. If suitable frames already exist in session inventory, analyze them directly. Still images cannot establish motion or speech.',
    inputSchema: getVideoFramesInputSchema.omit({ focus: true }),
    outputSchema: evidencePacketSchema,
    // Previews are dashboard images with random IDs; the model analyzes assetVersions instead.
    toModelOutput: ({ output }) => ({ type: 'text', value: JSON.stringify({
      ...output, artifacts: output.artifacts.map(artifact => {
        const { combinedTimingsMs: _combinedTimings, visualDiagnostics: _visualDiagnostics, timingsMs: _timings, extractionDiagnostics: _diagnostics, previews: _previews, ...data } = artifact.data;
        return { ...artifact, data };
      }),
    }) }),
    execute: (input, { toolCallId }) => executeGetVideoFrames(input, context, toolCallId),
  });
}

export function executeGetVideoFrames(input: z.input<typeof getVideoFramesInputSchema>, context: AgentToolContext, toolCallId: string) {
  const parsed = getVideoFramesInputSchema.parse(input);
  if (!parsed.analysis && parsed.videoId === context.pinnedVideoId &&
    (!parsed.selections || parsed.selections.every(selection => selection.basis === 'user_requested'))) {
    parsed.analysis = context.timestampedFrameQuestion;
  }
  const request = { videoId: parsed.videoId, maxWidth: parsed.maxWidth,
    timestampsMs: [...new Set(parsed.timestampsMs)].sort((a, b) => a - b) };
  if (parsed.selections) {
    const times = parsed.selections.map(selection => selection.timestampMs);
    if (new Set(times).size !== request.timestampsMs.length || times.length !== request.timestampsMs.length
      || times.some(time => !request.timestampsMs.includes(time))) throw new Error('Supply one selection per requested timestamp.');
    const ids = new Set(context.getEvidence?.().flatMap(packet => packet.excerpts.filter(excerpt => packet.sources.some(source =>
      source.id === excerpt.sourceId && source.videoId === parsed.videoId)).map(excerpt => excerpt.id)) ?? []);
    if (parsed.selections.some(selection => selection.evidenceIds.some(id => !ids.has(id))))
      throw new Error('Frame selection cites an excerpt not delivered to this run. Use delivered locating evidence or mark the selection exploratory.');
  }
  const capture = (metadata: ReturnType<typeof verifiedFrameMetadata>) => withPreviewCleanup(context, context => context.executeEvidenceTool({
    retrySavedAnalysis: parsed.analysis ? packet => retrySavedAnalysis(packet, context, toolCallId,
      () => executeAnalyzeVideoFrames({ assetVersions: packet.assetVersions!, focus: parsed.analysis! }, context, `${toolCallId}:analyze`)) : undefined,
    input: parsed,
    toolCallId, toolName: 'get_video_frames', operation: 'frames',
    semanticKey: `frames:${JSON.stringify({ ...request, ...(parsed.analysis ? { analysis: parsed.analysis } : {}),
      ...(parsed.selections ? { selections: parsed.selections.slice().sort((a, b) => a.timestampMs - b.timestampMs) } : {}) })}`,
    execute: () => diagnoseVisualTool('frames', async () => {
      context.signal.throwIfAborted();
      if (context.maxVideoSeconds !== undefined) {
        const duration = eligibleDuration(metadata?.durationSeconds);
        if (duration === undefined) throw new Error('Verified video duration is unavailable. Frame capture requires a completed video with a known duration.');
        if (duration > context.maxVideoSeconds) throw new VideoTooLongError(request.videoId, duration, context.maxVideoSeconds);
        // Extraction rejects these too, but only after ~12 s in the Media path and the FFmpeg
        // fallback; failing here keeps the model from retrying them until the deadline.
        const durationMs = duration * 1_000;
        const pastEnd = request.timestampsMs.filter(timestamp => timestamp >= durationMs);
        if (pastEnd.length) throw new ApiError(422, 'FRAME_TIMESTAMP_PAST_END',
          `${pastEnd.map(timestamp => `${clockTime(timestamp)} (${timestamp} ms)`).join(', ')} ${pastEnd.length === 1 ? 'is' : 'are'} at or past the end of this video, which lasts ${clockTime(durationMs)} (${durationMs} ms). `
          + 'Do not repeat this request. Request only timestamps before the end, or finalize with the available evidence.');
      }
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
      } : undefined, onReady => visualSpan('retrieval', () => context.provider.frames!(request, context.signal, { extractionTimeoutMs,
          ...(!context.session && (context.refreshFramesOnly || context.refreshEvidence) ? { refresh: true } : {}) },
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
          data: { timingsMs: { ...response.frameTimingsMs, provider: providerMs }, extractionDiagnostics, sessionReused: response.sessionReused === true, videoId: parsed.videoId, requestedTimestampsMs: request.timestampsMs, selections: parsed.selections,
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

  if (context.maxVideoSeconds === undefined) return capture(undefined);
  const metadata = verifiedFrameMetadata(request.videoId, context.getEvidence?.() ?? []);
  if (eligibleDuration(metadata?.durationSeconds) !== undefined) return capture(metadata);
  // Meter and deduplicate the prerequisite before the frame tool holds credits. The duration
  // check belongs to capture: it may use provider calls kept for exact frames, but runs only
  // when one call still remains for that capture.
  return executeGetVideo({ videoId: request.videoId }, { ...context,
    executeEvidenceTool: execution => context.executeEvidenceTool({ ...execution, frameReserveCalls: 1 }) },
  `frame-metadata:${request.videoId}`, 'frame-duration')
    .catch(error => {
      if ((error as { code?: unknown })?.code !== 'AGENT_TOOL_BUDGET_EXCEEDED') throw error;
      throw new ApiError(422, 'AGENT_TOOL_BUDGET_EXCEEDED', 'Too few evidence tool calls remain to verify this video\'s duration and capture its frames. Finalize with the available evidence.');
    })
    .then(packet => capture(verifiedFrameMetadata(request.videoId, [packet])));
}
