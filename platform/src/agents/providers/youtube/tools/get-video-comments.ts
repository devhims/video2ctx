import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import { commentExcerptText } from '../comment-text';
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

export const getVideoCommentsInputSchema = z.object({
  videoId: videoIdSchema,
  continuation: continuationSchema,
});

export type GetVideoCommentsInput = z.infer<typeof getVideoCommentsInputSchema>;

/** A provider page is delivered whole, in YouTube's order. This only guards against an unexpectedly large page. */
export const MAX_COMMENTS_PER_PACKET = 100;

export function createGetVideoCommentsTool(context: AgentToolContext) {
  return tool({
    description: 'Read one page of comments for exactly one YouTube video, in YouTube\'s default ranking. Pass the returned continuation to read the next page only when the question needs more comments.',
    inputSchema: getVideoCommentsInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoComments(input, context, toolCallId),
  });
}

export function executeGetVideoComments(
  input: GetVideoCommentsInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = getVideoCommentsInputSchema.parse(input);
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_video_comments',
    operation: 'comments',
    semanticInput: parsed,
    load: () => context.provider.comments(parsed.videoId, {
      continuation: parsed.continuation,
    }),
    credits: meteredCredits('comments'),
    packet: (value) => {
      const sourceId = `youtube:${parsed.videoId}:comments`;
      const comments = value.comments.slice(0, MAX_COMMENTS_PER_PACKET);
      const omitted = value.comments.length - comments.length;
      return {
        kind: 'youtube_comments' as const,
        sources: [{
          id: sourceId,
          provider: 'youtube' as const,
          kind: 'comments' as const,
          videoId: parsed.videoId,
          url: youtubeVideoUrl(parsed.videoId),
        }],
        excerpts: comments.map((comment, index) => ({
          id: `comment:${safeIdPart(comment.id)}:${index}`,
          sourceId,
          text: commentExcerptText(comment),
        })),
        artifacts: [{
          type: 'youtube_comments',
          title: `Comments for ${parsed.videoId}`,
          data: {
            returnedCount: comments.length,
            pageCount: value.comments.length,
            totalCount: value.totalCount,
            complete: 'complete' in value ? value.complete : false,
            pagesFetched: 'pagesFetched' in value ? value.pagesFetched : 1,
          },
        }],
        continuation: value.continuation,
        warnings: [
          ...providerWarnings(
            value.meta,
            'PARTIAL_YOUTUBE_COMMENTS',
            'YouTube returned partial comment data.',
          ),
          ...(omitted > 0 ? [{ code: 'COMMENTS_PAGE_TRUNCATED',
            message: `This page returned ${value.comments.length} comments; only the first ${comments.length} are included.` }] : []),
        ],
      };
    },
  });
}
