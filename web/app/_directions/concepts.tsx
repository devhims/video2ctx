'use client';

/* The three original landing concepts, kept as reference directions.
 *
 * Preserved verbatim in composition and copy — they are the record of what was
 * tried before Craft, and the reason several of its decisions went the way they
 * did. Only the plumbing changed: each concept is now its own entry in the
 * directions registry rather than a `?variant=` switch on a separate /demo
 * route, so there is one place to compare landing work instead of two.
 */
import { FormEvent, useState } from 'react';

type DemoStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

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

function ConceptShell({ hero }: { hero: 'orbit' | 'field' | 'engine' }) {
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

  const mapStatus = (section: 'video' | 'transcript' | 'comments'): DemoStatus => {
    if (state === 'loading') return 'loading';
    if (!result) return 'idle';
    if (section === 'video') return 'ready';
    return result[section].status;
  };

  const heroProps = {
    url,
    state,
    error,
    mapStatus,
    onUrlChange: setUrl,
    onSubmit: inspectVideo,
  };

  return (
    <main className='demo-page'>
      <header className='demo-nav'>
        <a className='demo-brand' href='/' aria-label='video2ctx home'>
          <img src='/brand/logo-120.png' alt='' width='36' height='36' />
          <span>video2ctx</span>
        </a>
        <p>Landing concept</p>
        <a className='demo-nav-cta' href='/'>
          Back to live site <span aria-hidden='true'>↗</span>
        </a>
      </header>

      {hero === 'orbit' ? <OrbitHero {...heroProps} /> : null}
      {hero === 'field' ? <SignalFieldHero {...heroProps} /> : null}
      {hero === 'engine' ? <ContextEngineHero {...heroProps} /> : null}

      {state === 'loading' ? <InspectionSkeleton /> : null}
      {result ? <InspectionResult result={result} /> : null}
    </main>
  );
}

export function OrbitConcept() {
  return <ConceptShell hero='orbit' />;
}

export function SignalFieldConcept() {
  return <ConceptShell hero='field' />;
}

export function ContextEngineConcept() {
  return <ConceptShell hero='engine' />;
}

interface HeroProps {
  url: string;
  state: 'idle' | 'loading' | 'success' | 'error';
  error: string;
  mapStatus: (section: 'video' | 'transcript' | 'comments') => DemoStatus;
  onUrlChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

function OrbitHero(props: HeroProps) {
  return (
    <section className='proof-hero proof-hero-orbit' aria-labelledby='proof-title-a'>
      <div className='proof-copy'>
        <h1 id='proof-title-a'>video2ctx</h1>
        <p className='proof-tagline'>Connect agents to YouTube context.</p>
        <p className='proof-lede'>
          Paste a public video URL for metadata, timestamped transcripts, and audience comments in one request.
        </p>
        <InspectForm {...props} inputId='youtube-demo-url-a' />
      </div>
      <OrbitMap state={props.state} mapStatus={props.mapStatus} />
    </section>
  );
}

function SignalFieldHero(props: HeroProps) {
  return (
    <section className='proof-hero proof-hero-field' aria-labelledby='proof-title-b'>
      <div className='proof-field-map' aria-hidden='true'>
        <OrbitMap state={props.state} mapStatus={props.mapStatus} decorative />
      </div>
      <div className='proof-field-copy'>
        <h1 id='proof-title-b'>video2ctx</h1>
        <p className='proof-tagline'>YouTube context for agents.</p>
        <p className='proof-lede'>
          Inspect a public video, then carry its exact moments and audience response into your agent.
        </p>
      </div>
      <div className='proof-field-form'>
        <InspectForm {...props} inputId='youtube-demo-url-b' />
      </div>
    </section>
  );
}

function ContextEngineHero(props: HeroProps) {
  return (
    <section className='proof-hero proof-hero-engine' aria-labelledby='proof-title-c'>
      <div className='proof-engine-copy'>
        <span className='engine-eyebrow'>YouTube Agent API / Context engine</span>
        <h1 id='proof-title-c'>video2ctx</h1>
        <p className='proof-tagline'>A video in. Context out.</p>
        <p className='proof-lede'>
          Turn one public video into timestamped speech, audience response, and source identity.
        </p>
        <InspectForm {...props} inputId='youtube-demo-url-c' />
      </div>
      <ContextEngineStage state={props.state} mapStatus={props.mapStatus} />
    </section>
  );
}

function ContextEngineStage({
  state,
  mapStatus,
}: {
  state: HeroProps['state'];
  mapStatus: HeroProps['mapStatus'];
}) {
  return (
    <div className='context-engine' data-state={state} aria-hidden='true'>
      <span className='engine-coordinate engine-coordinate-input'>Input / public video</span>
      <span className='engine-coordinate engine-coordinate-output'>Output / structured context</span>
      <div className='engine-grid' />
      <div className='engine-aperture'>
        <i />
        <i />
        <i />
      </div>
      <div className='engine-route engine-route-one' />
      <div className='engine-route engine-route-two' />
      <div className='engine-route engine-route-three' />
      <EngineOutput className='engine-output-transcript' label='Transcript' detail='00:00 → 18:42' status={mapStatus('transcript')} />
      <EngineOutput className='engine-output-channel' label='Channel' detail='source identity' status={mapStatus('video')} />
      <EngineOutput className='engine-output-comments' label='Comments' detail='audience signal' status={mapStatus('comments')} />
      <EngineOutput className='engine-output-playlist' label='Playlist' detail='related surface' status='idle' />
      <EngineOutput className='engine-output-search' label='Search' detail='discovery route' status='idle' />
      <div className='engine-video-slab'>
        <div className='engine-video-topline'>
          <span>Public video</span>
          <span>18:42</span>
        </div>
        <div className='engine-video-visual'>
          <div className='engine-video-signal'>
            <i />
            <span>source</span>
          </div>
          <span className='engine-video-caption'>One video. Every usable signal.</span>
        </div>
        <div className='engine-video-meta'>
          <strong>Video context, for everyone.</strong>
          <span>@source_channel</span>
        </div>
        <div className='engine-video-timeline'>
          <i />
          <b />
        </div>
      </div>
      <div className='engine-scanner'>
        <span>timestamp scan</span>
      </div>
      <div className='engine-stage-state'>
        <i />
        <span>{state === 'loading' ? 'Distilling source' : state === 'success' ? 'Context resolved' : 'System standing by'}</span>
      </div>
    </div>
  );
}

function EngineOutput({
  className,
  label,
  detail,
  status,
}: {
  className: string;
  label: string;
  detail: string;
  status: DemoStatus;
}) {
  return (
    <div className={`engine-output ${className}`} data-status={status}>
      <i />
      <span>
        <b>{label}</b>
        <small>{detail}</small>
      </span>
    </div>
  );
}

function InspectForm({
  inputId,
  url,
  state,
  error,
  onUrlChange,
  onSubmit,
}: HeroProps & { inputId: string }) {
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

function OrbitMap({
  state,
  mapStatus,
  decorative = false,
}: {
  state: HeroProps['state'];
  mapStatus: HeroProps['mapStatus'];
  decorative?: boolean;
}) {
  const sources: Array<{
    key: string;
    label: string;
    status: DemoStatus;
  }> = [
    { key: 'video', label: 'Video', status: mapStatus('video') },
    { key: 'transcript', label: 'Transcript', status: mapStatus('transcript') },
    { key: 'channel', label: 'Channel', status: mapStatus('video') },
    { key: 'comments', label: 'Comments', status: mapStatus('comments') },
  ];

  return (
    <figure className='proof-stage' aria-hidden={decorative || undefined}>
      {!decorative ? <figcaption>Video, transcript, channel, and comments resolve around one source.</figcaption> : null}
      <div className='proof-map'>
        <div className='proof-map-grid' />
        {sources.map((source) => (
          <div className={`proof-orbit proof-orbit-${source.key}`} key={source.key}>
            <SourceNode label={source.label} status={source.status} />
          </div>
        ))}
        <div className='proof-core'>
          <i aria-hidden='true' />
          <small>{state === 'loading' ? 'resolving' : 'video'}</small>
        </div>
      </div>
    </figure>
  );
}

function SourceNode({ label, status }: { label: string; status: DemoStatus }) {
  return (
    <span className='proof-source-node' data-status={status}>
      <b>{label}</b>
      <small>{status === 'idle' ? 'waiting' : status}</small>
    </span>
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
