import type { SearchResult, SourceMetadata } from 'all-things-youtube';
import { z } from 'zod';
import type { DataOperation, MeteredCacheStatus } from '../../../../lib/metering';
import { dataOperationCost } from '../../../../lib/metering';
import {
  evidencePacketSchema,
  type EvidenceOperation,
  type EvidencePacket,
} from '../../../contracts';
import type { CachedResult } from '../../../../lib/youtube';
import type { AgentToolContext } from '../tool-context';
import type { YouTubeProviderToolName } from '../tool-names';

export const MAX_PROVIDER_ITEMS = 12;
export const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
export const channelIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_@.\-]+$/);
export const playlistIdSchema = z.string().trim().min(2).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const continuationSchema = z.string().max(4_000).optional();

type PacketBody = Omit<EvidencePacket, 'packetId' | 'usage'>;

interface ProviderEvidenceExecution<T> {
  context: AgentToolContext;
  toolCallId: string;
  toolName: YouTubeProviderToolName;
  operation: EvidenceOperation;
  semanticInput: unknown;
  load: () => Promise<CachedResult<T>>;
  credits: (cacheStatus: MeteredCacheStatus) => number;
  packet: (value: T) => PacketBody;
}

export function executeProviderEvidence<T>(
  execution: ProviderEvidenceExecution<T>,
): Promise<EvidencePacket> {
  const semanticKey = `${execution.operation}:${JSON.stringify(execution.semanticInput)}`;
  return execution.context.executeEvidenceTool({
    toolCallId: execution.toolCallId,
    toolName: execution.toolName,
    semanticKey,
    operation: execution.operation,
    execute: async () => {
      execution.context.signal.throwIfAborted();
      const response = await execution.load();
      execution.context.signal.throwIfAborted();
      return evidencePacketSchema.parse({
        packetId: `packet:${execution.context.runId}:${safeIdPart(execution.toolCallId)}`,
        ...execution.packet(response.value),
        usage: [{
          operation: execution.operation,
          credits: execution.credits(response.cacheStatus),
          cacheStatus: response.cacheStatus,
        }],
      });
    },
  });
}

export function meteredCredits(operation: DataOperation) {
  return (cacheStatus: MeteredCacheStatus): number => dataOperationCost(operation, cacheStatus);
}

export function providerWarnings(
  meta: Pick<SourceMetadata, 'warnings' | 'partial'> | undefined,
  partialCode: string,
  partialMessage: string,
) {
  if (!meta) return [];
  return [
    ...meta.warnings.map((message) => ({ code: 'YOUTUBE_PROVIDER_WARNING', message })),
    ...(meta.partial ? [{ code: partialCode, message: partialMessage }] : []),
  ];
}

export function entitySummary(result: SearchResult): string {
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

export function entityArtifact(result: SearchResult): Record<string, unknown> {
  return {
    type: result.type,
    id: result.id,
    title: result.type === 'channel' ? result.name : result.title,
    url: result.url,
    ...(result.type === 'video' ? {
      channelId: result.channel.id,
      channel: result.channel.name,
      viewCount: result.viewCount,
      publishedTimeText: result.publishedTimeText,
      durationSeconds: result.durationSeconds,
      hasCaptions: result.hasCaptions,
    } : {}),
  };
}

export function entityListPacket(options: {
  kind: EvidencePacket['kind'];
  sourceKind: EvidencePacket['sources'][number]['kind'];
  toolCallId: string;
  title: string;
  results: SearchResult[];
  continuation?: string;
  warnings: EvidencePacket['warnings'];
  artifactType: string;
  artifactData: Record<string, unknown>;
}): Omit<EvidencePacket, 'packetId' | 'usage'> {
  const results = options.results.slice(0, MAX_PROVIDER_ITEMS);
  const sources = results.map((result, index) => ({
    id: `youtube:${options.sourceKind}:${safeIdPart(result.id)}:${safeIdPart(options.toolCallId)}:${index}`,
    provider: 'youtube' as const,
    kind: options.sourceKind,
    ...(result.type === 'video' ? { videoId: result.id } : {}),
    ...(result.type === 'channel' ? { channelId: result.id } : {}),
    ...(result.type === 'playlist' ? { playlistId: result.id } : {}),
    title: result.type === 'channel' ? result.name : result.title,
    url: result.url,
  }));
  return {
    kind: options.kind,
    sources,
    excerpts: results.map((result, index) => ({
      id: `${options.sourceKind}:${safeIdPart(options.toolCallId)}:${index}`,
      sourceId: sources[index]!.id,
      text: entitySummary(result),
    })),
    artifacts: [{
      type: options.artifactType,
      title: options.title,
      data: {
        ...options.artifactData,
        resultCount: results.length,
        candidates: results.map(entityArtifact),
      },
    }],
    continuation: options.continuation,
    warnings: options.warnings,
  };
}

export function bounded(value: string, maximum = 2_000): string {
  const normalized = value.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return normalized.slice(0, maximum) || 'No description was returned.';
}

export function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

export function youtubeVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
