'use client';

import { useEffect, useRef, useState } from 'react';
import { mountScrub, shouldScrub } from './scroll-scrub';

/* The scroll-driven decomposition band.
 *
 * Progressive enhancement is the whole structure here. Without JS, without a
 * pointer, or under reduced-motion, this renders as a plain stacked list of six
 * beats that reads correctly top to bottom. When `data-scrub="on"` is set after
 * mount, the same markup becomes a pinned stage with a scrubbed substrate.
 *
 * Every word is DOM. The substrate underneath carries no text at all — which is
 * also why swapping it for generated footage later changes nothing up here.
 */

interface Beat {
  id: string;
  label: string;
  line: string;
}

/* No endpoint paths and no JSON here. The beats are the human argument for why
 * a video is more than its words; the request shapes that deliver them belong in
 * the API reference, and putting them on the stage made the page read as
 * documentation rather than as a product. */
const BEATS: Beat[] = [
  {
    id: 'video',
    label: 'The video',
    line: 'One public URL goes in. Everything below comes back attached to it — not scraped loose from it, not summarised on the way out.',
  },
  {
    id: 'transcript',
    label: 'What was said',
    line: 'Every spoken moment, and the second it happened. Which means an agent can quote the source and point at it, rather than paraphrasing and hoping.',
  },
  {
    id: 'channel',
    label: 'Who said it',
    line: 'The channel behind the video, resolved to a real identity. Provenance is context — it survives the trip into the model.',
  },
  {
    id: 'comments',
    label: 'What the room thought',
    line: 'The audience response underneath, pinned and hearted replies included. Often the most useful thing on the page, and never in the transcript.',
  },
  {
    id: 'playlist',
    label: 'What it belongs to',
    line: 'The series it sits inside, in order. One episode is rarely the whole argument.',
  },
  {
    id: 'search',
    label: 'How you found it',
    line: 'And the way in when you have a question instead of a link — the same context, reached from the other direction.',
  },
];

/** How much the camera settles on each beat instead of gliding past it. */
const LINGER = 0.45;

export function DecompositionCinematic() {
  const trackRef = useRef<HTMLDivElement>(null);
  const [beat, setBeat] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || !shouldScrub()) return;

    setScrubbing(true);

    return mountScrub({
      track,
      beats: BEATS.length,
      linger: LINGER,
      onProgress: (progress, index) => {
        /* Progress is written straight to a custom property rather than through
         * React state — this fires every animation frame, and a setState per
         * frame would re-render the whole band 60 times a second. Only the beat
         * index goes through state, and that changes six times in total. */
        track.style.setProperty('--p', progress.toFixed(4));
        setBeat((current) => (current === index ? current : index));
      },
    });
  }, []);

  return (
    <section
      className='cinematic'
      data-scrub={scrubbing ? 'on' : 'off'}
      aria-labelledby='cinematic-title'
    >
      <div className='cinematic-track' ref={trackRef}>
        <div className='cinematic-pin'>
          <header className='cinematic-head'>
            <p className='cinematic-eyebrow'>Scroll to take it apart</p>
            <h2 id='cinematic-title'>
              One video. Six kinds of context.
            </h2>
          </header>

          <ol className='cinematic-beats'>
            {BEATS.map((item, index) => (
              <li
                key={item.id}
                className='cinematic-beat'
                data-state={
                  !scrubbing ? 'static' : index === beat ? 'active' : index < beat ? 'past' : 'future'
                }
              >
                <p className='cinematic-beat-index'>
                  {String(index + 1).padStart(2, '0')}
                </p>
                <h3>{item.label}</h3>
                <p className='cinematic-beat-line'>{item.line}</p>
              </li>
            ))}
          </ol>

          <DecompositionStage beat={beat} scrubbing={scrubbing} />
        </div>
      </div>
    </section>
  );
}

/* The substrate. Pure CSS geometry driven by the `--p` custom property the
 * engine writes on the track, plus a discrete `data-beat` for the layers that
 * should snap rather than interpolate.
 *
 * When footage replaces this, a <video> goes inside `.stage-frame` and the
 * `.stage-*` layers below it are deleted. Nothing else moves. */
function DecompositionStage({ beat, scrubbing }: { beat: number; scrubbing: boolean }) {
  return (
    <div className='stage' data-beat={beat} aria-hidden='true'>
      <div className='stage-frame'>
        <div className='stage-haze' />

        {/* Beat 1 — the front face peels into timestamped strata. */}
        <div className='stage-strata'>
          {Array.from({ length: 14 }, (_, index) => (
            <i key={index} style={{ '--i': index } as React.CSSProperties} />
          ))}
        </div>

        {/* Beat 2 — the identity plate lifts away. */}
        <div className='stage-plate' />

        {/* Beat 3 — audience response wells up from behind. */}
        <div className='stage-motes'>
          {Array.from({ length: 7 }, (_, index) => (
            <i key={index} style={{ '--i': index } as React.CSSProperties} />
          ))}
        </div>

        {/* Beat 4 — the slab is revealed as one card in a series. */}
        <div className='stage-strip'>
          {Array.from({ length: 5 }, (_, index) => (
            <i key={index} style={{ '--i': index } as React.CSSProperties} />
          ))}
        </div>

        {/* Beat 5 — the series widens into a searchable field. */}
        <div className='stage-field'>
          {Array.from({ length: 24 }, (_, index) => (
            <i key={index} style={{ '--i': index } as React.CSSProperties} />
          ))}
        </div>

        {/* The subject itself, present through every beat. */}
        <div className='stage-slab'>
          <span className='stage-slab-sheen' />
        </div>

        <div className='stage-beam' />
      </div>

      {scrubbing ? (
        <p className='stage-readout'>
          <span>{String(beat + 1).padStart(2, '0')}</span> / {String(BEATS.length).padStart(2, '0')}
        </p>
      ) : null}
    </div>
  );
}
