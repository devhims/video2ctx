import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import {
  channelIdSchema,
  continuationSchema,
  entityListPacket,
  executeProviderEvidence,
  meteredCredits,
  providerWarnings,
} from './provider-evidence';

export const getChannelPlaylistsInputSchema = z.object({
  channelId: channelIdSchema,
  sort: z.enum(['newest', 'last-video-added']).default('newest'),
  continuation: continuationSchema,
});

export type GetChannelPlaylistsInput = z.infer<typeof getChannelPlaylistsInputSchema>;

export function createGetChannelPlaylistsTool(context: AgentToolContext) {
  return tool({
    description: 'List one page from exactly one YouTube channel Playlists tab.',
    inputSchema: getChannelPlaylistsInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetChannelPlaylists(input, context, toolCallId),
  });
}

export function executeGetChannelPlaylists(
  input: GetChannelPlaylistsInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = getChannelPlaylistsInputSchema.parse(input);
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_channel_playlists',
    operation: 'channelPlaylists',
    semanticInput: parsed,
    load: () => context.provider.channelPlaylists(parsed.channelId, parsed.continuation, parsed.sort),
    credits: meteredCredits('channelPlaylists'),
    packet: (value) => entityListPacket({
      kind: 'youtube_channel_playlists',
      sourceKind: 'channel_playlists',
      toolCallId,
      title: `Playlists from ${value.channelId}`,
      results: value.playlists,
      continuation: value.continuation,
      warnings: providerWarnings(
        value.meta,
        'PARTIAL_CHANNEL_PLAYLISTS',
        'YouTube returned a partial channel playlist page.',
      ),
      artifactType: 'youtube_channel_playlists',
      artifactData: { channelId: value.channelId, sort: value.sort },
    }),
  });
}
