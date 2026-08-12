'use client';

import { FormEvent, useState } from 'react';
import { ClipTabs } from './clip-tabs';
import {
  DemoResponse,
  describeError,
  formatTimestamp,
  inspect,
  timestampUrl,
} from '../_lib/inspect';

/* Direction 02 — the demo IS the page.
 *
 * Motion budget follows the frequency rule: this control is the primary action,
 * so it gets feedback-grade motion only (100–200ms, no decoration). The result
 * below it is seen once per visit, so it is allowed a staggered entrance.
 */

type Tab = 'transcript' | 'comments' | 'channel';

const TABS: { id: Tab; label: string }[] = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'comments', label: 'Comments' },
  { id: 'channel', label: 'Channel' },
];

export function CraftDemo() {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('loading');
    setError('');

    try {
      const payload = await inspect(url);
      setResult(payload);
      setState('done');
    } catch (cause) {
      setError(describeError(cause));
      setState('error');
    }
  };

  return (
    <div className='craft-demo'>
      <form className='craft-form' onSubmit={submit}>
        <input
          id='craft-url'
          name='url'
          type='url'
          inputMode='url'
          autoComplete='url'
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder='Paste a YouTube URL'
          aria-label='Public YouTube video URL'
          required
          disabled={state === 'loading'}
        />
        {/* The label swaps under a 2px blur rather than hard-cutting. Without it
            you see two distinct words overlap mid-crossfade; blur bridges them
            into one transformation. */}
        <button type='submit' data-state={state} disabled={state === 'loading'}>
          <span className='craft-button-label'>
            {state === 'loading' ? 'Reading' : state === 'done' ? 'Read again' : 'Inspect'}
          </span>
          {state === 'loading' ? <i className='craft-spinner' aria-hidden='true' /> : null}
        </button>
      </form>

      <p className='craft-form-note' aria-live='polite'>
        {state === 'error' ? (
          <span role='alert' className='craft-error'>
            {error}
          </span>
        ) : result ? (
          <>
            {result.quota.remaining} of {result.quota.limit} free inspections left today
          </>
        ) : (
          <>Five videos a day. No account, no key.</>
        )}
      </p>

      {result ? <CraftResult result={result} /> : null}
    </div>
  );
}

function CraftResult({ result }: { result: DemoResponse }) {
  const [tab, setTab] = useState<Tab>('transcript');

  const transcript = result.transcript;
  const comments = result.comments;

  return (
    <section className='craft-result' aria-label='Inspection result'>
      <header className='craft-result-head' style={cascade(0)}>
        <h2>{result.video.title}</h2>
        <p>
          <a href={result.video.channel.url} target='_blank' rel='noreferrer'>
            {result.video.channel.name}
          </a>
          {result.video.durationText ? <span>{result.video.durationText}</span> : null}
          {result.video.publishedTimeText ? <span>{result.video.publishedTimeText}</span> : null}
        </p>
      </header>

      <div className='craft-tabs' style={cascade(1)}>
        <ClipTabs
          tabs={TABS}
          value={tab}
          onChange={setTab}
          idPrefix='craft'
          label='Context returned with this video'
        />
      </div>

      <div
        className='craft-panel'
        role='tabpanel'
        id={`craft-panel-${tab}`}
        aria-labelledby={`craft-tab-${tab}`}
        style={cascade(2)}
      >
        {tab === 'transcript' ? (
          transcript.status === 'ready' ? (
            <ol className='craft-transcript'>
              {transcript.segments.slice(0, 14).map((segment, index) => (
                <li key={`${segment.startMs}-${index}`}>
                  <a
                    href={timestampUrl(result.video.url, segment.startMs)}
                    target='_blank'
                    rel='noreferrer'
                  >
                    {formatTimestamp(segment.startMs)}
                  </a>
                  <p>{segment.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className='craft-empty'>No captions published for this video.</p>
          )
        ) : null}

        {tab === 'comments' ? (
          comments.status === 'ready' && comments.comments.length ? (
            <ol className='craft-comments'>
              {comments.comments.slice(0, 8).map((comment) => (
                <li key={comment.id}>
                  <p className='craft-comment-author'>
                    {comment.author.name}
                    {comment.isPinned ? <b>pinned</b> : null}
                    {comment.isHearted ? <b>hearted</b> : null}
                  </p>
                  <p>{comment.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className='craft-empty'>Comments are turned off for this video.</p>
          )
        ) : null}

        {tab === 'channel' ? (
          <dl className='craft-channel'>
            <div>
              <dt>Channel</dt>
              <dd>
                <a href={result.video.channel.url} target='_blank' rel='noreferrer'>
                  {result.video.channel.name}
                </a>
              </dd>
            </div>
            <div>
              <dt>Video</dt>
              <dd>
                <a href={result.video.url} target='_blank' rel='noreferrer'>
                  {result.video.id}
                </a>
              </dd>
            </div>
            {result.video.viewCountText ? (
              <div>
                <dt>Views</dt>
                <dd>{result.video.viewCountText}</dd>
              </div>
            ) : null}
            {transcript.status === 'ready' ? (
              <div>
                <dt>Segments</dt>
                <dd>
                  {transcript.segmentCount.toLocaleString()} ·{' '}
                  {transcript.track.languageCode.toUpperCase()}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

/** Stagger index. 45ms steps — long enough to read as a cascade, short enough
 *  that the last item is not still arriving after the user has looked at it. */
function cascade(index: number) {
  return { '--i': index } as React.CSSProperties;
}
