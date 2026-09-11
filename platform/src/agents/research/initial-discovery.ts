import type { CapabilityRouteDecision } from '../contracts';
import type { AgentToolContext } from '../providers/youtube/tool-context';
import { executeGetChannel } from '../providers/youtube/tools/get-channel';
import { executeGetChannelVideos } from '../providers/youtube/tools/get-channel-videos';
import { executeSearchYouTube } from '../providers/youtube/tools/search-youtube';

/** Resolve channel identity before spending the one-search budget. All reads use
 * the ordinary durable, metered tools, so recovery reuses their saved packets. */
export async function discoverInitialEvidence(
  decision: Extract<CapabilityRouteDecision, { route: 'topic_research' }>,
  context: AgentToolContext,
  searchUsed: boolean,
) {
  if (!decision.channelId) {
    if (decision.searchQuery && !searchUsed) await executeSearchYouTube(
      { query: decision.searchQuery, type: 'video' }, context, `initial-search:${context.runId}`,
    );
    return;
  }
  const channel = await executeGetChannel({ channelId: decision.channelId }, context, `initial-channel:${context.runId}`);
  const channelId = channel.sources.find(source => source.kind === 'channel')?.channelId;
  if (!channelId) throw new Error('The requested channel identity could not be resolved.');
  const handle = channel.artifacts.find(artifact => artifact.type === 'youtube_channel_metadata')?.data.handle;
  if (decision.channelId.startsWith('@') && typeof handle === 'string'
    && handle.toLowerCase() !== decision.channelId.toLowerCase()) {
    throw new Error('The resolved channel does not match the requested handle.');
  }
  const name = channel.sources.find(source => source.kind === 'channel')?.title;
  const reads = [executeGetChannelVideos({ channelId, sort: 'latest' }, context, `initial-channel-videos:${context.runId}`)];
  if (decision.searchQuery && !searchUsed) reads.push(executeSearchYouTube({
    query: [name, decision.searchQuery].filter(Boolean).join(' ').slice(0, 500), type: 'video', channelId,
  }, context, `initial-search:${context.runId}`));
  const results = await Promise.allSettled(reads);
  context.signal.throwIfAborted();
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
