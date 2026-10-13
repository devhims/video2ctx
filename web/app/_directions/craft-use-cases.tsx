'use client';

import { useState } from 'react';
import { ClipTabs } from './clip-tabs';
import { useReplay } from './use-replay';

/* Three jobs people actually bring, each replayed from real Video Agent runs:
 * reading values off the screen of a Blender tutorial, turning a Karpathy
 * lecture into notes, and comparing the three most viewed Claude Code
 * tutorials. Answers are trimmed for length, never invented. The figure reuses
 * the agent run's parts (ask, sources, status bar, answer) so the page keeps one
 * visual idiom.
 *
 * The on-screen case is the lead because it is the one a transcript cannot do:
 * every focal length below appears only in the frames, never in the narration.
 * Its readings come from two runs (six frames ten seconds apart, then five
 * targeted ones around the change) and agree with a third, earlier run. */

type CaseId = 'see' | 'learn' | 'research';

type Part = string | { t: string };

interface Source {
  label: string;
  detail: string;
  /* A storyboard contact sheet: total tiles, and the tiles pulled as frames. */
  sheet?: { tiles: number; picked: number[] };
  frames?: number;
}

interface UseCase {
  label: string;
  context: string;
  ask: string;
  sources: Source[];
  lines: { parts: Part[]; cite: string }[];
  footer: [string, string];
}

const STATUS = [
  'Understanding your request.',
  'Researching YouTube sources.',
  'Writing and checking the answer.',
  'Answered',
];

const CASES: Record<CaseId, UseCase> = {
  see: {
    label: 'Read the screen',
    context: 'How to adjust camera focal length in Blender · ENORMOUS · 1:11',
    ask: 'What focal length does the Lens panel show, and when does it change? Use the frames, not the narration.',
    sources: [
      {
        label: 'Storyboard',
        detail: '72 tiles, one per second',
        // The seconds pulled as full frames across both runs: every ten
        // seconds from 0:05, then 0:46 to 0:58 to settle the change.
        sheet: { tiles: 72, picked: [5, 15, 25, 35, 45, 46, 48, 50, 52, 55, 58] },
      },
      { label: 'Frames', detail: '11 read in full', frames: 6 },
      { label: 'Transcript', detail: '30 lines, no numbers' },
    ],
    lines: [
      { parts: ['Before the edit, the Lens panel reads 51.13 mm ', { t: '0:05' }], cite: '[1]' },
      { parts: ['After the change in the Camera tab, it holds at 50 mm ', { t: '0:25' }, ' to ', { t: '0:48' }], cite: '[1]' },
      { parts: ['Dragging the viewport handle swings it to 67.75 mm ', { t: '0:50' }, ', then back to 49.82 mm ', { t: '0:52' }], cite: '[1]' },
      { parts: ['None of these values is spoken. They appear only on screen.'], cite: '[1]' },
    ],
    footer: ['1 video · 11 frames · 6 credits', '[1] How to adjust camera focal length in Blender, ENORMOUS'],
  },
  learn: {
    label: 'Learn from a lecture',
    context: 'Building makemore Part 2: MLP · Andrej Karpathy · 1:15:40',
    ask: 'Turn this lecture into study notes, with the timestamp where each idea is taught.',
    sources: [
      { label: 'Metadata', detail: 'title, channel, 1:15:40' },
      { label: 'Transcript', detail: '2,147 segments' },
    ],
    lines: [
      { parts: ['Builds an MLP character-level language model, following Bengio et al. 2003 ', { t: '1:49' }], cite: '[1]' },
      { parts: ['Embeds each of the 27 characters in a learned lookup table ', { t: '12:19' }], cite: '[1]' },
      { parts: ['Concatenates the embeddings into a tanh hidden layer, then 27 logits ', { t: '18:37' }], cite: '[1]' },
      { parts: ['Trains on mini-batches with cross-entropy ', { t: '37:58' }, ', then splits train, dev, and test ', { t: '54:42' }], cite: '[1]' },
    ],
    footer: ['1 video reviewed', '[1] Building makemore Part 2: MLP, Andrej Karpathy'],
  },
  research: {
    label: 'Compare tutorials',
    context: 'The three most viewed Claude Code tutorials · 3.6M views',
    ask: 'What do they tell a beginner to do first, and where do they disagree?',
    sources: [
      { label: 'Tech With Tim', detail: '35:49 · 1.8M views' },
      { label: 'Kevin Stratvert', detail: '14:44 · 946K views' },
      { label: 'The Coding Sloth', detail: '22:31 · 883K views' },
    ],
    lines: [
      { parts: ['All three: install it, run claude in your project, and sign in.'], cite: '[1][2][3]' },
      { parts: ['Two of three: set up Git early, so you can roll back a bad change.'], cite: '[1][2]' },
      { parts: ['They split on CLAUDE.md: one starts with /init, another writes it by hand because /init misses the stack.'], cite: '[2][3]' },
      { parts: ['Each picks a different home: the terminal, VS Code, or an IDE.'], cite: '[1][2][3]' },
    ],
    footer: ['3 videos reviewed · 3 credits', '[1] Tech With Tim [2] Kevin Stratvert [3] The Coding Sloth'],
  },
};

const IDS = Object.keys(CASES) as CaseId[];
const TABS = IDS.map((id) => ({ id, label: CASES[id].label }));

/* 1: ask. Then one step per source (500ms apart), one per answer line (600ms
 * apart), and the finish. */
function timelineFor(item: UseCase) {
  const sources = item.sources.length;
  return Array.from({ length: 1 + sources + item.lines.length + 1 }, (_, i) =>
    i <= sources ? 250 + i * 500 : 250 + sources * 500 + (i - sources) * 600,
  );
}

const TIMELINES = Object.fromEntries(
  IDS.map((id) => [id, timelineFor(CASES[id])]),
) as Record<CaseId, number[]>;

export function CraftUseCases() {
  const [active, setActive] = useState<CaseId>('see');

  return (
    <div className='craft-cases'>
      <div className='craft-code-head'>
        <ClipTabs
          tabs={TABS}
          value={active}
          onChange={setActive}
          idPrefix='craft-cases'
          label='Use cases'
        />
      </div>
      <CaseRun key={active} id={active} />
    </div>
  );
}

function CaseRun({ id }: { id: CaseId }) {
  const item = CASES[id];
  const { figure, step, final, running, play } = useReplay(TIMELINES[id]);
  const firstSource = 2;
  const firstLine = firstSource + item.sources.length;
  const phase = step >= final ? 3 : step >= firstLine ? 2 : step >= firstSource ? 1 : 0;

  return (
    <figure
      ref={figure}
      className='craft-run craft-case'
      data-running={running ? 'true' : 'false'}
      role='tabpanel'
      id={`craft-cases-panel-${id}`}
      aria-labelledby={`craft-cases-tab-${id}`}
    >
      <div className='craft-run-panel'>
        <div className='craft-run-ask'>
          <span className='craft-run-video'>{item.context}</span>
          <p>{item.ask}</p>
        </div>

        <ol
          className='craft-run-sources'
          aria-label='Sources read'
          style={{ '--count': item.sources.length } as React.CSSProperties}
        >
          {item.sources.map((source, index) => {
            const at = firstSource + index;
            const state = step < at ? 'pending' : step === at ? 'active' : 'done';
            return (
              <li key={source.label} data-state={state}>
                <b>{source.label}</b>
                <span>{source.detail}</span>
                {source.sheet ? <Sheet {...source.sheet} /> : null}
                {source.frames ? (
                  <span className='craft-run-frames craft-case-frames' aria-hidden='true'>
                    {Array.from({ length: source.frames }, (_, i) => (
                      <i key={i} style={{ '--i': i } as React.CSSProperties} />
                    ))}
                  </span>
                ) : null}
                <i className='craft-run-packet' aria-hidden='true' />
              </li>
            );
          })}
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
          {item.lines.map((line, index) => (
            <p key={index} data-on={step >= firstLine + index}>
              {line.parts.map((part, i) =>
                typeof part === 'string' ? part : <time key={i}>{part.t}</time>,
              )}
              <sup>{line.cite}</sup>
            </p>
          ))}
          <footer data-on={step >= final}>
            <span>{item.footer[0]}</span>
            <span>{item.footer[1]}</span>
          </footer>
        </div>
      </div>

      <figcaption>
        <span>Replayed from real runs. Answers are trimmed, not invented.</span>
        <button type='button' onClick={play} disabled={running}>
          Replay
        </button>
      </figcaption>
    </figure>
  );
}

/* The storyboard as a contact sheet: every tile is one second of video. The
 * tiles scan in while the storyboard is read, and the seconds the agent chose
 * to pull as full frames stay lit once the frames step runs. */
function Sheet({ tiles, picked }: { tiles: number; picked: number[] }) {
  const chosen = new Set(picked);
  return (
    <span className='craft-case-sheet' aria-hidden='true'>
      {Array.from({ length: tiles }, (_, i) => (
        <i
          key={i}
          data-picked={chosen.has(i) ? 'true' : undefined}
          style={{ '--i': i } as React.CSSProperties}
        />
      ))}
    </span>
  );
}
