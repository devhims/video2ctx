'use client';

import { useReplay } from './use-replay';

/* A replay of a channel monitor catching a new upload and handing it to Video
 * Agent. Built from a real hourly monitor on Theo's channel: the alert, the
 * earlier alerts, and the answer below are what the platform returned, trimmed
 * for length. The check times are relative so the graphic does not go stale. */

const MONITOR = { name: 'Theo - t3.gg', cadence: 'every hour' };

/* Hourly checks; the last one sees a new leading video and raises the alert. */
const CHECKS = ['3h ago', '2h ago', '1h ago', 'Now'];

const ALERT = { title: 'Meta just caught up with Anthropic', duration: '38:02' };

const EARLIER = [
  { title: 'I thought AI was gonna get cheaper?', age: '1 day ago' },
  { title: 'You can rewrite typescript in rust for $420k', age: '3 days ago' },
];

const QUESTION = 'What does he claim, and what do the comments push back on?';

const STATUS = [
  'Understanding your request.',
  'Researching YouTube sources.',
  'Writing and checking the answer.',
  'Answered',
];

type Part = string | { t: string };

const ANSWER: Part[][] = [
  [
    'Meta’s Muse Wonder Full is the first model outside OpenAI and Anthropic to reach the Fable and Astra tier ',
    { t: '0:00' },
    '.',
  ],
  [
    'It is fast and token efficient and can orchestrate sub agents ',
    { t: '16:57' },
    ', but it is weak at UI ',
    { t: '25:11' },
    '.',
  ],
  [
    'The top comment (439 likes) asks “How much did they pay you”. He answers on camera that Meta paid nothing ',
    { t: '1:23' },
    '.',
  ],
];

/* 1: monitor live. 2–5: one check each. 6: alert lands. 7: question sent.
 * 8: agent researching. 9–11: one answer line each. 12: finished. */
const TIMELINE = [200, 700, 1150, 1600, 2100, 2700, 3500, 4000, 4700, 5300, 5900, 6500];
const FIRST_CHECK = 2;
const ALERT_STEP = FIRST_CHECK + CHECKS.length;
const ASK_STEP = ALERT_STEP + 1;
const FIRST_LINE = ASK_STEP + 2;
const FINAL = TIMELINE.length;

function checkState(step: number, index: number) {
  if (step < FIRST_CHECK + index) return 'pending';
  return index === CHECKS.length - 1 ? 'alert' : 'done';
}

function phaseOf(step: number) {
  if (step >= FINAL) return 3;
  if (step >= FIRST_LINE) return 2;
  if (step > ASK_STEP) return 1;
  return 0;
}

export function CraftMonitorRun() {
  const { figure, step, running, play } = useReplay(TIMELINE);
  const phase = phaseOf(step);

  return (
    <figure
      ref={figure}
      className='craft-run craft-monitor'
      data-running={running ? 'true' : 'false'}
    >
      <div className='craft-run-panel craft-monitor-panel'>
        <div className='craft-monitor-watch'>
          <header className='craft-monitor-head' data-on={step >= 1}>
            <span className='craft-monitor-live' aria-hidden='true' />
            <b>Channel monitor</b>
            <span>
              {MONITOR.name} · {MONITOR.cadence}
            </span>
          </header>

          <ol className='craft-monitor-checks' aria-label='Recent checks'>
            {CHECKS.map((at, index) => {
              const state = checkState(step, index);
              return (
                <li key={at} data-state={state}>
                  <i aria-hidden='true' />
                  <span>{at}</span>
                  <b>{index === CHECKS.length - 1 ? 'New video' : 'No change'}</b>
                </li>
              );
            })}
          </ol>

          <ul className='craft-monitor-inbox' aria-label='Notifications'>
            <li data-on={step >= ALERT_STEP} data-new='true'>
              <span>New video from {MONITOR.name}</span>
              <b>{ALERT.title}</b>
              <time>{ALERT.duration}</time>
            </li>
            {EARLIER.map((item) => (
              <li key={item.title}>
                <span>
                  New video from {MONITOR.name} · {item.age}
                </span>
                <b>{item.title}</b>
              </li>
            ))}
          </ul>
        </div>

        <div className='craft-monitor-handoff' data-on={step >= ASK_STEP}>
          <div className='craft-run-ask'>
            <span className='craft-run-video'>
              {ALERT.title} · {ALERT.duration}
            </span>
            <p>{QUESTION}</p>
          </div>

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
                  typeof part === 'string' ? part : <time key={i}>{part.t}</time>,
                )}
                <sup>[1]</sup>
              </p>
            ))}
            <footer data-on={step >= FINAL}>
              <span>1 video reviewed · 4 credits</span>
              <span>
                [1] {ALERT.title}, {MONITOR.name}
              </span>
            </footer>
          </div>
        </div>
      </div>

      <figcaption>
        <span>Example built from a real monitor, its latest alert, and the answer.</span>
        <button type='button' onClick={play} disabled={running}>
          Replay
        </button>
      </figcaption>
    </figure>
  );
}
