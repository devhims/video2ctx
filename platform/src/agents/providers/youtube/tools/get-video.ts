import type { AgentVideo } from '../provider';
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
    description: 'Read metadata for exactly one YouTube video, including views, likes and comment totals when current statistics are requested. Includes observed caption availability and languages without downloading transcript text. Unknown means caption checks were inconclusive. This does not fetch comments or endscreen elements.',
    inputSchema: getVideoInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideo(input, context, toolCallId),
  });
}

export async function executeGetVideo(input: GetVideoInput, context: AgentToolContext, toolCallId: string) {
  const parsed = getVideoInputSchema.parse(input);
  const packet = await executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_video',
    operation: 'video',
    semanticInput: parsed,
    load: () => context.provider.video(parsed.videoId),
    credits: meteredCredits('video'),
    packet: (video) => singleVideoPacket(video, toolCallId),
  });
  const data = packet.artifacts.find(item => item.type === 'youtube_video_metadata')?.data;
  const captions = z.object({ status: z.literal('unavailable'), checkedAt: z.string().datetime() }).safeParse(data?.captionAvailability);
  if (captions.success && Date.now() - Date.parse(captions.data.checkedAt) >= 0
    && Date.now() - Date.parse(captions.data.checkedAt) < 300_000) context.transcriptSelection?.unavailable.add(parsed.videoId);
  const region = z.object({
    availability: z.object({ status: z.literal('UNPLAYABLE'), reason: z.string() }),
    metadataFetchedAt: z.string().datetime(),
  }).safeParse(data);
  if (region.success && /(?:not made (?:this |the )?video available in your country|not available in your country|blocked .*in your country)/i.test(region.data.availability.reason)) {
    const age = Date.now() - Date.parse(region.data.metadataFetchedAt);
    if (age >= 0 && age < 300_000 && context.transcriptSelection)
      (context.transcriptSelection.regionRestricted ??= new Set()).add(parsed.videoId);
  }
  return packet;
}

function singleVideoPacket(video: AgentVideo, toolCallId: string): Omit<EvidencePacket, 'packetId' | 'usage'> {
  const sourceId = `youtube:video:${safeIdPart(video.id)}`;
  const observedCaptions = video.captionAvailability;
  const age = observedCaptions ? Date.now() - Date.parse(observedCaptions.checkedAt) : Infinity;
  const captionAvailability = observedCaptions && age >= 0 && age < 300_000
    ? observedCaptions : { status: 'unknown' as const, languages: [] as string[], ...(observedCaptions ? { checkedAt: observedCaptions.checkedAt } : {}) };

  const freshness = z.object({
    state: z.enum(['fresh', 'stored', 'stale']), fetchedAt: z.number().finite(), reason: z.string().optional(),
  }).optional().safeParse('freshness' in video ? video.freshness : undefined);
  const observation = freshness.success ? freshness.data : undefined;
  const fetchedAt = observationTime(observation?.fetchedAt);
  const statisticsAt = observationTime(video.signals?.freshness?.fetchedAt);
  const viewCount = video.signals?.viewCount ?? video.viewCount;
  const savedWarning = observation?.state === 'stored' ? [{
    code: 'SAVED_VIDEO_METADATA',
    message: `These values were saved${fetchedAt ? ` at ${fetchedAt}` : ''}. Do not describe changing counts as current without a fresh lookup.`,
  }] : [];
  const staleWarning = observation?.state === 'stale' ? [{
    code: 'STALE_VIDEO_METADATA',
    message: `The metadata refresh failed. These are previously observed values${fetchedAt ? ` from ${fetchedAt}` : ''}; state their age and do not describe them as current.`,
  }] : [];
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
        viewCount !== undefined ? `Views: ${viewCount}` : video.viewCountText ? `Views: ${video.viewCountText}` : undefined,
        video.signals?.likeCount !== undefined ? `Likes: ${video.signals.likeCount}` : undefined,
        video.signals?.commentCount !== undefined ? `Comment count: ${video.signals.commentCount}` : undefined,
        statisticsAt ? `Statistics fetched at: ${statisticsAt}` : undefined,
        fetchedAt ? `Metadata fetched at: ${fetchedAt}${observation?.state === 'stale' ? ' (stale; refresh failed)' : ''}` : undefined,
        video.publishedTimeText ? `Published: ${video.publishedTimeText}` : undefined,
        video.durationText ? `Duration: ${video.durationText}` : undefined,
        `Availability: ${video.availability.status}`,
        `Caption availability: ${captionAvailability.status}. Languages: ${captionAvailability.languages.join(', ') || 'none observed'}. Checked at: ${captionAvailability.checkedAt ?? 'not checked'}. Skip transcript retrieval only when unavailable is confirmed and recent.`,
        video.description,
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
        viewCount: video.signals?.viewCount ?? video.viewCount,
        ...(video.signals ? { signals: video.signals } : {}),
        isLive: video.isLive,
        hasCaptions: video.hasCaptions,
        captionAvailability,
        keywords: video.keywords.slice(0, 40),
        availability: video.availability,
        metadataFetchedAt: video.meta.fetchedAt,
        ...(observation ? { freshness: observation } : {}),
      },
    }],
    warnings: [...savedWarning, ...providerWarnings(
      video.meta,
      'PARTIAL_VIDEO_METADATA',
      'YouTube returned partial video metadata.',
    ), ...providerWarnings(video.signals?.meta, 'PARTIAL_VIDEO_SIGNALS', 'Some current statistics are unavailable.'), ...staleWarning],
  };
}

function observationTime(value: unknown): string | undefined {
  if (typeof value !== 'number') return;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
