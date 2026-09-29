'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/* A replay of what a Video Agent run looks like, built from one real video
 * (the same one the API reference uses). Every count, timestamp, and quote
 * below comes from that video's actual transcript and comments, so the graphic
 * shows the product's shape without inventing a result.
 *
 * Motion is once-per-visit content, so it gets the slow tier: it plays when the
 * figure is half in view, then holds the finished state. The server renders the
 * finished state, so without JS (or with reduced motion) nothing is hidden. */

const VIDEO = {
  title: 'Praggnanandhaa vs Vincent Keymer',
  channel: "agadmator's Chess Channel",
  duration: '14:59',
};

const QUESTION = 'Where did Keymer lose this game?';

const SOURCES = [
  { label: 'Metadata', detail: `title, channel, ${VIDEO.duration}` },
  { label: 'Transcript', detail: '380 segments' },
  { label: 'Frames', detail: '4 moments', frames: 4 },
  { label: 'Comments', detail: '114 comments' },
];

/* The dashboard's own status copy, in order, then the outcome badge. */
const STATUS = [
  'Understanding your request.',
  'Researching YouTube sources.',
  'Writing and checking the answer.',
  'Answered',
];

type Part = string | { t: string };

const ANSWER: Part[][] = [
  [
    'Pragg was better after Keymer gave up an exchange ',
    { t: '4:20' },
    ', but the game was heading for a threefold draw until Qg4 ',
    { t: '7:57' },
    '.',
  ],
  [
    'The loss came late. Keymer missed draws with Nd3 ',
    { t: '10:24' },
    ' and Nf3+ ',
    { t: '11:36' },
    ', then resigned on move 68 ',
    { t: '12:57' },
    '.',
  ],
  ['Viewers agree: a top comment quotes “Vincent is only human” over the missed Nd3.'],
];

/* Step n becomes true at TIMELINE[n - 1] ms. 1: question sent. 2–5: one source
 * each. 6–8: one answer line each. 9: finished. */
const TIMELINE = [300, 900, 1400, 1900, 2400, 3200, 3900, 4600, 5300];
const FINAL = TIMELINE.length;
const FIRST_SOURCE = 2;
const FIRST_LINE = FIRST_SOURCE + SOURCES.length;

function phaseOf(step: number) {
  if (step >= FINAL) return 3;
  if (step >= FIRST_LINE) return 2;
  if (step >= FIRST_SOURCE) return 1;
  return 0;
}

function sourceState(step: number, index: number) {
  const at = FIRST_SOURCE + index;
  return step < at ? 'pending' : step === at ? 'active' : 'done';
}

export function CraftAgentRun() {
  const figure = useRef<HTMLElement>(null);
  const timers = useRef<number[]>([]);
  const [step, setStep] = useState(FINAL);

  const play = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    setStep(0);
    timers.current = TIMELINE.map((at, index) =>
      window.setTimeout(() => setStep(index + 1), at),
    );
  }, []);

  useEffect(() => {
    const node = figure.current;
    if (!node || !('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Arm the replay while the figure is still off screen, so the reset to
    // step 0 is never visible.
    setStep(0);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        play();
      },
      { threshold: 0.45 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      timers.current.forEach(window.clearTimeout);
    };
  }, [play]);

  const phase = phaseOf(step);
  const running = step > 0 && step < FINAL;

  return (
    <figure
      ref={figure}
      className='craft-run'
      data-running={running ? 'true' : 'false'}
    >
      <div className='craft-run-panel'>
        <div className='craft-run-ask' data-on={step >= 1}>
          <span className='craft-run-video'>
            {VIDEO.title} · {VIDEO.duration}
          </span>
          <p>{QUESTION}</p>
        </div>

        <ol className='craft-run-sources' aria-label='Sources read'>
          {SOURCES.map((source, index) => (
            <li key={source.label} data-state={sourceState(step, index)}>
              <b>{source.label}</b>
              <span>{source.detail}</span>
              {source.frames ? (
                <span className='craft-run-frames' aria-hidden='true'>
                  {Array.from({ length: source.frames }, (_, i) => (
                    <i key={i} style={{ '--i': i } as React.CSSProperties} />
                  ))}
                </span>
              ) : null}
              <i className='craft-run-packet' aria-hidden='true' />
            </li>
          ))}
        </ol>

        <div className='craft-run-agent'>
          <span className='craft-run-mark' aria-hidden='true' />
          <b>Video Agent</b>
          <span className='craft-run-status'>
            {STATUS.map((status, index) => (
              <span
                key={status}
                data-on={phase === index}
                aria-hidden={phase === index ? undefined : true}
              >
                {status}
              </span>
            ))}
          </span>
        </div>

        <div className='craft-run-answer'>
          {ANSWER.map((line, index) => (
            <p key={index} data-on={step >= FIRST_LINE + index}>
              {line.map((part, i) =>
                typeof part === 'string' ? (
                  part
                ) : (
                  <time key={i}>{part.t}</time>
                ),
              )}
              <sup>[1]</sup>
            </p>
          ))}
          <footer data-on={step >= FINAL}>
            <span>1 video reviewed</span>
            <span>
              [1] {VIDEO.title}, {VIDEO.channel}
            </span>
          </footer>
        </div>
      </div>

      <figcaption>
        <span>Example built from this video’s real transcript and comments.</span>
        <button type='button' onClick={play} disabled={running}>
          Replay
        </button>
      </figcaption>
    </figure>
  );
}
