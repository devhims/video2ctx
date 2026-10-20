import type { Comment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import { COMMENT_READ_LIMIT, collectionRetrieval } from '../../../runtime/collection-coverage';
import type { AgentToolContext } from '../tool-context';
import {
  continuationSchema,
  executeProviderEvidence,
  meteredCredits,
  providerWarnings,
  safeIdPart,
  videoIdSchema,
  youtubeVideoUrl,
} from './provider-evidence';

const COMMENT_EXCERPT_CHARACTERS = 2_000;
/** Context kept before a matched term, small enough that the match survives the smallest model text budget. */
const PASSAGE_LEAD_CHARACTERS = 40;

export const getVideoCommentsInputSchema = z.object({
  videoId: videoIdSchema,
  continuation: continuationSchema,
  /** Position within the saved provider page. Independent of the provider continuation. */
  offset: z.number().int().min(0).max(10_000).optional()
    .describe('Entry offset within the same saved provider page, returned as nextOffset. Omit for the first entries of a page.'),
  pageVersion: z.string().regex(/^[a-f0-9]{64}$/).optional()
    .describe('The pageVersion returned with nextOffset. Required with an offset, so later comments come from the same saved page.'),
});

export type GetVideoCommentsInput = z.infer<typeof getVideoCommentsInputSchema>;

export function createGetVideoCommentsTool(context: AgentToolContext) {
  return tool({
    description: `Read up to ${COMMENT_READ_LIMIT} comments for exactly one YouTube video, in YouTube's default ranking. A provider page can hold more comments than one read returns. When nextOffset is returned, pass it with the returned pageVersion and the same continuation to read the rest of that saved page without a new provider fetch. Pass the returned continuation only to fetch the next provider page, which starts after the whole current page.`,
    inputSchema: getVideoCommentsInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoComments(input, context, toolCallId),
  });
}

/** One comment page slice. Excerpt IDs keep the comment's position on its provider page. */
export function commentPageSlice<T>(comments: readonly T[], offset = 0, limit = COMMENT_READ_LIMIT) {
  const start = Math.max(0, Math.min(offset, comments.length));
  const page = comments.slice(start, start + limit);
  const next = start + page.length;
  return {
    page: page.map((comment, index) => ({ comment, position: start + index })),
    start,
    nextOffset: next < comments.length ? next : undefined,
  };
}

export function executeGetVideoComments(
  input: GetVideoCommentsInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = getVideoCommentsInputSchema.parse(input);
  if (parsed.offset && !parsed.pageVersion)
    throw new Error('Pass the pageVersion returned with nextOffset, so later comments come from the same saved page.');
  let savedVersion: string | undefined;
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_video_comments',
    operation: 'comments',
    // Offset 0 keeps the original reuse key, so first-page reads still deduplicate.
    semanticInput: { videoId: parsed.videoId, continuation: parsed.continuation,
      ...(parsed.offset ? { offset: parsed.offset } : {}), ...(parsed.pageVersion ? { pageVersion: parsed.pageVersion } : {}) },
    load: async () => {
      const response = await context.provider.comments(parsed.videoId, {
        continuation: parsed.continuation,
        ...(parsed.pageVersion ? { pageVersion: parsed.pageVersion } : {}),
      });
      if (parsed.pageVersion && response.assetVersions?.[0] !== parsed.pageVersion)
        throw new Error('The saved comment page is no longer available. Read the page again without an offset.');
      savedVersion = response.assetVersions?.[0];
      return response;
    },
    credits: meteredCredits('comments'),
    packet: (value) => {
      const sourceId = `youtube:${parsed.videoId}:comments`;
      const slice = commentPageSlice(value.comments, parsed.offset);
      // Later entries are offered only from a saved page, so every read of them is pinned.
      const nextOffset = savedVersion ? slice.nextOffset : undefined;
      const remaining = value.comments.length - slice.start - slice.page.length;
      return {
        kind: 'youtube_comments' as const,
        sources: [{
          id: sourceId,
          provider: 'youtube' as const,
          kind: 'comments' as const,
          videoId: parsed.videoId,
          url: youtubeVideoUrl(parsed.videoId),
        }],
        excerpts: slice.page.map(({ comment, position }) => ({
          id: `comment:${safeIdPart(comment.id)}:${position}`,
          sourceId,
          text: summarizeComment(comment),
        })),
        artifacts: [{
          type: 'youtube_comments',
          title: `Comments for ${parsed.videoId}`,
          data: {
            returnedCount: slice.page.length,
            totalCount: value.totalCount,
            complete: 'complete' in value ? value.complete : false,
            pagesFetched: 'pagesFetched' in value ? value.pagesFetched : 1,
            ...(savedVersion ? { pageVersion: savedVersion } : {}),
            ...(nextOffset !== undefined ? { nextOffset } : {}),
            collection: collectionRetrieval({
              fetchedCount: value.comments.length,
              retainedCount: slice.page.length,
              reportedTotal: value.totalCount,
              continuation: value.continuation,
              continuationAccepted: true,
              pageOffset: slice.start,
              nextPageOffset: nextOffset,
              pageVersion: nextOffset !== undefined ? savedVersion : undefined,
            }),
          },
        }],
        continuation: value.continuation,
        warnings: [
          ...providerWarnings(
            value.meta,
            'PARTIAL_YOUTUBE_COMMENTS',
            'YouTube returned partial comment data.',
          ),
          ...(remaining > 0 ? [{
            code: 'COMMENT_PAGE_REMAINING',
            message: nextOffset !== undefined
              // How to read the rest is stated once, in the packet's collection coverage and nextOffset.
              ? `This read holds comments ${slice.start + 1} to ${slice.start + slice.page.length} of ${value.comments.length} on the saved provider page. The rest were not read in this packet.`
              : `This read holds comments ${slice.start + 1} to ${slice.start + slice.page.length} of ${value.comments.length} on the provider page. The page was not saved, so the other ${remaining} cannot be read without fetching it again; do not describe them.`,
          }] : []),
        ],
      };
    },
  });
}

function normalizeCommentText(value: string): string {
  return value.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function commentAttribution(comment: Comment): string {
  return [
    `Author: ${comment.author.name}`,
    comment.publishedTimeText ? `Published: ${comment.publishedTimeText}` : undefined,
    comment.likeCountText ? `Likes: ${comment.likeCountText}` : undefined,
    comment.replyCount === undefined ? undefined : `Replies: ${comment.replyCount}`,
    comment.isPinned ? 'Pinned: yes' : undefined,
    comment.isHearted ? 'Creator heart: yes' : undefined,
  ].filter(Boolean).join('\n').slice(0, 500);
}

/**
 * Comment text followed by its attribution. Space for the attribution is reserved, so a
 * long body is shortened instead of losing the author. Short comments read as before.
 */
export function summarizeComment(comment: Comment): string {
  return commentPassage(comment).text;
}

/**
 * A bounded passage of one comment. A body longer than one excerpt is shown around a match,
 * so a match in its tail stays visible. `rawMatch` is the matched span in the unmodified
 * comment text, as reported by session search; without it the earliest literal occurrence
 * of a term is used, the same substring rule a filtered saved read applies.
 * `start` is set only when the passage does not begin at the start of the body.
 */
export function commentPassage(comment: Comment, terms: readonly string[] = [], rawMatch?: { at: number; end: number }): { text: string; start?: number } {
  const attribution = commentAttribution(comment);
  const body = normalizeCommentText(comment.text ?? '');
  const budget = COMMENT_EXCERPT_CHARACTERS - attribution.length - 1;
  if (body.length <= budget) return { text: body ? `${body}\n${attribution}` : attribution };
  const match = rawMatch ? normalizedMatch(comment.text ?? '', rawMatch) : literalMatch(body, terms);
  if (!match || match.end <= budget - 1)
    return { text: `${body.slice(0, budget - 1)}…\n${attribution}` };
  // Start just before the match, so a later shortening of the passage keeps the match.
  const start = Math.max(0, match.at - PASSAGE_LEAD_CHARACTERS);
  const end = Math.min(body.length, start + budget - 2);
  return { text: `…${body.slice(start, end)}${end < body.length ? '…' : ''}\n${attribution}`, start };
}

function literalMatch(body: string, terms: readonly string[]): { at: number; end: number } | undefined {
  const lower = body.toLowerCase();
  return terms.map(term => ({ at: lower.indexOf(term.toLowerCase()), end: lower.indexOf(term.toLowerCase()) + term.length }))
    .filter((item, index) => terms[index] && item.at >= 0).sort((a, b) => a.at - b.at)[0];
}

/**
 * A raw-text span translated into the whitespace-normalized body, keeping the whole matched
 * token. Normalizing only a prefix can differ from the full body by one trimmed space, which
 * the passage lead absorbs; the end is extended by that space so the token is never cut.
 * A span past the body, such as an author-only match, has no body position.
 */
function normalizedMatch(raw: string, span: { at: number; end: number }): { at: number; end: number } | undefined {
  if (span.at < 0 || span.at >= raw.length || span.end <= span.at) return undefined;
  const at = normalizeCommentText(raw.slice(0, span.at)).length;
  const end = normalizeCommentText(raw.slice(0, Math.min(span.end, raw.length))).length + 1;
  return { at, end: Math.max(end, at + 1) };
}

/** Full searchable comment content: the whole body and the author, never a shortened excerpt. */
export function commentSearchText(comment: Comment): string {
  return `${comment.text ?? ''}\n${comment.author.name}`;
}
