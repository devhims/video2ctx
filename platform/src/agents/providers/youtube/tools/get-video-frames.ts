import { tool } from 'ai';
import { z } from 'zod';
import { frameRequestSchema, validateFrameResponse } from '../../../../lib/youtube-frames';
import { evidencePacketSchema } from '../../../contracts';
import { framePreviewSchema } from '../../../runtime/frame-previews';
import type { AgentToolContext } from '../tool-context';
import { meteredCredits, safeIdPart, youtubeVideoUrl } from './provider-evidence';

export const getVideoFramesInputSchema = frameRequestSchema.extend({
  focus: z.string().trim().min(1).max(1000).describe('The visual question to answer using these specific frames.'),
});

export function createGetVideoFramesTool(context: AgentToolContext) {
  return tool({
    description: 'Extract and inspect up to six individual video frames at requested millisecond timestamps. Use get_video_storyboard first to locate relevant moments, then this tool for small text, charts, code, or an ambiguous sampled image. You may request a frame directly when its timestamp is already known. Default maxWidth is 1920 without upscaling; source quality is best effort and reported. Timestamps must be strictly before the video duration. Returns focused visual observations with timestamped evidence, plus unavailable-frame and quality warnings. Still images cannot establish motion or speech.',
    inputSchema: getVideoFramesInputSchema,
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
    semanticKey: `frames:${JSON.stringify({ ...request, focus: parsed.focus })}`,
    execute: async () => {
      context.signal.throwIfAborted();
      if (!context.provider.frames || !context.analyzeFrames) throw new Error('Frame analysis is unavailable.');
      const response = await context.provider.frames(request, context.signal);
      context.signal.throwIfAborted();
      const frames = validateFrameResponse(request, response.value);
      const analysis = await context.analyzeFrames({ frames, focus: parsed.focus, signal: context.signal,
        modelCallId: `frame-analyst:${context.runId}:${toolCallId}` });
      context.signal.throwIfAborted();
      const sourceId = `youtube:${parsed.videoId}:frames`;
      const packet = evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`, kind: 'youtube_frames',
        sources: [{ id: sourceId, provider: 'youtube', kind: 'frames', videoId: parsed.videoId, url: youtubeVideoUrl(parsed.videoId) }],
        excerpts: analysis.findings.flatMap((finding, index) => [...new Set(finding.timestampsMs)].map(time => {
          if (!frames.frames.some(frame => frame.timestampMs === time)) throw new Error('Analyst cited an unavailable frame.');
          return { id: `frames:${parsed.videoId}:${safeIdPart(toolCallId)}:${index}:${time}`, sourceId,
            text: `Visual observation at requested frame: ${finding.observation}`, startMs: time, endMs: time };
        })),
        artifacts: [{ type: 'youtube_frame_analysis', title: `Selected frames for ${parsed.videoId}`,
          data: { videoId: parsed.videoId, focus: parsed.focus, requestedTimestampsMs: request.timestampsMs,
            frames: frames.frames.map(({ imageBase64, ...mapping }) => mapping), failures: frames.failures } }],
        warnings: [
          { code: 'SELECTED_FRAME_EVIDENCE', message: 'Observations cover selected still frames only. Timestamps identify requested seek positions.' },
          ...frames.meta.warnings.map(message => ({ code: 'FRAME_EXTRACTION_WARNING', message })),
          ...frames.failures.map(failure => ({ code: 'FRAME_UNAVAILABLE', message: `Frame at ${failure.timestampMs}ms is unavailable (${failure.code}).` })),
          ...analysis.warnings.map(message => ({ code: 'VISUAL_ANALYSIS_WARNING', message })),
        ],
        usage: [{ operation: 'frames', credits: meteredCredits('frames')(response.cacheStatus), cacheStatus: response.cacheStatus }],
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
            message: 'The frames were analyzed, but their image previews could not be saved.' });
        }
      }
      context.signal.throwIfAborted();
      return packet;
    },
  });
}
