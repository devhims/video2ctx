import type { Video } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import {
  bounded,
  executeProviderEvidence,
  meteredCredits,
  providerWarnings,
  safeIdPart,
  videoIdSchema,
} from './provider-evidence';

export const getVideoInputSchema = z.object({ videoId: videoIdSchema });
export type GetVideoInput = z.infer<typeof getVideoInputSchema>;

export function createGetVideoTool(context: AgentToolContext) {
  return tool({
    description: 'Read core metadata for exactly one YouTube video. This does not fetch transcripts, comments, tracks, or endscreen elements.',
    inputSchema: getVideoInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideo(input, context, toolCallId),
  });
}

export function executeGetVideo(input: GetVideoInput, context: AgentToolContext, toolCallId: string) {
  const parsed = getVideoInputSchema.parse(input);
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_video',
    operation: 'video',
    semanticInput: parsed,
    load: () => context.provider.video(parsed.videoId),
    credits: meteredCredits('video'),
    packet: (video) => singleVideoPacket(video, toolCallId),
  });
}

function singleVideoPacket(video: Video, toolCallId: string): Omit<EvidencePacket, 'packetId' | 'usage'> {
  const sourceId = `youtube:video:${safeIdPart(video.id)}`;
  return {
    kind: 'youtube_video',
    sources: [{
      id: sourceId,
      provider: 'youtube',
      kind: 'video',
      videoId: video.id,
      channelId: video.channel.id,
      title: video.title,
      url: video.url,
    }],
    excerpts: [{
      id: `video:${safeIdPart(video.id)}:${safeIdPart(toolCallId)}`,
      sourceId,
      text: bounded([
        video.title,
        `Channel: ${video.channel.name}`,
        video.description,
        video.viewCountText ? `Views: ${video.viewCountText}` : undefined,
        video.publishedTimeText ? `Published: ${video.publishedTimeText}` : undefined,
        video.durationText ? `Duration: ${video.durationText}` : undefined,
        `Availability: ${video.availability.status}`,
        video.keywords.length ? `Keywords: ${video.keywords.slice(0, 20).join(', ')}` : undefined,
      ].filter(Boolean).join('\n')),
    }],
    artifacts: [{
      type: 'youtube_video_metadata',
      title: video.title,
      data: {
        id: video.id,
        channel: video.channel,
        durationSeconds: video.durationSeconds,
        viewCount: video.viewCount,
        isLive: video.isLive,
        hasCaptions: video.hasCaptions,
        keywords: video.keywords.slice(0, 40),
        availability: video.availability,
      },
    }],
    warnings: providerWarnings(
      video.meta,
      'PARTIAL_VIDEO_METADATA',
      'YouTube returned partial video metadata.',
    ),
  };
}
