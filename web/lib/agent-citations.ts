import type { Root, RootContent, PhrasingContent, Parent } from 'mdast';
import { safeSourceUrl } from './agent-sessions.ts';

type Source = { id: string; title: string; url?: string };

/** A reference such as [1 · 4:52] names the cited moment of its video. */
function atMoment(url: string, time: string): string {
  const seconds = time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const target = new URL(url);
  target.searchParams.set('t', `${seconds}s`);
  return target.toString();
}

/** Link application-numbered references without changing code or existing links. */
export function remarkSourceCitations(options: { sources: readonly Source[] }) {
  const sources = new Map(options.sources.map(source => [source.id, source]));
  function visit(parent: Parent) {
    parent.children = parent.children.flatMap<RootContent>(node => {
      if (node.type === 'text') {
        const parts: PhrasingContent[] = [];
        let offset = 0;
        for (const match of node.value.matchAll(/\[(\d+)(?: · ((?:\d+:)?\d{1,2}:\d{2}))?\]/g)) {
          const source = sources.get(match[1]!);
          const url = safeSourceUrl(source?.url);
          if (!source || !url) continue;
          if (match.index! > offset) parts.push({ type: 'text', value: node.value.slice(offset, match.index) });
          const time = match[2];
          parts.push({ type: 'link', url: time ? atMoment(url, time) : url, title: `Source ${source.id}${time ? ` at ${time}` : ''}: ${source.title}`,
            children: [{ type: 'text', value: match[0] }] });
          offset = match.index! + match[0].length;
        }
        if (!offset) return [node];
        if (offset < node.value.length) parts.push({ type: 'text', value: node.value.slice(offset) });
        return parts;
      }
      if ('children' in node && node.type !== 'link' && node.type !== 'linkReference') visit(node);
      return [node];
    });
  }
  return (tree: Root) => visit(tree);
}
