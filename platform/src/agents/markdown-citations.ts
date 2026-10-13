import { fromMarkdown } from 'mdast-util-from-markdown';

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

/** Transform prose while copying code directly from the source, without reserializing Markdown. */
export function mapCitationProse(text: string, transform: (prose: string, start: number, end: number) => string, streaming = false): string {
  const protectedRanges: Array<[number, number]> = [];
  function visit(node: MarkdownNode, paragraphEnd = text.length) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'code' || node.type === 'inlineCode') {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const protectedStart = node.type === 'code' && /^[ \t]*$/.test(text.slice(lineStart, start)) ? lineStart : start;
      protectedRanges.push([protectedStart, end]);
      return;
    }
    if (node.type === 'paragraph') paragraphEnd = end;
    if (streaming && node.type === 'text') {
      // An unmatched backtick is plain text in complete Markdown, but may still
      // become an inline code span as the stream grows. Preserve that paragraph
      // tail provisionally. Escaped backticks are ordinary prose.
      const raw = text.slice(start, end);
      const opener = [...raw.matchAll(/\\[\\`]|`+/g)].find(match => match[0].startsWith('`'));
      if (opener) protectedRanges.push([start + opener.index!, paragraphEnd]);
    }
    if ('children' in node) for (const child of node.children) visit(child, paragraphEnd);
  }
  visit(fromMarkdown(text));
  protectedRanges.sort((a, b) => a[0] - b[0]);
  let offset = 0;
  let result = '';
  for (const [start, end] of protectedRanges) {
    if (end <= offset) continue;
    if (start > offset) result += transform(text.slice(offset, start), offset, start);
    result += text.slice(Math.max(offset, start), end);
    offset = end;
  }
  return result + transform(text.slice(offset), offset, text.length);
}

/** Canonical citations used for evidence reads and persisted-answer validation. */
export function answerCitationIds(text: string): string[] {
  const ids = new Set<string>();
  mapCitationProse(text, prose => {
    for (const match of prose.matchAll(/\[cite:([A-Za-z0-9:_-]+)\]/g)) ids.add(match[1]!);
    return prose;
  });
  return [...ids];
}

/** Appended citations must not join a fence delimiter or become code themselves. */
export function endsInCodeBlock(text: string): boolean {
  let last: MarkdownNode | undefined = fromMarkdown(text);
  while (last && 'children' in last) last = last.children.at(-1);
  return last?.type === 'code';
}

/** Trim only outer prose whitespace; indentation and trailing spaces in code are data. */
export function trimCitationProse(text: string, streaming = false): string {
  return mapCitationProse(text, (prose, start, end) => {
    if (start === 0) prose = prose.trimStart();
    if (end === text.length) prose = prose.trimEnd();
    return prose;
  }, streaming);
}
