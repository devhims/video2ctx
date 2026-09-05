import type { Channel } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import {
  bounded,
  channelIdSchema,
  executeProviderEvidence,
  meteredCredits,
  providerWarnings,
  safeIdPart,
} from './provider-evidence';

export const getChannelInputSchema = z.object({ channelId: channelIdSchema });
export type GetChannelInput = z.infer<typeof getChannelInputSchema>;

export function createGetChannelTool(context: AgentToolContext) {
  return tool({
    description: 'Read identity and public About metadata for exactly one YouTube channel or handle.',
    inputSchema: getChannelInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetChannel(input, context, toolCallId),
  });
}

export function executeGetChannel(
  input: GetChannelInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = getChannelInputSchema.parse(input);
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_channel',
    operation: 'channel',
    semanticInput: parsed,
    load: () => context.provider.channel(parsed.channelId),
    credits: meteredCredits('channel'),
    packet: (channel) => channelPacket(channel),
  });
}

function channelPacket(channel: Channel): Omit<EvidencePacket, 'packetId' | 'usage'> {
  const sourceId = `youtube:channel:${safeIdPart(channel.id)}`;
  return {
    kind: 'youtube_channel',
    sources: [{
      id: sourceId,
      provider: 'youtube',
      kind: 'channel',
      channelId: channel.id,
      title: channel.name,
      url: channel.url,
    }],
    excerpts: [{
      id: `channel:${safeIdPart(channel.id)}:about`,
      sourceId,
      text: bounded([
        channel.name,
        channel.handle ? `Handle: ${channel.handle}` : undefined,
        channel.about.description,
        channel.about.moreInfo.subscriberCountText
          ? `Subscribers: ${channel.about.moreInfo.subscriberCountText}`
          : undefined,
        channel.about.moreInfo.videoCountText
          ? `Videos: ${channel.about.moreInfo.videoCountText}`
          : undefined,
        channel.about.moreInfo.viewCountText
          ? `Views: ${channel.about.moreInfo.viewCountText}`
          : undefined,
        channel.about.moreInfo.joinedDateText
          ? `Joined: ${channel.about.moreInfo.joinedDateText}`
          : undefined,
      ].filter(Boolean).join('\n')),
    }],
    artifacts: [{
      type: 'youtube_channel_metadata',
      title: channel.name,
      data: { id: channel.id, handle: channel.handle, about: channel.about },
    }],
    warnings: providerWarnings(
      channel.meta,
      'PARTIAL_CHANNEL_METADATA',
      'YouTube returned partial channel metadata.',
    ),
  };
}
