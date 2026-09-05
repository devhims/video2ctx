import type { Comment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import {
  bounded,
  continuationSchema,
  executeProviderEvidence,
  MAX_PROVIDER_ITEMS,
  meteredCredits,
  providerWarnings,
  safeIdPart,
  videoIdSchema,
  youtubeVideoUrl,
} from './provider-evidence';

export const getVideoCommentsInputSchema = z.object({
  videoId: videoIdSchema,
  continuation: continuationSchema,
  all: z.boolean().default(false),
});

export type GetVideoCommentsInput = z.infer<typeof getVideoCommentsInputSchema>;

export function createGetVideoCommentsTool(context: AgentToolContext) {
  return tool({
    description: 'Read comments for exactly one YouTube video. Use all=false for one page or all=true for the bounded newest-first collection.',
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
      all: parsed.all,
    }),
    credits: meteredCredits('comments'),
    packet: (value) => {
      const sourceId = `youtube:${parsed.videoId}:comments`;
      const comments = value.comments.slice(0, MAX_PROVIDER_ITEMS);
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
          text: summarizeComment(comment),
        })),
        artifacts: [{
          type: 'youtube_comments',
          title: `Comments for ${parsed.videoId}`,
          data: {
            returnedCount: comments.length,
            totalCount: value.totalCount,
            complete: 'complete' in value ? value.complete : false,
            pagesFetched: 'pagesFetched' in value ? value.pagesFetched : 1,
          },
        }],
        continuation: value.continuation,
        warnings: providerWarnings(
          value.meta,
          'PARTIAL_YOUTUBE_COMMENTS',
          'YouTube returned partial comment data.',
        ),
      };
    },
  });
}

function summarizeComment(comment: Comment): string {
  return bounded([
    comment.text,
    `Author: ${comment.author.name}`,
    comment.publishedTimeText ? `Published: ${comment.publishedTimeText}` : undefined,
    comment.likeCountText ? `Likes: ${comment.likeCountText}` : undefined,
    comment.replyCount === undefined ? undefined : `Replies: ${comment.replyCount}`,
    comment.isPinned ? 'Pinned: yes' : undefined,
    comment.isHearted ? 'Creator heart: yes' : undefined,
  ].filter(Boolean).join('\n'));
}
