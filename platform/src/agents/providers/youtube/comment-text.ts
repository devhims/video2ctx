import type { Comment } from 'all-things-youtube';

const COMMENT_EXCERPT_CHARACTERS = 2_000;
/** Model views show at most this much of one comment; a query passage must fit inside it. */
export const COMMENT_VIEW_CHARACTERS = 800;

/** The comment fields shown to models; saved pages are validated to this shape. */
export type CommentTextFields = Pick<Comment, 'text'> & { author?: { name?: string } }
  & Partial<Pick<Comment, 'publishedTimeText' | 'likeCountText' | 'replyCount' | 'isPinned' | 'isHearted'>>;

const normalized = (text: string | undefined) => (text ?? '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

/** The complete text a saved-comment query is matched against: attribution and the whole comment. */
export function commentSearchText(comment: CommentTextFields): string {
  return `${comment.author?.name ?? ''}\n${normalized(comment.text)}`.toLowerCase();
}

/**
 * One comment as citable text, shared by fresh tool packets and saved-page reads.
 * Attribution comes first so later view limits never cut the author. Long text is
 * shortened with an explicit marker rather than silently clipped. With a focus whose
 * match would fall outside a model view of the comment, a passage around the match is
 * returned instead, small enough to be shown whole, with `passageStart` identifying it.
 */
export function commentExcerpt(comment: CommentTextFields, focus?: string): { text: string; passageStart?: number } {
  const details = [
    `Author: ${comment.author?.name || 'unknown'}`,
    comment.publishedTimeText ? `Published: ${comment.publishedTimeText}` : undefined,
    comment.likeCountText ? `Likes: ${comment.likeCountText}` : undefined,
    comment.replyCount === undefined ? undefined : `Replies: ${comment.replyCount}`,
    comment.isPinned ? 'Pinned: yes' : undefined,
    comment.isHearted ? 'Creator heart: yes' : undefined,
  ].filter(Boolean).join('\n');
  const text = normalized(comment.text) || '(no comment text returned)';
  const match = focus ? text.toLowerCase().indexOf(focus.toLowerCase()) : -1;
  // The start of the comment that a model view shows before its shortening marker.
  const visible = COMMENT_VIEW_CHARACTERS - details.length - 1 - 90;
  if (focus && match >= 0 && match + focus.length > visible) {
    const header = (start: number, end: number) => `[Passage of a longer comment: characters ${start + 1}-${end} of ${text.length}.] `;
    const window = Math.max(focus.length, COMMENT_VIEW_CHARACTERS - details.length - 1 - header(text.length, text.length).length);
    const start = Math.max(0, Math.min(match - Math.floor((window - focus.length) / 3), text.length - window));
    const end = Math.min(text.length, start + window);
    return { passageStart: start, text: `${details}\n${header(start, end)}${text.slice(start, end)}` };
  }
  const room = COMMENT_EXCERPT_CHARACTERS - details.length - 1;
  if (text.length <= room) return { text: `${details}\n${text}` };
  const kept = text.slice(0, Math.max(0, room - 120)).trimEnd();
  return { text: `${details}\n${kept} [Comment truncated: first ${kept.length} of ${text.length} characters shown.]` };
}

export function commentExcerptText(comment: CommentTextFields): string {
  return commentExcerpt(comment).text;
}
