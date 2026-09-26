import type { Root, RootContent, PhrasingContent, Parent } from 'mdast';
import { safeSourceUrl } from './agent-sessions.ts';

type Source = { id: string; title: string; url?: string };

/** Link application-numbered references without changing code or existing links. */
export function remarkSourceCitations(options: { sources: readonly Source[] }) {
  const sources = new Map(options.sources.map(source => [source.id, source]));
  function visit(parent: Parent) {
    parent.children = parent.children.flatMap<RootContent>(node => {
      if (node.type === 'text') {
        const parts: PhrasingContent[] = [];
        let offset = 0;
        for (const match of node.value.matchAll(/\[(\d+)\]/g)) {
          const source = sources.get(match[1]!);
          const url = safeSourceUrl(source?.url);
          if (!source || !url) continue;
          if (match.index! > offset) parts.push({ type: 'text', value: node.value.slice(offset, match.index) });
          parts.push({ type: 'link', url, title: `Source ${source.id}: ${source.title}`,
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
