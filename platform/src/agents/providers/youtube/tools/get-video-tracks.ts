import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import {
  bounded,
  executeProviderEvidence,
  MAX_PROVIDER_ITEMS,
  meteredCredits,
  providerWarnings,
  safeIdPart,
  videoIdSchema,
  youtubeVideoUrl,
} from './provider-evidence';

export const getVideoTracksInputSchema = z.object({ videoId: videoIdSchema });
export type GetVideoTracksInput = z.infer<typeof getVideoTracksInputSchema>;

export function createGetVideoTracksTool(context: AgentToolContext) {
  return tool({
    description: 'List source caption tracks and translation targets for exactly one YouTube video. This returns track metadata, not transcript text.',
    inputSchema: getVideoTracksInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoTracks(input, context, toolCallId),
  });
}

export function executeGetVideoTracks(
  input: GetVideoTracksInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = getVideoTracksInputSchema.parse(input);
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_video_tracks',
    operation: 'tracks',
    semanticInput: parsed,
    load: () => context.provider.tracks(parsed.videoId),
    credits: meteredCredits('tracks'),
    packet: (value) => {
      const sourceId = `youtube:${parsed.videoId}:tracks`;
      const trackLines = value.sourceTracks.slice(0, MAX_PROVIDER_ITEMS).map((track) =>
        `${track.languageCode}: ${track.name} (${track.kind}${track.isDefault ? ', default' : ''})`);
      return {
        kind: 'youtube_tracks' as const,
        sources: [{
          id: sourceId,
          provider: 'youtube' as const,
          kind: 'tracks' as const,
          videoId: parsed.videoId,
          url: youtubeVideoUrl(parsed.videoId),
        }],
        excerpts: [{
          id: `tracks:${safeIdPart(parsed.videoId)}:summary`,
          sourceId,
          text: bounded(trackLines.join('\n') || 'No caption tracks were returned.'),
        }],
        artifacts: [{
          type: 'youtube_caption_tracks',
          title: `Caption tracks for ${parsed.videoId}`,
          data: {
            defaultTrackId: value.defaultTrackId,
            sourceTracks: value.sourceTracks.slice(0, MAX_PROVIDER_ITEMS),
            translationLanguages: value.translationLanguages.slice(0, 40),
          },
        }],
        warnings: providerWarnings(
          value.meta,
          'PARTIAL_CAPTION_TRACKS',
          'YouTube returned partial caption-track metadata.',
        ),
      };
    },
  });
}
