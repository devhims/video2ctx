'use client';

import { useEffect, useRef, useState } from 'react';
import { ClipTabs } from './clip-tabs';

/* One code moment, not a route table.
 *
 * The audience is a developer deciding whether this beats writing their own
 * scraper, so exactly one honest example of each way in earns its place. Both
 * samples are real: the bearer-token curl is the documented auth scheme, and
 * the package call is `getTranscript` as the npm README actually exports it.
 */

type Sample = 'curl' | 'node';

const SAMPLES: Record<Sample, { label: string; code: string; note: string }> = {
  curl: {
    label: 'Hosted API',
    note: 'Any language, one request. Bearer auth with a key from the dashboard.',
    code: `curl https://api.video2ctx.dev/v1/providers/youtube/videos/S4tdkSVuxZA/transcript \\
  --header "Authorization: Bearer $VIDEO2CTX_API_KEY"`,
  },
  node: {
    label: 'npm package',
    note: 'Server-side TypeScript, no key and no hosted service in the path.',
    code: `import { getTranscript } from 'all-things-youtube';

const transcript = await getTranscript({
  videoId: 'S4tdkSVuxZA',
  lang: 'hi',
});

console.log(transcript.translatedTo); // { languageCode: 'hi', name: 'Hindi' }`,
  },
};

const TABS = (Object.keys(SAMPLES) as Sample[]).map((id) => ({ id, label: SAMPLES[id].label }));

export function CraftCode() {
  const [sample, setSample] = useState<Sample>('curl');
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
        <CopyButton text={active.code} />
      </div>

      <pre
        className='craft-code-block'
        role='tabpanel'
        id={`craft-code-panel-${sample}`}
        aria-labelledby={`craft-code-tab-${sample}`}
        tabIndex={0}
      >
        <code>{active.code}</code>
      </pre>

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
    <button type='button' className='craft-copy' onClick={copy} data-copied={copied}>
      {/* Both labels are always in the DOM and crossfade in place, so the button
          never changes width mid-press — a resizing button under the cursor is
          the kind of small wrongness that registers without being noticed. */}
      <span aria-hidden='true'>Copy</span>
      <span aria-hidden='true'>Copied</span>
      <span className='craft-sr'>{copied ? 'Copied to clipboard' : 'Copy code'}</span>
    </button>
  );
}
