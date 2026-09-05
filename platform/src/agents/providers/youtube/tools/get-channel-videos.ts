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

export const getChannelVideosInputSchema = z.object({
  channelId: channelIdSchema,
  sort: z.enum(['latest', 'popular', 'oldest']).default('latest'),
  continuation: continuationSchema,
});

export type GetChannelVideosInput = z.infer<typeof getChannelVideosInputSchema>;

export function createGetChannelVideosTool(context: AgentToolContext) {
  return tool({
    description: 'List one page from exactly one YouTube channel Videos tab.',
    inputSchema: getChannelVideosInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetChannelVideos(input, context, toolCallId),
  });
}

export function executeGetChannelVideos(
  input: GetChannelVideosInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = getChannelVideosInputSchema.parse(input);
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_channel_videos',
    operation: 'channelVideos',
    semanticInput: parsed,
    load: () => context.provider.channelVideos(parsed.channelId, parsed.continuation, parsed.sort),
    credits: meteredCredits('channelVideos'),
    packet: (value) => entityListPacket({
      kind: 'youtube_channel_videos',
      sourceKind: 'channel_videos',
      toolCallId,
      title: `Videos from ${value.channelId}`,
      results: value.videos,
      continuation: value.continuation,
      warnings: providerWarnings(
        value.meta,
        'PARTIAL_CHANNEL_VIDEOS',
        'YouTube returned a partial channel video page.',
      ),
      artifactType: 'youtube_channel_videos',
      artifactData: { channelId: value.channelId, sort: value.sort },
    }),
  });
}
