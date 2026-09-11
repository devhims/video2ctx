'use client';

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeSourceUrl } from '../../../lib/agent-sessions';

export function AgentMarkdown({ children }: { children: string }) {
  return <div className='agent-answer agent-markdown'><Markdown remarkPlugins={[remarkGfm]} skipHtml
    components={{
      a: ({ href, children }) => {
        const safe = safeSourceUrl(href);
        return safe ? <a href={safe} target='_blank' rel='noreferrer'>{children}</a> : <span>{children}</span>;
      },
      // Model-generated image URLs should not trigger unsolicited browser requests.
      img: ({ alt }) => alt ? <span>{alt}</span> : null,
      table: ({ children }) => <div className='agent-table-scroll' tabIndex={0} role='region' aria-label='Answer table'><table>{children}</table></div>,
    }}>{children}</Markdown></div>;
}
