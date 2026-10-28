import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema, type EvidencePacket } from '../contracts';
import type { SessionEvidenceStore } from './session-evidence';
import { savedOriginalQueryWords } from './saved-original-index';
import { sha256 } from '../../lib/http';

import { SAVED_EVIDENCE_ARTIFACT } from './saved-evidence-contract';
export { SAVED_EVIDENCE_ARTIFACT, SAVED_EVIDENCE_READ_LIMIT } from './saved-evidence-contract';
export const readSavedEvidenceInputSchema = z.object({
  assetVersion: z.string().min(1).max(200).describe('Exact version from the session asset inventory. Older saved versions may be read explicitly.'),
  query: z.string().trim().min(1).max(200).optional().describe('Every word must occur in the same comment or within three consecutive captions. Words match by stem, so mixing finds mix, but there are no semantic synonyms. Start with one distinctive word from the requested wording; do not combine unrelated clues. Omit to page through the asset.'),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().max(1_000_000).default(0)
    .describe('Zero-based position in the selected excerpts. Continue with nextOffset and the same filters.'),
  limit: z.number().int().min(1).max(30).default(30),
}).refine(input => input.startMs === undefined || input.endMs === undefined || input.endMs >= input.startMs,
  { message: 'endMs must be at least startMs.', path: ['endMs'] });

/** Only storage/shape failures for an owned original are terminal; tool-input errors are not. */
class SavedOriginalUnavailableError extends Error {}

/** Reads only session-owned originals from the session's SQLite segment index. There is deliberately no provider dependency. */
export async function readSavedEvidence(store: SessionEvidenceStore, input: z.input<typeof readSavedEvidenceInputSchema>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const request = readSavedEvidenceInputSchema.parse(input);
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
  const sourceId = `youtube:${asset.videoId}:${asset.kind}`;
  const nextOffset = request.offset + page.length < matching ? request.offset + page.length : undefined;
  const coverage = { assetVersion: asset.version, kind: asset.kind, totalExcerpts: index.total,
    selectedExcerpts: matching, offset: request.offset, returnedExcerpts: page.length,
    ...(index.meta.partial !== undefined ? { sourcePartial: index.meta.partial } : {}),
    ...(asset.kind === 'comments' ? { sourceContinuationAvailable: Boolean(index.meta.continuation) } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}) };
  const packet = evidencePacketSchema.parse({
    packetId: `session:original:${asset.version}:${await sha256(JSON.stringify(request))}`,
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
  // Hashing yields. Recheck ownership before publishing a packet after concurrent deletion.
  signal?.throwIfAborted();
  if (store.generation() !== generation || !store.has(asset.version)) throw new Error('Saved asset was deleted during the read.');
  store.savePacket(packet);
  return { packets: [packet], coverage };
}

export function createReadSavedEvidenceTool(store: SessionEvidenceStore,
  admit: (packets: EvidencePacket[], source?: 'search_context' | 'read_saved_evidence') => EvidencePacket[] | void, signal: AbortSignal, runId: string = crypto.randomUUID()) {
  return tool({
    description: 'Read or search original SAVED captions/comments by assetVersion. Use for exact quotations, precise passage times, corrections, and comments omitted from summaries. Returns original text with immutable citations; never calls YouTube or an analyst. Query captions with a few distinctive words, then read adjacent times if needed. Page with nextOffset and the same filters. A filtered page does not establish absence from the whole asset.',
    inputSchema: readSavedEvidenceInputSchema,
    execute: async input => {
      signal.throwIfAborted();
      const remainingReads = store.reserveSavedEvidenceRead(runId);
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
}
