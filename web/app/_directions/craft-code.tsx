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
  { label: string; code: string; note: string; link: { label: string; href: string } }
> = {
  skills: {
    label: 'Agent Skills',
    note: 'Your agent handles one-off public YouTube requests directly with youtube-ctx. No CLI, account, API key, or hosted service needed. Add video2ctx-platform when you want hosted features.',
    code: 'npx skills add devhims/video2ctx',
    link: {
      label: 'Browse the skills',
      href: 'https://github.com/devhims/video2ctx/tree/main/.agents/skills',
    },
  },
  'cli-skill': {
    label: 'CLI + Skill',
    note: 'For hosted agent work, install both. The CLI handles browser sign-in and stable commands, and the platform skill teaches your agent when and how to use them.',
    code: `npm install --global @video2ctx/cli
video2ctx auth login
npx skills add devhims/video2ctx`,
    link: {
      label: '@video2ctx/cli on npm',
      href: 'https://www.npmjs.com/package/@video2ctx/cli',
    },
  },
  curl: {
    label: 'Hosted API',
    note: 'Any language, one request. JSON with the source links intact, Bearer auth with a key from the dashboard, and versioned under /v1.',
    code: `curl 'https://api.video2ctx.dev/v1/videos/S4tdkSVuxZA/transcript?provider=youtube' \\
  --header "Authorization: Bearer $VIDEO2CTX_API_KEY"`,
    link: {
      label: 'Read the API reference',
      href: 'https://docs.video2ctx.dev/api-reference/introduction',
    },
  },
  node: {
    label: 'NPM Package',
    note: 'A server-side TypeScript client, with no API key and no hosted service in the path.',
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

      <div className='craft-code-frame'>
        <pre
          className='craft-code-block'
          role='tabpanel'
          id={`craft-code-panel-${sample}`}
          aria-labelledby={`craft-code-tab-${sample}`}
          tabIndex={0}
        >
          <code>{active.code}</code>
        </pre>
        <CopyButton text={active.code} />
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

function CopyButton({ text }: { text: string }) {
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
      aria-label={copied ? 'Code copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
    >
      <span className='craft-copy-icon' aria-hidden='true'>
        <CopyIcon size={16} weight='regular' />
      </span>
      <span className='craft-copy-icon' aria-hidden='true'>
        <ChecksIcon size={17} weight='bold' />
      </span>
      <span className='craft-sr' role='status' aria-live='polite'>
        {copied ? 'Code copied' : ''}
      </span>
    </button>
  );
}
