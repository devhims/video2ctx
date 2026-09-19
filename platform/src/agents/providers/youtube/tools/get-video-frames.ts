import { tool } from 'ai';
import { z } from 'zod';
import { frameRequestSchema, validateFrameResponse } from '../../../../lib/youtube-frames';
import { evidencePacketSchema } from '../../../contracts';
import { framePreviewSchema } from '../../../runtime/frame-previews';
import { frameExtractionBudget, FRAME_EXTRACTION_MIN_MS } from '../../../runtime/frame-budget';
import type { AgentToolContext } from '../tool-context';
import { meteredCredits, safeIdPart, youtubeVideoUrl } from './provider-evidence';

export const getVideoFramesInputSchema = frameRequestSchema.extend({
  focus: z.string().trim().min(1).max(1000).optional(),
});

export function createGetVideoFramesTool(context: AgentToolContext) {
  return tool({
    description: 'Retrieve or reuse up to six video frames at millisecond timestamps. This performs no visual analysis. Returns saved assetVersions, dimensions, previews and failures, without image bytes. Use analyze_video_frames with those versions and a question. If suitable frames already exist in session inventory, analyze them directly. Still images cannot establish motion or speech.',
    inputSchema: getVideoFramesInputSchema.omit({ focus: true }),
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoFrames(input, context, toolCallId),
  });
}

export function executeGetVideoFrames(input: z.input<typeof getVideoFramesInputSchema>, context: AgentToolContext, toolCallId: string) {
  const parsed = getVideoFramesInputSchema.parse(input);
  const request = { videoId: parsed.videoId, maxWidth: parsed.maxWidth,
    timestampsMs: [...new Set(parsed.timestampsMs)].sort((a, b) => a - b) };
  return context.executeEvidenceTool({
    toolCallId, toolName: 'get_video_frames', operation: 'frames',
    semanticKey: `frames:${JSON.stringify(request)}`,
    execute: async () => {
      context.signal.throwIfAborted();
      if (!context.provider.frames) throw new Error('Frame retrieval is unavailable.');
      const extractionTimeoutMs = frameExtractionBudget(context.researchDeadlineAt);
      if (extractionTimeoutMs < FRAME_EXTRACTION_MIN_MS) {
        throw new Error('Insufficient time for frame extraction and analysis. Finalize using the available evidence.');
      }
      const startedAt = Date.now();
      const response = await context.provider.frames(request, context.signal, { extractionTimeoutMs },
        event => context.onExtractionDiagnostic?.({ ...event, toolCallId }));
      context.signal.throwIfAborted();
      const frames = validateFrameResponse(request, response.value);
      console.log(JSON.stringify({ event: 'agent_frame_timings', runId: context.runId, toolCallId,
        extractionMs: Date.now() - startedAt, extractionTimeoutMs,
        sessionReused: response.sessionReused === true, frameCount: frames.frames.length, unavailableCount: frames.failures.length }));
      const sourceId = `youtube:${parsed.videoId}:frames`;
      const packet = evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`, kind: 'youtube_frames',
        sources: [{ id: sourceId, provider: 'youtube', kind: 'frames', videoId: parsed.videoId, url: youtubeVideoUrl(parsed.videoId) }],
        excerpts: [],
        artifacts: [{ type: 'youtube_frame_retrieval', title: `Selected frames for ${parsed.videoId}`,
          data: { sessionReused: response.sessionReused === true, videoId: parsed.videoId, requestedTimestampsMs: request.timestampsMs,
            frames: frames.frames.map(({ imageBase64, ...mapping }) => mapping), failures: frames.failures } }],
        warnings: [
          { code: 'SELECTED_FRAME_EVIDENCE', message: 'Observations cover selected still frames only. Timestamps identify requested seek positions.' },
          ...frames.meta.warnings.map(message => ({ code: 'FRAME_EXTRACTION_WARNING', message })),
          ...frames.failures.map(failure => ({ code: 'FRAME_UNAVAILABLE', message: `Frame at ${failure.timestampMs}ms is unavailable (${failure.code}).` })),
        ],
        assetVersions: response.assetVersions,
        usage: [{ operation: 'frames', credits: response.sessionReused ? 0 : meteredCredits('frames')(response.cacheStatus), cacheStatus: response.cacheStatus }],
      });
      if (context.saveFramePreviews) {
        try {
          const previews = z.array(framePreviewSchema).max(6).parse(
            await context.saveFramePreviews(frames, context.signal),
          );
          packet.artifacts[0]!.data.previews = previews;
        } catch {
          context.signal.throwIfAborted();
          packet.warnings.push({ code: 'FRAME_PREVIEW_UNAVAILABLE',
            message: 'The frames were retrieved, but their image previews could not be saved.' });
        }
      }
      context.signal.throwIfAborted();
      return packet;
    },
  });
}
