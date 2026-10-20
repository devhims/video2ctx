export type MatchMarkers = { start: string; end: string };

/**
 * Markers FTS5 highlight() places around matched tokens. Indexed text is untrusted and may
 * contain any fixed character, so each query uses fresh random markers, and an offset is
 * accepted only when the row's own content does not contain them.
 */
export function matchMarkers(): MatchMarkers {
  const nonce = crypto.randomUUID();
  return { start: `[[match-start:${nonce}]]`, end: `[[match-end:${nonce}]]` };
}

/** A matched span in the original indexed content: `at` inclusive, `end` exclusive. */
export type MatchSpan = { at: number; end: number };

/**
 * The first matched span in indexed content, from FTS5 highlight(). Text before the first
 * marker is unmodified content, so its length is the original start; the matched text
 * between the markers gives the end. Returns undefined unless removing the markers
 * reproduces the content exactly.
 */
export function firstMatchSpan(row: { content: string; marked?: string; markers?: MatchMarkers }): MatchSpan | undefined {
  const { marked, markers, content } = row;
  if (!marked || !markers || content.includes(markers.start) || content.includes(markers.end)) return undefined;
  if (marked.split(markers.start).join('').split(markers.end).join('') !== content) return undefined;
  const at = marked.indexOf(markers.start);
  if (at < 0) return undefined;
  const close = marked.indexOf(markers.end, at + markers.start.length);
  if (close < 0) return undefined;
  return { at, end: close - markers.start.length };
}
