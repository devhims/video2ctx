'use client';

import { useEffect, useRef, useState } from 'react';
import { ChecksIcon, CopyIcon } from '@phosphor-icons/react';
import { ClipTabs } from './clip-tabs';

/* One install surface for the supported agent and developer routes. Keep every
 * command copyable as-is: this is onboarding, not a decorative code sample. */

type Sample = 'skills' | 'cli-skill' | 'curl' | 'node';

/* Each route's note says when to pick it, and its link goes to the thing you
 * would install or read next. These absorbed the old route cards. */
const SAMPLES: Record<
  Sample,
  {
    label: string;
    code: string;
    note: string;
    link: { label: string; href: string };
    /* A plain-language prompt to paste into an agent rather than commands to
     * run. Backticked spans are the commands, and they keep their backticks in
     * the copy so the agent can tell them apart too. */
    prompt?: boolean;
  }
> = {
  skills: {
    label: 'Agent Skills',
    note: 'Ask Claude Code, Codex, or any agent that loads skills about a public YouTube video, and it fetches the transcript, comments, and frames itself, right from your machine. No account, API key, or CLI needed.',
    code: 'npx skills add devhims/video2ctx',
    link: {
      label: 'Browse the skills',
      href: 'https://github.com/devhims/video2ctx/tree/main/.agents/skills',
    },
  },
  'cli-skill': {
    label: 'CLI + Skill',
    note: 'Connects Claude Code or Codex to your video2ctx account, for hosted features like Video Agent and monitors. The CLI signs you in and runs the commands, and the skill tells your agent when to use them.',
    prompt: true,
    code: `Set up video2ctx for me so I can search, read, and monitor videos from here.
1. Install the CLI: run \`npm install -g @video2ctx/cli\`.
2. Sign in: run \`video2ctx auth login\` and approve the code in the browser it opens.
3. Install the companion skills: run \`npx skills add devhims/video2ctx\`.
Once that's done, let me know it's ready.`,
    link: {
      label: '@video2ctx/cli on npm',
      href: 'https://www.npmjs.com/package/@video2ctx/cli',
    },
  },
  curl: {
    label: 'Hosted API',
    note: 'Call video2ctx from your own app, in any language. You get JSON with links back to the source, authenticated with an API key from your dashboard.',
    code: `curl 'https://api.video2ctx.dev/v1/videos/S4tdkSVuxZA/transcript?provider=youtube' \\
  --header "Authorization: Bearer $VIDEO2CTX_API_KEY"`,
    link: {
      label: 'Read the API reference',
      href: 'https://docs.video2ctx.dev/api-reference/introduction',
    },
  },
  node: {
    label: 'NPM Package',
    note: 'Fetch YouTube data straight from your own TypeScript server.',
    code: 'npm install all-things-youtube',
    link: {
      label: 'all-things-youtube on npm',
      href: 'https://www.npmjs.com/package/all-things-youtube',
    },
  },
};

const TABS = (Object.keys(SAMPLES) as Sample[]).map((id) => ({
  id,
  label: SAMPLES[id].label,
}));

export function CraftCode() {
  const [sample, setSample] = useState<Sample>('skills');
  const active = SAMPLES[sample];

  return (
    <div className='craft-code'>
      <div className='craft-code-head'>
        <ClipTabs
          tabs={TABS}
          value={sample}
          onChange={setSample}
          idPrefix='craft-code'
          label='Ways to call it'
        />
      </div>

      {active.prompt ? (
        <p className='craft-code-prompt-label'>Copy and send this to your agent</p>
      ) : null}
      <div className='craft-code-frame'>
        <pre
          className='craft-code-block'
          data-prompt={active.prompt ? 'true' : undefined}
          role='tabpanel'
          id={`craft-code-panel-${sample}`}
          aria-labelledby={`craft-code-tab-${sample}`}
          tabIndex={0}
        >
          <code>{active.prompt ? highlightCommands(active.code) : active.code}</code>
        </pre>
        <CopyButton text={active.code} what={active.prompt ? 'prompt' : 'code'} />
      </div>

      <div className='craft-code-note'>
        <p>{active.note}</p>
        <a href={active.link.href} target='_blank' rel='noreferrer'>
          {active.link.label}
          <span aria-hidden='true'>→</span>
        </a>
      </div>
    </div>
  );
}

/* Colours the backticked commands in a prompt so they stand apart from the
 * instructions around them. */
function highlightCommands(text: string) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith('`') ? (
      <span key={i} className='craft-code-cmd'>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function CopyButton({ text, what }: { text: string; what: 'code' | 'prompt' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // A denied clipboard should not flash a success state.
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type='button'
      className='craft-copy'
      onClick={copy}
      data-copied={copied}
      aria-label={copied ? `${what === 'prompt' ? 'Prompt' : 'Code'} copied` : `Copy ${what}`}
      title={copied ? 'Copied' : `Copy ${what}`}
    >
      <span className='craft-copy-icon' aria-hidden='true'>
        <CopyIcon size={16} weight='regular' />
      </span>
      <span className='craft-copy-icon' aria-hidden='true'>
        <ChecksIcon size={17} weight='bold' />
      </span>
      <span className='craft-sr' role='status' aria-live='polite'>
        {copied ? `${what === 'prompt' ? 'Prompt' : 'Code'} copied` : ''}
      </span>
    </button>
  );
}
