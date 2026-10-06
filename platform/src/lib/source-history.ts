import { z } from 'zod';
import { sha256 } from './http';

export const RECENT_SOURCE_LIMIT = 30;
export const MAX_SOURCE_SNAPSHOT_BYTES = 16_000;
export const sourceIdSchema = z.string().uuid();
const dataset = z.enum(['transcript', 'comments', 'channel']);
const metadata = z.object({ source: z.string(), fetchedAt: z.string(), partial: z.boolean(), warnings: z.array(z.string()) }).passthrough();
const thumbnails = z.array(z.object({ url: z.string(), width: z.number().optional(), height: z.number().optional() }));
const record = z.record(z.string(), z.unknown());
const inspector = z.object({
  provider: z.literal('youtube'), type: z.enum(['video', 'playlist', 'channel']), id: z.string().min(1).max(200),
  data: record, requestedData: z.array(dataset),
  dataErrors: z.partialRecord(z.enum(['metadata', 'transcript', 'comments', 'channel']), z.string()),
  refreshData: z.array(z.enum(['metadata', 'transcript', 'comments', 'channel'])).optional(),
  transcript: z.object({
    videoId: z.string(), text: z.string(), granularity: z.enum(['segment', 'word']).optional(), meta: metadata,
    track: z.object({ name: z.string(), kind: z.string(), languageCode: z.string() }).passthrough(),
    segments: z.array(z.object({ text: z.string(), startMs: z.number(), endMs: z.number(), durationMs: z.number() }).passthrough()),
  }).passthrough().optional(),
  comments: z.object({ videoId: z.string(), comments: z.array(record), meta: metadata,
    totalCount: z.number().optional(), continuation: z.string().optional() }).passthrough().optional(),
  channel: z.object({ id: z.string(), name: z.string(), thumbnails, url: z.string(), meta: metadata,
    about: z.object({ description: z.string().optional(), links: z.array(z.object({ title: z.string(), displayUrl: z.string(), url: z.string() })),
      moreInfo: record }) }).passthrough().optional(),
});

export const sourceSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), selectedData: z.array(dataset).min(1), items: z.array(z.object({
    provider: z.literal('youtube').optional(), type: z.literal('video'), id: z.string(), thumbnails,
    title: z.string().optional(), name: z.string().optional(), description: z.string().optional(),
    channel: z.object({ id: z.string(), name: z.string() }).optional(),
    durationText: z.string().optional(), viewCountText: z.string().optional(), publishedTimeText: z.string().optional(),
    isLive: z.boolean().optional(), videoCountText: z.string().optional(),
  })) }),
  z.object({ kind: z.literal('inspection'), inspector }),
]);
export const saveSourceSchema = z.object({ projectId: z.string().uuid().optional(), input: z.string().trim().min(1).max(500), snapshot: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), selectedData: z.array(dataset).min(1) }),
  z.object({ kind: z.literal('inspection'), inspector: inspector.pick({ provider: true, type: true, id: true, requestedData: true, dataErrors: true })
    .extend({ loadedData: z.array(z.enum(['metadata', 'transcript', 'comments', 'channel'])) }) }),
]) });
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type SaveSourceInput = z.infer<typeof saveSourceSchema>;
const assetReference = z.object({ videoId: z.string(), kind: z.string(), variant: z.string(), contentHash: z.string() });
const sharedReference = z.string().regex(/^youtube\/source-history\/[a-f0-9]{64}\.json$/);
export const sourceReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), selectedData: z.array(dataset), results: sharedReference }),
  z.object({ kind: z.literal('inspection'), inspector: z.object({
    provider: z.literal('youtube'), type: z.enum(['video', 'playlist', 'channel']), id: z.string(),
    requestedData: z.array(dataset), dataErrors: inspector.shape.dataErrors,
    assets: z.partialRecord(z.enum(['metadata', 'transcript', 'comments']), assetReference),
    entity: sharedReference.optional(), channel: sharedReference.optional(),
    thumbnailUrl: z.string().url().optional(),
  }) }),
]);
export const saveReferencedSourceSchema = z.object({ input: z.string().trim().min(1).max(500), title: z.string().max(300), snapshot: sourceReferenceSchema });
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SaveReferencedSource = z.infer<typeof saveReferencedSourceSchema>;
export interface RecentSource {
  id: string; input: string; title: string; kind: SourceSnapshot['kind']; updatedAt: number; thumbnailUrl?: string;
}

export const sourceRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Canonical identity of one saved reference set: selected assets, dataset choices,
 * errors and shared copies. Parsing gives a stable key order. The thumbnail URL is
 * a cosmetic cache that the history list may add later, so it is not part of it.
 */
export function sourceRevisionPayload(snapshot: SourceReference): string {
  const parsed = sourceReferenceSchema.parse(snapshot);
  if (parsed.kind === 'inspection') delete parsed.inspector.thumbnailUrl;
  return JSON.stringify(parsed);
}

/** Fingerprint of one immutable reference set; see sourceRevisionPayload. */
export function sourceRevision(snapshot: SourceReference): Promise<string> {
  return sha256(sourceRevisionPayload(snapshot));
}

export function sourceIdentity(input: SaveReferencedSource): string {
  return input.snapshot.kind === 'search'
    ? `search:${input.input.replace(/\s+/g, ' ').toLowerCase()}`
    : `${input.snapshot.inspector.provider}:${input.snapshot.inspector.type}:${input.snapshot.inspector.id}`;
}
