'use client';

import { FormEvent, useEffect, useState } from 'react';
import { ChecksIcon, CopyIcon } from '@phosphor-icons/react';
import { ClipTabs } from './clip-tabs';
import {
  type DemoResponse,
  type TranscriptSegment,
  describeError,
  formatTimestamp,
  inspect,
  isLandingDemoLimitError,
  transcriptExcerptText,
  timestampUrl,
} from '../_lib/inspect';

/* Direction 02 — the demo IS the page.
 *
 * Motion budget follows the frequency rule: this control is the primary action,
 * so it gets feedback-grade motion only (100–200ms, no decoration). The result
 * below it is seen once per visit, so it is allowed a staggered entrance.
 */

type Tab = 'transcript' | 'comments';

const INSPECTION_STEPS = [
  'Resolving video details',
  'Fetching captions',
  'Reading comments',
  'Exploring channel',
];

const INITIAL_COMMENT_COUNT = 4;
const COMMENT_LOAD_INCREMENT = 4;

export function CraftDemo() {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>(
    'idle',
  );
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [error, setError] = useState('');
  const [limitReached, setLimitReached] = useState(false);
  const [inspectionStep, setInspectionStep] = useState(0);

  useEffect(() => {
    if (state !== 'loading') {
      setInspectionStep(0);
      return;
    }

    const timer = window.setInterval(() => {
      setInspectionStep((current) =>
        Math.min(current + 1, INSPECTION_STEPS.length - 1),
      );
    }, 2000);

    return () => window.clearInterval(timer);
  }, [state]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('loading');
    setError('');
    setLimitReached(false);

    try {
      const payload = await inspect(url);
      setResult(payload);
      setState('done');
    } catch (cause) {
      if (isLandingDemoLimitError(cause)) {
        setLimitReached(true);
      } else {
        setError(describeError(cause));
      }
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
        <button type='submit' data-state={state} disabled={state === 'loading'}>
          <span className='craft-button-label'>
            {state === 'loading'
              ? 'Inspecting'
              : state === 'done'
                ? 'Read again'
                : 'Inspect'}
          </span>
          {state === 'loading' ? (
            <i className='craft-spinner' aria-hidden='true' />
          ) : null}
        </button>
      </form>

      {state === 'loading' ? (
        <InspectionProgress currentStep={inspectionStep} />
      ) : limitReached ? (
        <div className='craft-limit-message' role='alert'>
          <p>
            You have reached the free daily limit. Sign in to get 1,000 free
            credits.
          </p>
          <a href='/dashboard'>Go to dashboard</a>
        </div>
      ) : state === 'error' ? (
        <p className='craft-form-note' aria-live='polite'>
          <span role='alert' className='craft-error'>
            {error}
          </span>
        </p>
      ) : null}

      {result ? <CraftResult key={result.video.id} result={result} /> : null}
    </div>
  );
}

function InspectionProgress({ currentStep }: { currentStep: number }) {
  return (
    <div className='craft-inspection-progress'>
      <p className='craft-progress-live' role='status' aria-live='polite'>
        {INSPECTION_STEPS[currentStep]}
      </p>
      <ol aria-label='Inspection progress'>
        {INSPECTION_STEPS.map((step, index) => (
          <li
            key={step}
            data-state={
              index < currentStep
                ? 'done'
                : index === currentStep
                  ? 'active'
                  : 'pending'
            }
            aria-current={index === currentStep ? 'step' : undefined}
          >
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

function CraftResult({ result }: { result: DemoResponse }) {
  const [tab, setTab] = useState<Tab>('transcript');
  const [visibleCommentCount, setVisibleCommentCount] = useState(
    INITIAL_COMMENT_COUNT,
  );

  const transcript = result.transcript;
  const comments = result.comments;
  const transcriptCount =
    transcript.status === 'ready' ? transcript.segmentCount : 0;
  const commentCount =
    comments.status === 'ready'
      ? (comments.totalCount ?? comments.comments.length)
      : 0;
  const tabs: { id: Tab; label: string }[] = [
    {
      id: 'transcript',
      label: `Transcript ${transcriptCount.toLocaleString()}`,
    },
    { id: 'comments', label: `Comments ${commentCount.toLocaleString()}` },
  ];

  return (
    <section className='craft-result' aria-label='Inspection result'>
      <header className='craft-result-head' style={cascade(0)}>
        <h2>{result.video.title}</h2>
        <p>
          {result.video.viewCountText ? (
            <span>{result.video.viewCountText}</span>
          ) : null}
          {result.video.durationText ? (
            <span>{result.video.durationText}</span>
          ) : null}
          {result.video.publishedTimeText ? (
            <span>{result.video.publishedTimeText}</span>
          ) : null}
          <a href={result.video.url} target='_blank' rel='noreferrer'>
            Open on YouTube
          </a>
        </p>
      </header>

      <div className='craft-source-grid' style={cascade(1)}>
        <VideoPreview video={result.video} />
        <ChannelOverview result={result} />
      </div>

      <div className='craft-tabs' style={cascade(2)}>
        <ClipTabs
          tabs={tabs}
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
        style={cascade(3)}
      >
        {tab === 'transcript' ? (
          transcript.status === 'ready' ? (
            <>
              <div className='craft-panel-heading'>
                <div>
                  <h3>{transcript.track.name}</h3>
                  <p>
                    {transcript.track.languageCode.toUpperCase()} transcript
                    excerpt
                  </p>
                </div>
                <CopyTranscriptButton segments={transcript.segments} />
              </div>
              <ol className='craft-transcript'>
                {transcript.segments.map((segment, index) => (
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
              <p className='craft-more-count'>
                {moreCount(transcript.segmentCount, transcript.segments.length)
                  ? `${moreCount(transcript.segmentCount, transcript.segments.length).toLocaleString()} more segments available`
                  : 'Full transcript returned'}
              </p>
            </>
          ) : (
            <p className='craft-empty'>No captions published for this video.</p>
          )
        ) : null}

        {tab === 'comments' ? (
          comments.status === 'ready' && comments.comments.length ? (
            <>
              <div className='craft-panel-heading'>
                <div>
                  <h3>Audience response</h3>
                  <p>A sample of top-level comments</p>
                </div>
              </div>
              <ol className='craft-comments'>
                {comments.comments
                  .slice(0, visibleCommentCount)
                  .map((comment) => {
                    const avatar = bestThumbnail(
                      comment.author.thumbnails ?? [],
                    );
                    return (
                      <li key={comment.id}>
                        <div className='craft-comment-identity'>
                          {avatar ? (
                            <img
                              src={avatar.url}
                              alt=''
                              width={36}
                              height={36}
                              loading='lazy'
                            />
                          ) : (
                            <span aria-hidden='true'>
                              {comment.author.name.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                          <p className='craft-comment-author'>
                            {comment.author.name}
                            {comment.isPinned ? <b>pinned</b> : null}
                            {comment.isHearted ? <b>hearted</b> : null}
                          </p>
                        </div>
                        <p>{comment.text}</p>
                        <p className='craft-comment-meta'>
                          {comment.publishedTimeText ? (
                            <span>{comment.publishedTimeText}</span>
                          ) : null}
                          {comment.likeCountText ? (
                            <span>{comment.likeCountText} likes</span>
                          ) : null}
                          {comment.replyCount ? (
                            <span>{comment.replyCount} replies</span>
                          ) : null}
                        </p>
                      </li>
                    );
                  })}
              </ol>
              <div className='craft-comments-footer'>
                {visibleCommentCount < comments.comments.length ? (
                  <button
                    className='craft-load-comments'
                    type='button'
                    onClick={() =>
                      setVisibleCommentCount((current) =>
                        Math.min(
                          current + COMMENT_LOAD_INCREMENT,
                          comments.comments.length,
                        ),
                      )
                    }
                  >
                    Load{' '}
                    {Math.min(
                      COMMENT_LOAD_INCREMENT,
                      comments.comments.length - visibleCommentCount,
                    )}{' '}
                    more comments
                  </button>
                ) : null}
                <p className='craft-more-count'>
                  {moreCount(
                    comments.totalCount,
                    Math.min(visibleCommentCount, comments.comments.length),
                  )
                    ? `${moreCount(
                        comments.totalCount,
                        Math.min(visibleCommentCount, comments.comments.length),
                      ).toLocaleString()} more comments available`
                    : 'All returned comments shown'}
                </p>
              </div>
            </>
          ) : (
            <p className='craft-empty'>
              Comments are turned off for this video.
            </p>
          )
        ) : null}
      </div>
    </section>
  );
}

function VideoPreview({ video }: { video: DemoResponse['video'] }) {
  const [playing, setPlaying] = useState(false);
  const thumbnail = bestThumbnail(video.thumbnails);

  return (
    <div className='craft-video-preview'>
      <div className='craft-video-frame'>
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}?autoplay=1&rel=0`}
            title={`Play ${video.title}`}
            allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
            allowFullScreen
          />
        ) : (
          <button
            type='button'
            onClick={() => setPlaying(true)}
            aria-label={`Play ${video.title}`}
          >
            <img
              src={
                thumbnail?.url ??
                `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`
              }
              alt={`Thumbnail for ${video.title}`}
              width={thumbnail?.width ?? 640}
              height={thumbnail?.height ?? 360}
            />
            <span>Play video</span>
          </button>
        )}
      </div>
      <div className='craft-video-facts'>
        {video.viewCountText ? (
          <span>
            <b>{video.viewCountText}</b>Views
          </span>
        ) : null}
        {video.durationText ? (
          <span>
            <b>{video.durationText}</b>Duration
          </span>
        ) : null}
        <span>
          <b>{video.id}</b>Video ID
        </span>
      </div>
    </div>
  );
}

function ChannelOverview({ result }: { result: DemoResponse }) {
  const channel =
    result.channel?.status === 'ready' ? result.channel.channel : null;
  const identity = channel ?? result.video.channel;
  const avatar = channel ? bestThumbnail(channel.thumbnails) : null;
  const info = channel?.about.moreInfo;
  const facts = [
    info?.subscriberCountText
      ? { label: 'Subscribers', value: info.subscriberCountText }
      : null,
    info?.videoCountText
      ? { label: 'Videos', value: info.videoCountText }
      : null,
    info?.viewCountText
      ? { label: 'Channel views', value: info.viewCountText }
      : null,
    info?.joinedDateText
      ? { label: 'Joined', value: info.joinedDateText }
      : null,
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact));

  return (
    <aside className='craft-channel-overview' aria-label='Channel information'>
      <div className='craft-channel-identity'>
        {avatar ? (
          <img src={avatar.url} alt='' width={56} height={56} loading='lazy' />
        ) : (
          <span aria-hidden='true'>
            {identity.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div>
          <p>Channel</p>
          <h3>{identity.name}</h3>
          {channel?.handle ? <p>{channel.handle}</p> : null}
        </div>
      </div>

      {channel?.about.description ? (
        <p className='craft-channel-description'>{channel.about.description}</p>
      ) : (
        <p className='craft-channel-description'>
          Detailed channel information is unavailable for this inspection.
        </p>
      )}

      {facts.length ? (
        <dl className='craft-channel-facts'>
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className='craft-channel-links'>
        <a href={identity.url} target='_blank' rel='noreferrer'>
          View channel
        </a>
        {channel?.about.links.slice(0, 3).map((link) => (
          <a
            key={`${link.title}-${link.url}`}
            href={link.url}
            target='_blank'
            rel='noreferrer'
          >
            {link.title || link.displayUrl}
          </a>
        ))}
      </div>
    </aside>
  );
}

function CopyTranscriptButton({ segments }: { segments: TranscriptSegment[] }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    if (status !== 'copied') return;

    const timer = window.setTimeout(() => setStatus('idle'), 2400);
    return () => window.clearTimeout(timer);
  }, [status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcriptExcerptText(segments));
      setStatus('copied');
    } catch {
      setStatus('error');
    }
  };

  return (
    <button
      className='craft-copy-action'
      type='button'
      onClick={copy}
      data-status={status}
      aria-label={
        status === 'copied' ? 'Transcript copied' : 'Copy transcript excerpt'
      }
      title={
        status === 'copied'
          ? 'Copied'
          : status === 'error'
            ? 'Copy failed'
            : 'Copy transcript'
      }
    >
      <span className='craft-copy-action-icon' aria-hidden='true'>
        <CopyIcon size={17} weight='regular' />
      </span>
      <span className='craft-copy-action-icon' aria-hidden='true'>
        <ChecksIcon size={18} weight='bold' />
      </span>
      <span className='craft-sr' role='status' aria-live='polite'>
        {status === 'copied'
          ? 'Transcript copied'
          : status === 'error'
            ? 'Copy failed'
            : ''}
      </span>
    </button>
  );
}

function bestThumbnail(
  thumbnails: { url: string; width?: number; height?: number }[],
) {
  return [...thumbnails].sort(
    (left, right) =>
      (right.width ?? 0) * (right.height ?? 0) -
      (left.width ?? 0) * (left.height ?? 0),
  )[0];
}

function moreCount(total: number | undefined, shown: number): number {
  return Math.max(0, (total ?? shown) - shown);
}

/** Stagger index. 45ms steps — long enough to read as a cascade, short enough
 *  that the last item is not still arriving after the user has looked at it. */
function cascade(index: number) {
  return { '--i': index } as React.CSSProperties;
}
