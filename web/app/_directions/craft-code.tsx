'use client';

import { useEffect, useRef, useState } from 'react';
import { ChecksIcon, CopyIcon } from '@phosphor-icons/react';
import { ClipTabs } from './clip-tabs';

/* One install surface for the supported agent and developer routes. Keep every
 * command copyable as-is: this is onboarding, not a decorative code sample. */

type Sample = 'skills' | 'cli-skill' | 'curl' | 'node';

const SAMPLES: Record<Sample, { label: string; code: string; note: string }> = {
  skills: {
    label: 'Agent Skills',
    note: 'Choose either or both skills. youtube-ctx works immediately without an account or hosted service.',
    code: 'npx skills add devhims/video2ctx',
  },
  'cli-skill': {
    label: 'CLI + Skill',
    note: 'The CLI handles authenticated hosted commands. The companion platform skill teaches agents when and how to use them.',
    code: `npm install --global @video2ctx/cli
video2ctx auth login
npx skills add devhims/video2ctx`,
  },
  curl: {
    label: 'Hosted API',
    note: 'Any language, one request. Bearer auth with a key from the dashboard.',
    code: `curl https://api.video2ctx.dev/v1/providers/youtube/videos/S4tdkSVuxZA/transcript \\
  --header "Authorization: Bearer $VIDEO2CTX_API_KEY"`,
  },
  node: {
    label: 'NPM Package',
    note: 'Server-side TypeScript, no key and no hosted service in the path.',
    code: 'npm install all-things-youtube',
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

      <p className='craft-code-note'>{active.note}</p>
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
