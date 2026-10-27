import { tool } from 'ai';
import { z } from 'zod';
import type { Comment, CommentsPage, Transcript } from 'all-things-youtube';
import { evidencePacketSchema, type EvidencePacket } from '../contracts';
import { completeTranscriptEvidence } from '../providers/youtube/tools/get-video-transcript';
import type { SessionEvidenceStore } from './session-evidence';
import { VideoTooLongError } from './video-duration-limit';
import { sha256 } from '../../lib/http';

import { SAVED_EVIDENCE_ARTIFACT } from './saved-evidence-contract';
export { SAVED_EVIDENCE_ARTIFACT, SAVED_EVIDENCE_READ_LIMIT } from './saved-evidence-contract';
export const readSavedEvidenceInputSchema = z.object({
  assetVersion: z.string().min(1).max(200).describe('Exact version from the session asset inventory. Older saved versions may be read explicitly.'),
  query: z.string().trim().min(1).max(200).optional().describe('Every word must occur literally in the same comment or nearby captions. No stemming or semantic synonyms. Start with one distinctive word copied from the requested wording; do not combine unrelated clues. Omit to page through the asset.'),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().max(1_000_000).default(0)
    .describe('Zero-based position in the selected excerpts. Continue with nextOffset and the same filters.'),
  limit: z.number().int().min(1).max(30).default(30),
}).refine(input => input.startMs === undefined || input.endMs === undefined || input.endMs >= input.startMs,
  { message: 'endMs must be at least startMs.', path: ['endMs'] });

/** Only storage/shape failures for an owned original are terminal; tool-input errors are not. */
class SavedOriginalUnavailableError extends Error {}
const captionShape = z.object({ segments: z.array(z.object({
  text: z.string(), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(),
})) });
const commentShape = z.object({ id: z.string(), text: z.string(), author: z.object({ name: z.string() }),
  get replies() { return z.array(commentShape).optional(); },
});
const commentsShape = z.object({ comments: z.array(commentShape) });

/** Reads only session-owned originals. There is deliberately no provider dependency. */
export async function readSavedEvidence(store: SessionEvidenceStore, input: z.input<typeof readSavedEvidenceInputSchema>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const request = readSavedEvidenceInputSchema.parse(input);
  const tokens = request.query ? searchWords(request.query) : undefined;
  if (request.query && !tokens?.length) throw new Error('Use at least one word in the saved-evidence query.');
  const generation = store.generation();
  let saved;
  try { saved = await store.readAsset(request.assetVersion); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof VideoTooLongError)
      throw new SavedOriginalUnavailableError(error instanceof VideoTooLongError ? error.message : 'Saved source data could not be decoded.');
    throw error;
  }
  if (!saved) throw new SavedOriginalUnavailableError('Saved asset is unavailable or deleted. No fresh retrieval was attempted.');
  const { asset, value } = saved;
  if (asset.kind !== 'transcript' && asset.kind !== 'comments')
    throw new Error('Only original saved captions and comments can be read with this tool.');
  if (asset.kind === 'comments' && (request.startMs !== undefined || request.endMs !== undefined))
    throw new Error('Timestamp filters apply to captions, not comments.');
  if (!(asset.kind === 'transcript' ? captionShape : commentsShape).safeParse(value).success)
    throw new SavedOriginalUnavailableError('Saved source data has an unreadable caption or comment structure.');
  const sourceId = `youtube:${asset.videoId}:${asset.kind}`;
  const comments = asset.kind === 'comments' ? flattenComments((value as CommentsPage).comments) : [];
  const commentSearchTexts: string[] = [];
  const excerpts: EvidencePacket['excerpts'] = asset.kind === 'transcript'
    ? completeTranscriptEvidence(asset.videoId, (value as Transcript).segments, sourceId).excerpts
      .map((excerpt, index) => ({ ...excerpt, id: `saved:${asset.version}:caption:${index}` }))
    : comments.flatMap(({ comment, position }) => {
      // Split long comments without discarding their tail or changing their words.
      const text = comment.text;
      const suffix = `\nAuthor: ${comment.author.name.slice(0, 200)}\nComment ID: ${comment.id.slice(0, 200)}\nSaved position: ${position.map(index => index + 1).join('.')}`;
      const searchText = `${text} ${comment.author.name}`;
      const chunks: EvidencePacket['excerpts'] = [];
      for (let offset = 0; offset < text.length; offset += 1500) {
        commentSearchTexts.push(searchText);
        chunks.push({ id: `saved:${asset.version}:comment:${position.join(':')}:${offset / 1500}`, sourceId,
          text: text.slice(offset, offset + 1500) + suffix });
      }
      return chunks;
    });
  const selected = new Set<number>();
  for (let index = 0; index < excerpts.length; index++) {
    const excerpt = excerpts[index]!;
    if (request.startMs !== undefined && (excerpt.endMs ?? excerpt.startMs ?? 0) < request.startMs) continue;
    if (request.endMs !== undefined && (excerpt.startMs ?? 0) > request.endMs) continue;
    // Captions can split a phrase across consecutive segments. Comments never mix authors.
    const text = asset.kind === 'comments' ? commentSearchTexts[index]!
      : excerpts.slice(index, index + 3).map(item => item.text).join(' ').toLowerCase();
    const words = tokens ? new Set(searchWords(text)) : undefined;
    if (tokens && !tokens.every(token => words!.has(token))) continue;
    const radius = tokens && asset.kind === 'transcript' ? 2 : 0;
    for (let neighbor = Math.max(0, index - radius); neighbor <= Math.min(excerpts.length - 1, index + radius); neighbor++) selected.add(neighbor);
  }
  const matching = [...selected].sort((a, b) => a - b).map(index => excerpts[index]!);
  const page: EvidencePacket['excerpts'] = [];
  let characters = 0;
  for (const excerpt of matching.slice(request.offset, request.offset + request.limit)) {
    const size = JSON.stringify(excerpt).length;
    if (characters + size > 12_000) break;
    page.push(excerpt);
    characters += size;
  }
  const nextOffset = request.offset + page.length < matching.length ? request.offset + page.length : undefined;
  const sourceMeta = (value as Transcript | CommentsPage).meta;
  const coverage = { assetVersion: asset.version, kind: asset.kind, totalExcerpts: excerpts.length,
    selectedExcerpts: matching.length, offset: request.offset, returnedExcerpts: page.length,
    ...(sourceMeta?.partial !== undefined ? { sourcePartial: sourceMeta.partial } : {}),
    ...(asset.kind === 'comments' ? { sourceContinuationAvailable: Boolean((value as CommentsPage).continuation) } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}) };
  const packet = evidencePacketSchema.parse({
    packetId: `session:original:${asset.version}:${await sha256(JSON.stringify(request))}`,
    kind: asset.kind === 'transcript' ? 'youtube_transcript' : 'youtube_comments', assetVersions: [asset.version],
    sources: [{ id: sourceId, provider: 'youtube', kind: asset.kind, videoId: asset.videoId,
      url: `https://www.youtube.com/watch?v=${asset.videoId}` }], excerpts: page,
    artifacts: [{ type: SAVED_EVIDENCE_ARTIFACT, data: coverage }], usage: [],
    warnings: [
      ...(sourceMeta?.warnings ?? []).map(message => ({ code: 'YOUTUBE_PROVIDER_WARNING', message, videoId: asset.videoId })),
      ...(sourceMeta?.partial ? [{ code: 'PARTIAL_SAVED_SOURCE', message: 'The saved source was partial when collected.', videoId: asset.videoId }] : []),
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
        ...(input.query && result.coverage.selectedExcerpts === 0 ? { searchHint: 'No literal match for all query words together. Retry with one distinctive word from the requested wording, without changing its spelling, or page the original. This does not establish that the requested information is absent.' } : {}),
        ...(packets.length < result.packets.length ? { withheld: true, note: 'Saved passages were not admitted to this run. Do not claim to have read them.' } : {}) };
    },
  });
}

function flattenComments(comments: Comment[]) {
  const pending = comments.map((comment, index) => ({ comment, position: [index] })).reverse();
  const entries: typeof pending = [];
  while (pending.length) {
    const entry = pending.pop()!;
    entries.push(entry);
    for (let index = (entry.comment.replies?.length ?? 0) - 1; index >= 0; index--) {
      pending.push({ comment: entry.comment.replies[index]!, position: [...entry.position, index] });
    }
  }
  return entries;
}

/** Treat contractions as words and normalize typographic apostrophes consistently. */
function searchWords(text: string): string[] {
  return text.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}_]+(?:'[\p{L}\p{N}_]+)*/gu) ?? [];
}
