'use client';

import { FormEvent, useState } from 'react';

interface Thumbnail {
  url: string;
  width?: number;
  height?: number;
}

interface DemoVideo {
  id: string;
  title: string;
  channel: { id: string; name: string; url: string };
  thumbnails: Thumbnail[];
  durationText?: string;
  viewCountText?: string;
  publishedTimeText?: string;
  url: string;
}

interface TranscriptSegment {
  startMs: number;
  durationMs: number;
  endMs: number;
  text: string;
}

interface DemoComment {
  id: string;
  author: { name: string };
  text: string;
  publishedTimeText?: string;
  likeCountText?: string;
  isPinned: boolean;
  isHearted: boolean;
}

interface DemoResponse {
  video: DemoVideo;
  transcript:
    | {
        status: 'ready';
        track: { name: string; languageCode: string };
        segmentCount: number;
        segments: TranscriptSegment[];
      }
    | { status: 'unavailable' };
  comments:
    | { status: 'ready'; totalCount?: number; comments: DemoComment[] }
    | { status: 'unavailable' };
  quota: { limit: number; remaining: number; resetAt: string; repeated: boolean };
  partial: boolean;
}

const demoApiBase =
  process.env.NEXT_PUBLIC_PLATFORM_API_BASE_URL ??
  (process.env.NODE_ENV === 'production'
    ? 'https://api.video2ctx.dev'
    : 'http://localhost:8787');

export function LandingDemo() {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [error, setError] = useState('');

  const inspectVideo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('loading');
    setResult(null);
    setError('');

    try {
      const response = await fetch(`${demoApiBase}/v1/demo/youtube/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const payload = (await response.json()) as DemoResponse & {
        error?: { message?: string; details?: { resetAt?: string } };
      };

      if (!response.ok) {
        const reset = payload.error?.details?.resetAt;
        const retry = reset
          ? ` You can inspect another video after ${formatReset(reset)}.`
          : '';
        throw new Error(`${payload.error?.message ?? 'The video could not be inspected.'}${retry}`);
      }

      setResult(payload);
      setState('success');
      window.setTimeout(() => {
        document.getElementById('inspection-result')?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
          block: 'start',
        });
      }, 50);
    } catch (cause) {
      setError(
        cause instanceof TypeError
          ? 'The inspection service could not be reached. Please try again.'
          : cause instanceof Error
            ? cause.message
            : 'The video could not be inspected.',
      );
      setState('error');
    }
  };

  return (
    <>
      <InspectForm
        inputId='youtube-demo-url'
        url={url}
        state={state}
        error={error}
        onUrlChange={setUrl}
        onSubmit={inspectVideo}
      />

      {state === 'loading' ? <InspectionSkeleton /> : null}
      {result ? <InspectionResult result={result} /> : null}
    </>
  );
}

interface FormProps {
  url: string;
  state: 'idle' | 'loading' | 'success' | 'error';
  error: string;
  onUrlChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

function InspectForm({
  inputId,
  url,
  state,
  error,
  onUrlChange,
  onSubmit,
}: FormProps & { inputId: string }) {
  return (
    <>
      <form className='proof-input-card' onSubmit={onSubmit}>
        <div className='proof-form-label'>
          <label htmlFor={inputId}>Try a public YouTube video</label>
          <span>5 distinct videos per 24 hours</span>
        </div>
        <div className='proof-input-row'>
          <input
            id={inputId}
            name='url'
            type='url'
            inputMode='url'
            autoComplete='url'
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder='https://www.youtube.com/watch?v=...'
            required
            disabled={state === 'loading'}
          />
          <button type='submit' disabled={state === 'loading'}>
            {state === 'loading' ? 'Inspecting...' : 'Inspect video'}
            <span aria-hidden='true'>→</span>
          </button>
        </div>
      </form>
      <div className='proof-inline-message' aria-live='polite'>
        {state === 'error' ? <p role='alert'>{error}</p> : null}
      </div>
    </>
  );
}

function InspectionSkeleton() {
  return (
    <section className='inspection-shell inspection-loading' aria-label='Inspecting video' aria-live='polite'>
      <div className='inspection-loading-head'>
        <span className='skeleton-block' />
        <div>
          <span className='skeleton-line skeleton-line-long' />
          <span className='skeleton-line skeleton-line-short' />
        </div>
      </div>
      <div className='inspection-loading-grid'>
        <div className='skeleton-panel' />
        <div className='skeleton-panel' />
      </div>
      <p>Resolving metadata, transcript, and comments…</p>
    </section>
  );
}

function InspectionResult({ result }: { result: DemoResponse }) {
  const thumbnail = [...result.video.thumbnails]
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];

  return (
    <section className='inspection-shell' id='inspection-result' aria-labelledby='inspection-title' aria-live='polite'>
      <header className='inspection-header'>
        <div className='inspection-thumbnail'>
          {thumbnail ? (
            <img src={thumbnail.url} alt='' width={thumbnail.width ?? 480} height={thumbnail.height ?? 270} />
          ) : (
            <span aria-hidden='true'>▶</span>
          )}
        </div>
        <div className='inspection-identity'>
          <p>Inspection ready</p>
          <h2 id='inspection-title'>{result.video.title}</h2>
          <div>
            <a href={result.video.channel.url} target='_blank' rel='noreferrer'>
              {result.video.channel.name}
            </a>
            {result.video.durationText ? <span>{result.video.durationText}</span> : null}
            {result.video.viewCountText ? <span>{result.video.viewCountText}</span> : null}
            {result.video.publishedTimeText ? <span>{result.video.publishedTimeText}</span> : null}
          </div>
        </div>
        <a className='inspection-video-link' href={result.video.url} target='_blank' rel='noreferrer'>
          Open video <span aria-hidden='true'>↗</span>
        </a>
      </header>

      <div className='inspection-grid'>
        <article className='agent-transcript-panel'>
          <header className='inspection-panel-head'>
            <div>
              <p>Timestamped transcript</p>
              <h3>Exact moments, ready to cite</h3>
            </div>
            {result.transcript.status === 'ready' ? (
              <span>{result.transcript.segmentCount.toLocaleString()} segments · {result.transcript.track.languageCode.toUpperCase()}</span>
            ) : null}
          </header>

          {result.transcript.status === 'ready' ? (
            <ol className='transcript-list'>
              {result.transcript.segments.map((segment, index) => (
                <li key={`${segment.startMs}-${index}`}>
                  <a href={timestampUrl(result.video.url, segment.startMs)} target='_blank' rel='noreferrer'>
                    {formatTimestamp(segment.startMs)}
                  </a>
                  <p>{segment.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <UnavailableCopy>Transcript data is not available for this video.</UnavailableCopy>
          )}
        </article>

        <aside className='comments-panel'>
          <header className='inspection-panel-head'>
            <div>
              <p>Audience context</p>
              <h3>Comments around the video</h3>
            </div>
            {result.comments.status === 'ready' && result.comments.totalCount !== undefined ? (
              <span>{result.comments.totalCount.toLocaleString()} total</span>
            ) : null}
          </header>

          {result.comments.status === 'ready' ? (
            result.comments.comments.length ? (
              <ol className='comment-list'>
                {result.comments.comments.map((comment) => (
                  <li key={comment.id}>
                    <header>
                      <b>{comment.author.name}</b>
                      {comment.publishedTimeText ? <span>{comment.publishedTimeText}</span> : null}
                    </header>
                    <p>{comment.text}</p>
                    <footer>
                      {comment.isPinned ? <span>Pinned</span> : null}
                      {comment.isHearted ? <span>Hearted</span> : null}
                      {comment.likeCountText ? <span>{comment.likeCountText} likes</span> : null}
                    </footer>
                  </li>
                ))}
              </ol>
            ) : (
              <UnavailableCopy>No public comments were returned for this video.</UnavailableCopy>
            )
          ) : (
            <UnavailableCopy>Comment data is not available for this video.</UnavailableCopy>
          )}
        </aside>
      </div>

      <footer className='inspection-footer'>
        <div>
          <strong>{result.quota.remaining} of {result.quota.limit}</strong>
          <span> free video inspections remaining</span>
          {result.quota.repeated ? <small>This repeat did not use another slot.</small> : null}
        </div>
        <a href='/dashboard/developer'>
          Build with the <b>YouTube Agent API</b> <span aria-hidden='true'>→</span>
        </a>
      </footer>
    </section>
  );
}

function UnavailableCopy({ children }: { children: React.ReactNode }) {
  return <p className='inspection-unavailable'>{children}</p>;
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function timestampUrl(videoUrl: string, milliseconds: number): string {
  const separator = videoUrl.includes('?') ? '&' : '?';
  return `${videoUrl}${separator}t=${Math.floor(milliseconds / 1000)}s`;
}

function formatReset(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
