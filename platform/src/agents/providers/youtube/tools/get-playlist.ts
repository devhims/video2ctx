import type { Playlist } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import {
  entityArtifact,
  entitySummary,
  executeProviderEvidence,
  MAX_PROVIDER_ITEMS,
  meteredCredits,
  playlistIdSchema,
  providerWarnings,
  safeIdPart,
} from './provider-evidence';

export const getPlaylistInputSchema = z.object({ playlistId: playlistIdSchema });
export type GetPlaylistInput = z.infer<typeof getPlaylistInputSchema>;

export function createGetPlaylistTool(context: AgentToolContext) {
  return tool({
    description: 'Read metadata and one video page for exactly one YouTube playlist.',
    inputSchema: getPlaylistInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetPlaylist(input, context, toolCallId),
  });
}

export function executeGetPlaylist(
  input: GetPlaylistInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = getPlaylistInputSchema.parse(input);
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_playlist',
    operation: 'playlist',
    semanticInput: parsed,
    load: () => context.provider.playlist(parsed.playlistId),
    credits: meteredCredits('playlist'),
    packet: (value) => playlistPacket(value, toolCallId),
  });
}

function playlistPacket(playlist: Playlist, toolCallId: string): Omit<EvidencePacket, 'packetId' | 'usage'> {
  const videos = playlist.videos.slice(0, MAX_PROVIDER_ITEMS);
  const sources = videos.map((video, index) => ({
    id: `youtube:playlist:${safeIdPart(playlist.id)}:${safeIdPart(video.id)}:${index}`,
    provider: 'youtube' as const,
    kind: 'playlist' as const,
    playlistId: playlist.id,
    videoId: video.id,
    title: video.title,
    url: video.url,
  }));
  return {
    kind: 'youtube_playlist',
    sources,
    excerpts: videos.map((video, index) => ({
      id: `playlist:${safeIdPart(toolCallId)}:${index}`,
      sourceId: sources[index]!.id,
      text: entitySummary(video),
    })),
    artifacts: [{
      type: 'youtube_playlist',
      title: playlist.title,
      data: {
        id: playlist.id,
        title: playlist.title,
        description: playlist.description,
        channel: playlist.channel,
        videoCount: playlist.videoCount,
        returnedVideos: videos.map(entityArtifact),
      },
    }],
    continuation: playlist.continuation,
    warnings: providerWarnings(
      playlist.meta,
      'PARTIAL_PLAYLIST',
      'YouTube returned a partial playlist page.',
    ),
  };
}
