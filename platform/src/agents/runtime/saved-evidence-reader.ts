import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema, type EvidencePacket } from '../contracts';
import type { SessionAsset, SessionEvidenceStore } from './session-evidence';
import { savedOriginalQueryWords, type SavedOriginalIndexState } from './saved-original-index';
import { sha256 } from '../../lib/http';

import { SAVED_EVIDENCE_ARTIFACT } from './saved-evidence-contract';
export { SAVED_EVIDENCE_ARTIFACT, SAVED_EVIDENCE_READ_LIMIT } from './saved-evidence-contract';
/** A search across all saved originals returns a short, bounded list; page into a source by its version. */
const ALL_SOURCES_LIMIT = 6;
const ALL_SOURCES_EXCERPTS = 5;
const ALL_SOURCES_CHARACTERS = 8_000;

export const readSavedEvidenceInputSchema = z.object({
  assetVersion: z.string().min(1).max(200).optional().describe('Exact version from the session asset inventory. Older saved versions may be read explicitly. Omit, with a query, to search every saved caption and comment page in the session.'),
  query: z.string().trim().min(1).max(200).optional().describe('Every word must occur in the same comment or within three consecutive captions. Words match by stem, so mixing finds mix, but there are no semantic synonyms. Start with one distinctive word from the requested wording; do not combine unrelated clues. Omit to page through one asset.'),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().max(1_000_000).default(0)
    .describe('Zero-based position in the selected excerpts of one asset. Continue with nextOffset, the same assetVersion and the same filters.'),
  limit: z.number().int().min(1).max(30).default(30),
}).refine(input => input.startMs === undefined || input.endMs === undefined || input.endMs >= input.startMs,
  { message: 'endMs must be at least startMs.', path: ['endMs'] })
  .refine(input => input.assetVersion !== undefined || input.query !== undefined,
    { message: 'Provide assetVersion to read one saved original, or a query to search all of them.', path: ['query'] })
  .refine(input => input.assetVersion !== undefined || (input.startMs === undefined && input.endMs === undefined && input.offset === 0),
    { message: 'Time filters and offsets apply to one asset. Add the assetVersion returned by the search.', path: ['assetVersion'] });
type ReadSavedEvidenceRequest = z.output<typeof readSavedEvidenceInputSchema>;
type ReadyIndex = Extract<SavedOriginalIndexState, { status: 'ready' }>;
type OriginalAsset = SessionAsset & { kind: 'transcript' | 'comments' };

/** Only storage/shape failures for an owned original are terminal; tool-input errors are not. */
class SavedOriginalUnavailableError extends Error {}

/** Reads one session-owned original from the session's SQLite segment index. There is deliberately no provider dependency. */
export async function readSavedEvidence(store: SessionEvidenceStore, input: z.input<typeof readSavedEvidenceInputSchema>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const request = readSavedEvidenceInputSchema.parse(input);
  if (request.assetVersion === undefined) throw new Error('readSavedEvidence reads one asset. Use searchSavedEvidence to search all saved originals.');
  const words = request.query ? savedOriginalQueryWords(request.query) : undefined;
  if (request.query && !words?.length) throw new Error('Use at least one word in the saved-evidence query.');
  const generation = store.generation();
  const asset = store.brief().assets.find(candidate => candidate.version === request.assetVersion);
  if (!asset) throw new SavedOriginalUnavailableError('Saved asset is unavailable or deleted. No fresh retrieval was attempted.');
  if (asset.kind !== 'transcript' && asset.kind !== 'comments')
    throw new Error('Only original saved captions and comments can be read with this tool.');
  if (asset.kind === 'comments' && (request.startMs !== undefined || request.endMs !== undefined))
    throw new Error('Timestamp filters apply to captions, not comments.');
  const tooLong = store.transcriptOverLimit(asset.version);
  if (tooLong) throw new SavedOriginalUnavailableError(tooLong.message);
  let index;
  try { index = await store.savedOriginalIndex(asset.version); }
  catch (error) {
    if (error instanceof SyntaxError) throw new SavedOriginalUnavailableError('Saved source data could not be decoded.');
    throw error;
  }
  if (!index) throw new SavedOriginalUnavailableError('Saved asset is unavailable or deleted. No fresh retrieval was attempted.');
  if (index.status === 'unreadable') throw new SavedOriginalUnavailableError(index.reason);
  const { matching, page } = store.searchSavedOriginal(asset.version, index.total, { kind: asset.kind, words,
    startMs: request.startMs, endMs: request.endMs, offset: request.offset, limit: request.limit });
  const packet = await originalPacket(asset as OriginalAsset, index, page, matching, request.offset, request);
  // Hashing yields. Recheck ownership before publishing a packet after concurrent deletion.
  signal?.throwIfAborted();
  if (store.generation() !== generation || !store.has(asset.version)) throw new Error('Saved asset was deleted during the read.');
  store.savePacket(packet);
  return { packets: [packet], coverage: savedCoverage(packet) };
}

/**
 * Search every saved caption and comment page in the session. Returns a bounded first page per
 * matching source, current versions first; each packet carries the coverage needed to page further.
 */
export async function searchSavedEvidence(store: SessionEvidenceStore, input: z.input<typeof readSavedEvidenceInputSchema>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const request = readSavedEvidenceInputSchema.parse(input);
  const words = savedOriginalQueryWords(request.query ?? '');
  if (!words.length) throw new Error('Use at least one word in the saved-evidence query.');
  // Assets saved before the index existed are indexed here once; later searches use SQLite only.
  const unavailable = await store.ensureSavedOriginalsIndexed();
  signal?.throwIfAborted();
  const generation = store.generation();
  const candidates = new Set(store.savedOriginalVersionsMatching(words));
  const originals = store.brief().assets.filter((asset): asset is OriginalAsset => asset.kind === 'transcript' || asset.kind === 'comments');
  const overLimit = originals.filter(asset => store.transcriptOverLimit(asset.version)).length;
  const matches: Array<{ asset: OriginalAsset; index: ReadyIndex; matching: number; page: EvidencePacket['excerpts'] }> = [];
  for (const asset of originals) {
    if (!candidates.has(asset.version) || store.transcriptOverLimit(asset.version)) continue;
    const index = await store.savedOriginalIndex(asset.version);
    if (index?.status !== 'ready') continue;
    const found = store.searchSavedOriginal(asset.version, index.total, { kind: asset.kind, words, offset: 0, limit: ALL_SOURCES_EXCERPTS });
    if (found.matching) matches.push({ asset, index, ...found });
  }
  matches.sort((a, b) => Number(b.asset.current) - Number(a.asset.current) || b.matching - a.matching);
  const packets: EvidencePacket[] = [];
  let characters = 0;
  for (const match of matches.slice(0, ALL_SOURCES_LIMIT)) {
    const page: EvidencePacket['excerpts'] = [];
    for (const excerpt of match.page) {
      const size = JSON.stringify(excerpt).length;
      if (characters + size > ALL_SOURCES_CHARACTERS) break;
      page.push(excerpt);
      characters += size;
    }
    if (!page.length) break;
    packets.push(await originalPacket(match.asset, match.index, page, match.matching, 0,
      { scope: 'all_saved_originals', assetVersion: match.asset.version, query: request.query, limit: page.length }));
  }
  signal?.throwIfAborted();
  if (store.generation() !== generation) throw new Error('Saved evidence changed during the search. Retry the search.');
  const published = packets.filter(packet => packet.assetVersions!.every(version => store.has(version)));
  for (const packet of published) store.savePacket(packet);
  return { packets: published, unavailable, search: { matchedSources: matches.length, returnedSources: published.length,
    ...(matches.length > published.length ? { omittedSources: matches.length - published.length } : {}),
    ...(unavailable.length ? { unavailableSources: unavailable.length } : {}),
    ...(overLimit ? { overLimitSources: overLimit } : {}) } };
}

async function originalPacket(asset: OriginalAsset, index: ReadyIndex, page: EvidencePacket['excerpts'], matching: number,
  offset: number, key: unknown): Promise<EvidencePacket> {
  const sourceId = `youtube:${asset.videoId}:${asset.kind}`;
  const nextOffset = offset + page.length < matching ? offset + page.length : undefined;
  const coverage = { assetVersion: asset.version, kind: asset.kind, totalExcerpts: index.total,
    selectedExcerpts: matching, offset, returnedExcerpts: page.length,
    ...(index.meta.partial !== undefined ? { sourcePartial: index.meta.partial } : {}),
    ...(asset.kind === 'comments' ? { sourceContinuationAvailable: Boolean(index.meta.continuation) } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}) };
  return evidencePacketSchema.parse({
    packetId: `session:original:${asset.version}:${await sha256(JSON.stringify(key))}`,
    kind: asset.kind === 'transcript' ? 'youtube_transcript' : 'youtube_comments', assetVersions: [asset.version],
    sources: [{ id: sourceId, provider: 'youtube', kind: asset.kind, videoId: asset.videoId,
      url: `https://www.youtube.com/watch?v=${asset.videoId}` }], excerpts: page,
    artifacts: [{ type: SAVED_EVIDENCE_ARTIFACT, data: coverage }], usage: [],
    warnings: [
      ...index.meta.warnings.map(message => ({ code: 'YOUTUBE_PROVIDER_WARNING', message, videoId: asset.videoId })),
      ...(index.meta.partial ? [{ code: 'PARTIAL_SAVED_SOURCE', message: 'The saved source was partial when collected.', videoId: asset.videoId }] : []),
      ...(asset.current ? [] : [{ code: 'SUPERSEDED_SESSION_EVIDENCE',
        message: 'These are original records from an older saved version, not fresh source data.', videoId: asset.videoId }]),
    ],
  });
}

function savedCoverage(packet: EvidencePacket) {
  return packet.artifacts[0]!.data as { assetVersion: string; kind: 'transcript' | 'comments'; totalExcerpts: number;
    selectedExcerpts: number; offset: number; returnedExcerpts: number; nextOffset?: number; sourcePartial?: boolean;
    sourceContinuationAvailable?: boolean };
}

export function createReadSavedEvidenceTool(store: SessionEvidenceStore,
  admit: (packets: EvidencePacket[], source?: 'search_context' | 'read_saved_evidence') => EvidencePacket[] | void, signal: AbortSignal, runId: string = crypto.randomUUID()) {
  return tool({
    description: 'Search or read original SAVED captions and comments: the exact words, with immutable citations and caption times. Use for quotations, precise passage times, corrections, and comments omitted from summaries. Omit assetVersion to search every saved caption and comment page; results give each source\'s assetVersion and nextOffset. Pass assetVersion to page one source, read a caption time range, or search inside it. Never calls YouTube or an analyst. A filtered page does not establish absence from the whole asset.',
    inputSchema: readSavedEvidenceInputSchema,
    execute: async input => {
      signal.throwIfAborted();
      const remainingReads = store.reserveSavedEvidenceRead(runId);
      if (input.assetVersion === undefined) return searchAll(input, remainingReads);
      const generation = store.generation();
      const asset = store.assetInfo(input.assetVersion);
      if (asset?.kind === 'comments' && (input.startMs !== undefined || input.endMs !== undefined))
        throw new Error('Timestamp filters apply to captions, not comments.');
      let result;
      try { result = await readSavedEvidence(store, input, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof SavedOriginalUnavailableError)
          || (asset?.kind !== 'transcript' && asset?.kind !== 'comments')
          || generation !== store.generation() || !store.has(input.assetVersion)) throw error;
        store.recordSavedEvidenceOutcome(runId, input.assetVersion, 'unavailable');
        return { packets: [], assetVersion: input.assetVersion, unavailable: true, remainingReads,
          note: `${error.message} The saved original was not read. Report this access gap; no fresh retrieval was attempted.` };
      }
      signal.throwIfAborted();
      const packets = admit(result.packets, 'read_saved_evidence') ?? result.packets;
      const outcome = result.coverage.totalExcerpts === 0 ? 'empty' : result.coverage.returnedExcerpts > 0 && packets.length < result.packets.length ? 'withheld' : undefined;
      if (outcome) store.recordSavedEvidenceOutcome(runId, input.assetVersion, outcome);
      return { packets, coverage: result.coverage, remainingReads,
        ...(input.query && result.coverage.selectedExcerpts === 0 ? { searchHint: 'No match for all query words together. Retry with one distinctive word from the requested wording, or page the original. This does not establish that the requested information is absent.' } : {}),
        ...(packets.length < result.packets.length ? { withheld: true, note: 'Saved passages were not admitted to this run. Do not claim to have read them.' } : {}) };
    },
  });

  async function searchAll(input: ReadSavedEvidenceRequest, remainingReads: number) {
    const result = await searchSavedEvidence(store, input, signal);
    signal.throwIfAborted();
    // A saved original that cannot be read is a permanent gap for this run, as with a direct read.
    for (const version of result.unavailable) store.recordSavedEvidenceOutcome(runId, version, 'unavailable');
    const packets = admit(result.packets, 'read_saved_evidence') ?? result.packets;
    const admitted = new Set(packets.map(packet => packet.packetId));
    for (const packet of result.packets) if (!admitted.has(packet.packetId)) store.recordSavedEvidenceOutcome(runId, packet.assetVersions![0]!, 'withheld');
    return { packets, search: result.search, remainingReads,
      ...(!result.packets.length ? { searchHint: 'No saved caption or comment matched all query words together. Retry with one distinctive word from the requested wording. This does not establish that the information is absent.' } : {}),
      ...(result.search.omittedSources ? { moreSources: 'More sources matched. Narrow the query or read a source by its assetVersion.' } : {}),
      ...(packets.length < result.packets.length ? { withheld: true, note: 'Some saved passages were not admitted to this run. Do not claim to have read them.' } : {}) };
  }
}
