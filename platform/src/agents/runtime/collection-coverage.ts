import { z } from 'zod';
import type { EvidencePacket } from '../contracts';

/** Entries one provider list tool keeps per page. Shared by every list tool and by user-facing disclosures. */
export const COLLECTION_ITEM_LIMIT = 12;

/**
 * Entry-list packets: one excerpt and one source per listed entry. Comments,
 * transcripts and visual packets have their own projections and are excluded.
 */
export const COLLECTION_ARTIFACT_TYPES = {
  youtube_playlist: 'youtube_playlist',
  youtube_search: 'youtube_search_candidates',
  youtube_browse: 'youtube_browse_candidates',
  youtube_channel_videos: 'youtube_channel_videos',
  youtube_channel_playlists: 'youtube_channel_playlists',
} as const satisfies Partial<Record<EvidencePacket['kind'], string>>;

export type CollectionKind = keyof typeof COLLECTION_ARTIFACT_TYPES;

export function isCollectionKind(kind: string): kind is CollectionKind {
  return Object.hasOwn(COLLECTION_ARTIFACT_TYPES, kind);
}

/**
 * Recorded by the provider tool at retrieval time. Packets saved before this
 * existed carry none of it, and their page size must stay unknown.
 */
export const collectionRetrievalSchema = z.object({
  version: z.literal(1),
  /** Entries on the provider page before agent filtering or the item cap. */
  fetchedCount: z.number().int().nonnegative(),
  /** Entries removed by an agent policy before the cap, such as the duration limit. */
  excludedCount: z.number().int().nonnegative().optional(),
  /** Entries kept in the packet. Equal to the packet excerpt count. */
  retainedCount: z.number().int().nonnegative(),
  /** Total stated by the provider header. Absent when the provider did not state one. */
  reportedTotal: z.number().int().nonnegative().optional(),
  reportedTotalText: z.string().max(200).optional(),
  /** Whether the provider returned a token for a further page. */
  morePages: z.boolean(),
  /** Whether the producing tool accepts that token. get_playlist does not. */
  continuationAccepted: z.boolean(),
});

export type CollectionRetrieval = z.infer<typeof collectionRetrievalSchema>;

export function collectionRetrieval(options: {
  fetchedCount: number;
  excludedCount?: number;
  retainedCount: number;
  reportedTotal?: number;
  reportedTotalText?: string;
  continuation?: string;
  continuationAccepted: boolean;
}): CollectionRetrieval {
  return {
    version: 1,
    fetchedCount: options.fetchedCount,
    ...(options.excludedCount ? { excludedCount: options.excludedCount } : {}),
    retainedCount: options.retainedCount,
    ...(options.reportedTotal !== undefined ? { reportedTotal: options.reportedTotal } : {}),
    ...(options.reportedTotalText ? { reportedTotalText: options.reportedTotalText.slice(0, 200) } : {}),
    morePages: !!options.continuation,
    continuationAccepted: options.continuationAccepted,
  };
}

/** Model-facing counts. Recomputed for every shown-entry count tried under a budget. */
export const modelCollectionSchema = z.object({
  entriesShown: z.number().int().nonnegative(),
  entriesRetained: z.number().int().nonnegative(),
  retainedEntriesNotShown: z.number().int().nonnegative(),
  entriesFetched: z.number().int().nonnegative().optional(),
  entriesExcluded: z.number().int().nonnegative().optional(),
  entriesNotRetained: z.number().int().nonnegative().optional(),
  reportedTotal: z.number().int().nonnegative().optional(),
  reportedTotalText: z.string().max(200).optional(),
  morePages: z.boolean().optional(),
  coverage: z.string().min(1).max(1_500),
});

export type ModelCollection = z.infer<typeof modelCollectionSchema>;

export function readCollectionRetrieval(packet: Pick<EvidencePacket, 'kind' | 'artifacts'>): CollectionRetrieval | undefined {
  if (!isCollectionKind(packet.kind)) return undefined;
  const type = COLLECTION_ARTIFACT_TYPES[packet.kind];
  const artifact = packet.artifacts.find(candidate => candidate.type === type);
  const parsed = collectionRetrievalSchema.safeParse(artifact?.data.collection);
  return parsed.success ? parsed.data : undefined;
}

/**
 * States exactly what the model can see. Counts that were not recorded stay
 * unknown, and a further-page token is never described as reaching entries
 * that the cap dropped from the current page.
 */
export function modelCollection(options: {
  shown: number;
  retained: number;
  retrieval?: CollectionRetrieval;
  continuationShown: boolean;
}): ModelCollection {
  const { shown, retained, retrieval } = options;
  const notShown = Math.max(0, retained - shown);
  // Trust recorded counts only when they describe this packet.
  const recorded = retrieval && retrieval.retainedCount === retained ? retrieval : undefined;
  const excluded = recorded?.excludedCount ?? 0;
  const notRetained = recorded ? Math.max(0, recorded.fetchedCount - excluded - retained) : undefined;
  const sentences: string[] = [];

  if (shown === retained) {
    sentences.push(retained === 0
      ? 'This packet retained no entries.'
      : `All ${retained} ${plural(retained, 'entry', 'entries')} retained in this packet are shown.`);
  } else if (shown === 0) {
    sentences.push(`None of the ${retained} retained ${plural(retained, 'entry', 'entries')} fit this context. They are saved but not shown, so do not describe their contents or call them unavailable from the source.`);
  } else {
    sentences.push(`Only entries 1 to ${shown} of the ${retained} retained in this packet fit this context. The other ${notShown} ${plural(notShown, 'is', 'are')} saved but not shown, so do not describe their contents or call them unavailable from the source.`);
  }

  if (!recorded) {
    sentences.push('The provider page size before the agent item limit was not recorded for this packet, so it is unknown whether the page had more entries.');
  } else {
    const parts = [`The provider page had ${recorded.fetchedCount} ${plural(recorded.fetchedCount, 'entry', 'entries')}.`];
    if (excluded) parts.push(`${excluded} ${plural(excluded, 'was', 'were')} excluded by agent policy.`);
    if (notRetained) parts.push(`${notRetained} more ${plural(notRetained, 'was', 'were')} not retained because of the agent item limit and ${plural(notRetained, 'is', 'are')} not available in this evidence.`);
    sentences.push(parts.join(' '));
  }

  if (recorded?.reportedTotal !== undefined) {
    sentences.push(`The provider stated a total of ${recorded.reportedTotal}${recorded.reportedTotalText ? ` ("${recorded.reportedTotalText}")` : ''}.`);
  } else if (recorded?.reportedTotalText) {
    sentences.push(`The provider stated "${recorded.reportedTotalText}" without a parseable total.`);
  } else {
    sentences.push('No provider-stated total is available; do not infer one from these counts.');
  }

  if (recorded?.morePages) {
    const gap = notRetained ? ` It would not return the ${notRetained} unretained ${plural(notRetained, 'entry', 'entries')} from this page.` : '';
    sentences.push(recorded.continuationAccepted
      ? `The provider reported a further page. Its continuation resumes after the whole fetched page.${gap}${options.continuationShown ? '' : ' The continuation token is not included in this context.'}`
      : `The provider reported a further page, but the tool that produced this packet cannot read further pages.${gap}`);
  } else if (recorded) {
    sentences.push('The provider reported no further page.');
  }

  return modelCollectionSchema.parse({
    entriesShown: shown,
    entriesRetained: retained,
    retainedEntriesNotShown: notShown,
    ...(recorded ? {
      entriesFetched: recorded.fetchedCount,
      ...(excluded ? { entriesExcluded: excluded } : {}),
      entriesNotRetained: notRetained,
      ...(recorded.reportedTotal !== undefined ? { reportedTotal: recorded.reportedTotal } : {}),
      ...(recorded.reportedTotalText ? { reportedTotalText: recorded.reportedTotalText } : {}),
      morePages: recorded.morePages,
    } : {}),
    coverage: sentences.join(' ').slice(0, 1_500),
  });
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
