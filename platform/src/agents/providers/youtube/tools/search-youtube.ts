import type { SearchFilters, SearchResult } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { dataOperationCost } from '../../../../lib/metering';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';

const MAX_RESULTS = 12;

export const searchYouTubeInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  type: z.enum(['all', 'video', 'channel', 'playlist']).optional(),
  channelId: z.string().trim().min(1).max(200).optional(),
  dateFrom: z.string().max(50).optional(),
  dateTo: z.string().max(50).optional(),
  language: z.string().trim().min(2).max(20).optional(),
  duration: z.enum(['short', 'medium', 'long']).optional(),
  sort: z.enum(['relevance', 'date', 'views', 'rating']).optional(),
  captionsOnly: z.boolean().optional(),
  live: z.enum(['live', 'upcoming', 'completed']).optional(),
  minViews: z.number().int().nonnegative().max(10_000_000_000).optional(),
  continuation: z.string().max(4_000).optional(),
});

export type SearchYouTubeInput = z.infer<typeof searchYouTubeInputSchema>;

export function createSearchYouTubeTool(context: AgentToolContext) {
  return tool({
    description: [
      'Search YouTube with one focused query and optional filters.',
      'Each call performs exactly one provider search. Topic research permits one call per run, so choose the query carefully.',
      'The result contains bounded candidate evidence and canonical credit usage.',
    ].join(' '),
    inputSchema: searchYouTubeInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeSearchYouTube(input, context, toolCallId),
  });
}

export function executeSearchYouTube(
  input: SearchYouTubeInput,
  context: AgentToolContext,
  toolCallId: string,
): Promise<EvidencePacket> {
  const parsed = searchYouTubeInputSchema.parse(input);
  const filters: SearchFilters = {
    type: parsed.type,
    channelId: parsed.channelId,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    language: parsed.language,
    duration: parsed.duration,
    sort: parsed.sort,
    captionsOnly: parsed.captionsOnly,
    live: parsed.live,
    minViews: parsed.minViews,
    continuation: parsed.continuation,
  };
  const semanticKey = `search:${JSON.stringify(parsed)}`;

  return context.executeEvidenceTool({
    toolCallId,
    toolName: 'search_youtube',
    semanticKey,
    operation: 'search',
    execute: async () => {
      context.signal.throwIfAborted();
      const response = await context.provider.search(parsed.query, filters);
      context.signal.throwIfAborted();
      const results = response.value.results.slice(0, MAX_RESULTS);
      const packetId = `packet:${context.runId}:${safeIdPart(toolCallId)}`;
      const sources = results.map((result, index) => ({
        id: searchSourceId(toolCallId, result, index),
        provider: 'youtube' as const,
        kind: 'search' as const,
        ...(result.type === 'video' ? { videoId: result.id } : {}),
        title: result.type === 'channel' ? result.name : result.title,
        url: result.url,
      }));
      const excerpts = results.map((result, index) => ({
        id: `search:${safeIdPart(toolCallId)}:${index}`,
        sourceId: sources[index]!.id,
        text: summarizeResult(result),
      }));

      return evidencePacketSchema.parse({
        packetId,
        kind: 'youtube_search',
        sources,
        excerpts,
        artifacts: [{
          type: 'youtube_search_candidates',
          title: `YouTube results for “${parsed.query}”`,
          data: {
            query: parsed.query,
            resultCount: results.length,
            candidates: results.map((result) => candidateArtifact(result)),
          },
        }],
        continuation: response.value.continuation,
        warnings: [
          ...response.value.meta.warnings.map((message) => ({ code: 'YOUTUBE_PROVIDER_WARNING', message })),
          ...(response.value.meta.partial
            ? [{ code: 'PARTIAL_YOUTUBE_RESULTS', message: 'YouTube returned partial search results.' }]
            : []),
        ],
        usage: [{
          operation: 'search',
          credits: dataOperationCost('search', response.cacheStatus),
          cacheStatus: response.cacheStatus,
        }],
      });
    },
  });
}

function searchSourceId(toolCallId: string, result: SearchResult, index: number): string {
  return `youtube:${result.type}:${safeIdPart(result.id)}:${safeIdPart(toolCallId)}:${index}`;
}

function summarizeResult(result: SearchResult): string {
  if (result.type === 'video') {
    return bounded([
      result.title,
      `Channel: ${result.channel.name}`,
      result.description,
      result.viewCountText ? `Views: ${result.viewCountText}` : undefined,
      result.publishedTimeText ? `Published: ${result.publishedTimeText}` : undefined,
      result.durationText ? `Duration: ${result.durationText}` : undefined,
      result.hasCaptions === true ? 'Captions: available' : undefined,
    ].filter(Boolean).join('\n'));
  }
  if (result.type === 'channel') {
    return bounded([
      result.name,
      result.description,
      result.subscriberCountText ? `Subscribers: ${result.subscriberCountText}` : undefined,
      result.videoCountText ? `Videos: ${result.videoCountText}` : undefined,
    ].filter(Boolean).join('\n'));
  }
  return bounded([
    result.title,
    result.description,
    result.channel?.name ? `Channel: ${result.channel.name}` : undefined,
    result.videoCountText ? `Videos: ${result.videoCountText}` : undefined,
  ].filter(Boolean).join('\n'));
}

function candidateArtifact(result: SearchResult): Record<string, unknown> {
  return {
    type: result.type,
    id: result.id,
    title: result.type === 'channel' ? result.name : result.title,
    url: result.url,
    ...(result.type === 'video' ? {
      channel: result.channel.name,
      viewCount: result.viewCount,
      publishedTimeText: result.publishedTimeText,
      durationSeconds: result.durationSeconds,
      hasCaptions: result.hasCaptions,
    } : {}),
  };
}

function bounded(value: string): string {
  const normalized = value.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return normalized.slice(0, 2_000) || 'No description was returned.';
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}
