import { describe, expect, it } from 'vitest';
import type { Comment } from 'all-things-youtube';
import { commentPassage } from '../src/agents/providers/youtube/tools/get-video-comments';
import { collectionRetrieval, modelCollection } from '../src/agents/runtime/collection-coverage';
import { firstMatchSpan, matchMarkers } from '../src/agents/runtime/search-highlight';

// Regressions for comment-search issues found in the independent PR211 review.

const longComment = (text: string) => ({
  id: 'c', text, author: { name: 'Janine', thumbnails: [] }, replyCount: 0, isPinned: false, isHearted: false, replies: [],
}) as unknown as Comment;
const filler = 'Some unrelated setup words here. '.repeat(70);

describe('search passages are placed at the match offset session search reports', () => {
  // Matching itself is decided by SQLite FTS5; session-evidence.integration.test.ts checks real tokenizer cases.
  it('shows the passage at a late reported offset even when an earlier substring exists', () => {
    const text = `Before we start, ${filler} the real art of it is patience.`;
    const passage = commentPassage(longComment(text), [], { at: text.lastIndexOf('art'), end: text.lastIndexOf('art') + 3 });
    expect(passage.start).toBeGreaterThan(0);
    expect(passage.text).toContain('the real art of it is patience');
    expect(passage.text).toContain('Author: Janine');
  });

  it('maps a raw offset through whitespace normalization', () => {
    const text = `${'Padding   with \t extra   spaces. '.repeat(90)}The objection is here.`;
    const passage = commentPassage(longComment(text), [], { at: text.indexOf('The objection'), end: text.indexOf('The objection') + 3 });
    expect(passage.text).toContain('The objection is here.');
  });

  it('starts at the beginning for an author-only match, keeping the attribution', () => {
    const text = filler;
    const passage = commentPassage(longComment(text), [], { at: text.length + 1, end: text.length + 7 });
    expect(passage.start).toBeUndefined();
    expect(passage.text).toContain('Author: Janine');
  });

  it('keeps the whole matched token when it ends at the excerpt cutoff', () => {
    // "Author: Janine" and "Replies: 0" leave a 1,974-character body budget; cross that cutoff.
    for (let at = 1964; at <= 1976; at += 1) {
      const text = `${'w'.repeat(at - 1)} needle ${'tail '.repeat(100)}`;
      expect(commentPassage(longComment(text), [], { at, end: at + 6 }).text, `offset ${at}`).toContain('needle');
    }
  });

  it('keeps literal matching for filtered saved reads without a reported offset', () => {
    const text = `${filler}The final objection.`;
    expect(commentPassage(longComment(text), ['objection']).text).toContain('The final objection.');
  });
});

describe('filtered saved reads describe offsets as matches', () => {
  it('states match counts and the same-query continuation, not provider-page positions', () => {
    const retrieval = collectionRetrieval({ fetchedCount: 12, retainedCount: 8, continuationAccepted: true,
      pageOffset: 0, nextPageOffset: 8, matchesOnly: true });
    const coverage = modelCollection({ shown: 8, retained: 8, retrieval, continuationShown: false }).coverage;
    expect(coverage).toContain('12 saved entries match the query.');
    expect(coverage).toContain('Repeat this saved read with the same query at offset 8');
    expect(coverage).not.toContain('provider page had');
    expect(coverage).not.toContain('same continuation');
  });

  it('keeps provider-page wording and names the version for unfiltered saved reads', () => {
    const version = 'a'.repeat(64);
    const retrieval = collectionRetrieval({ fetchedCount: 14, retainedCount: 8, continuationAccepted: true,
      pageOffset: 0, nextPageOffset: 8, pageVersion: version });
    const coverage = modelCollection({ shown: 8, retained: 8, retrieval, continuationShown: false }).coverage;
    expect(coverage).toContain('The provider page had 14 entries.');
    expect(coverage).toContain(`Read offset 8 with pageVersion ${version}`);
  });
});

describe('highlight offsets are safe against marker text in untrusted content', () => {
  const mark = (content: string, at: number, length: number, markers: { start: string; end: string }) =>
    `${content.slice(0, at)}${markers.start}${content.slice(at, at + length)}${markers.end}${content.slice(at + length)}`;

  it('ignores control characters and old fixed markers in the content', () => {
    const content = 'early \u0001\u0002 noise [[match-start:x]] then the real art here\nViewer';
    const markers = matchMarkers();
    const at = content.indexOf('art here');
    expect(firstMatchSpan({ content, marked: mark(content, at, 3, markers), markers })).toEqual({ at, end: at + 3 });
  });

  it('uses fresh markers per query', () => {
    expect(matchMarkers().start).not.toBe(matchMarkers().start);
  });

  it('rejects an offset when the content contains the markers or does not round-trip', () => {
    const markers = matchMarkers();
    const content = `prefix ${markers.start} art`;
    expect(firstMatchSpan({ content, marked: mark(content, content.length - 3, 3, markers), markers })).toBeUndefined();
    expect(firstMatchSpan({ content: 'plain art', marked: `plain ${markers.start}ART${markers.end}`, markers })).toBeUndefined();
    expect(firstMatchSpan({ content: 'plain art', marked: 'plain art', markers })).toBeUndefined();
  });
});
