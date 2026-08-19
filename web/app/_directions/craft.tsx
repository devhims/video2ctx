/* Direction: "Craft" — Hallmark Marquee Hero, motion per emil-design-eng.
 *
 * The bet: the primary action is "inspect a video right there", so the fold is
 * the input and nothing else. The page argues by doing rather than describing,
 * and everything below is a footnote to what you just ran.
 *
 * Motion is budgeted by frequency, which is the organising rule of the whole
 * direction: the control you came to use gets feedback-grade motion only
 * (100–200ms, no decoration); the content seen once per visit gets the
 * staggered entrances and the clip-path reveals.
 */

import { CraftDemo } from './craft-demo';
import { CraftCode } from './craft-code';
import { CraftNav } from './craft-nav';
import { CraftPricing } from './craft-pricing';
import { Flashlight } from './flashlight';
import { FlickeringPixelText } from '../_components/flickering-pixel-text';
import { ArrowRight } from '@phosphor-icons/react/ssr';

const PARTS = [
  { name: 'Transcript', detail: 'every line, and the second it was said' },
  { name: 'Channel', detail: 'who published it, as a resolvable identity' },
  { name: 'Comments', detail: 'the audience underneath, pinned state intact' },
  { name: 'Playlist', detail: 'the series it sits in, in order' },
  { name: 'Search', detail: 'the way in when you have a question, not a link' },
];

/* Each route has a distinct boundary. Skills hold agent guidance, the CLI and
 * hosted platform skill form one complementary setup, and the npm package is the
 * direct TypeScript library. */
const WAYS = [
  {
    label: 'YouTube Direct',
    body: 'Install the skills and agents can handle one-off public YouTube requests directly. No CLI, account, API key, or hosted service is required.',
    action: 'Browse the skills',
    href: 'https://github.com/devhims/video2ctx/tree/main/.agents/skills',
  },
  {
    label: 'CLI + Skill',
    body: 'Install both for hosted agent work. The CLI handles browser authentication and stable commands; the skills provide routing and workflow guidance.',
    action: '@video2ctx/cli',
    href: 'https://www.npmjs.com/package/@video2ctx/cli',
  },
  {
    label: 'Hosted API',
    body: 'Normalised JSON with the source links intact. Bearer auth, versioned under /v1.',
    action: 'Read the reference',
    href: 'https://docs.video2ctx.dev/api-reference/introduction',
  },
  {
    label: 'NPM Package',
    body: 'A server-side TypeScript client for YouTube data, with no hosted service in the path.',
    action: 'all-things-youtube',
    href: 'https://www.npmjs.com/package/all-things-youtube',
  },
  {
    label: 'Workspace',
    body: 'Collect moments into projects, ask questions across them, and monitor channels over time.',
    action: 'Open the dashboard',
    href: '/dashboard',
  },
];

/* Plain-language trust, no invented metrics and no header names. */
const TRUST = [
  {
    title: 'Every moment keeps its source',
    body: 'A transcript segment says what was said and when. Each one links back to that second in the video, so you can play it and hear it for yourself.',
  },
  {
    title: 'Missing data says so',
    body: 'Plenty of videos have comments switched off or no captions at all. You are told that plainly, rather than getting an empty result you have to interpret.',
  },
  {
    title: 'Nothing is locked in',
    body: 'Apache 2.0, and the workspace and API are one codebase. Use the hosted version, install the package, or run all of it yourself.',
  },
  {
    title: 'YouTube first, not YouTube only',
    body: 'Provider routes are namespaced, so a second source slots in beside YouTube instead of changing the shape of what you already handle.',
  },
];

export function CraftDirection() {
  return (
    <main className='craft'>
      <CraftNav />

      <section className='craft-fold'>
        {/* Fold scene. A pre-rendered still rather than a canvas: at this
            opacity nothing is gained by generating it at runtime, and a static
            image costs no main-thread time on the one screen where the input
            must become usable as fast as possible. */}
        <div className='voxel-field'>
          {/* On pointer desktops, use the video's own poster as the first paint.
              The video reuses the same URL, so the browser does not also transfer
              the separate 90 KB horizon still. Touch and reduced-motion devices
              retain their purpose-built static compositions. */}
          <picture className='voxel-base'>
            <source
              media='(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)'
              srcSet='/scene/fold-scene-poster.webp'
            />
            <source
              media='(orientation: portrait) and (max-width: 900px)'
              srcSet='/scene/voxel-horizon-portrait.webp'
            />
            <source
              media='(max-width: 1100px)'
              srcSet='/scene/voxel-horizon-900.webp'
            />
            <img
              src='/scene/voxel-horizon.webp'
              alt=''
              width={1672}
              height={941}
              decoding='async'
            />
          </picture>
          <Flashlight />
        </div>
        <a className='craft-build-cta' href='https://docs.video2ctx.dev/'>
          <span>Get Started</span>
          <span className='craft-build-cta-icon' aria-hidden='true'>
            <ArrowRight size={12} weight='bold' />
          </span>
        </a>
        <h1>
          Video in.{' '}
          <FlickeringPixelText className='craft-context-word'>
            Context
          </FlickeringPixelText>{' '}
          Out.
        </h1>
        <p className='craft-sub'>
          Everything your agent needs to understand videos.
          <br />
          100% open source.
        </p>
        <CraftDemo />
      </section>

      <div className='craft-reveal'>
        <section className='craft-parts' aria-labelledby='craft-parts-title'>
          <h2 id='craft-parts-title'>What is video2ctx?</h2>
          <p className='craft-parts-intro'>
            video2ctx is an open-source toolkit for connecting AI agents to
            video data. Give it a YouTube URL and it returns transcripts,
            frames, comments, playlists, channel details, and metadata as
            structured context, with timestamps and links back to the source.
          </p>
          <p className='craft-parts-integrations'>
            Start with the skills for direct work. Pair them with the{' '}
            <b>@video2ctx/cli</b> for authenticated hosted operations, or use
            the <b>all-things-youtube</b> npm package from server-side
            TypeScript.
          </p>
          <h3>What comes back</h3>
          <ul>
            {PARTS.map((part, index) => (
              <li
                key={part.name}
                style={{ '--i': index } as React.CSSProperties}
              >
                <b>{part.name}</b>
                <span>{part.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className='craft-reveal'>
        <section
          id='agent-setup'
          className='craft-band craft-agent-setup'
          aria-labelledby='craft-code-title'
        >
          <div className='craft-band-head'>
            <h2 id='craft-code-title'>Install once. Pick the right route.</h2>
            <p>
              YouTube Direct needs only the skill. Hosted agent work pairs the
              CLI with the skills. Applications can use the API or npm library.
            </p>
          </div>
          <CraftCode />
        </section>
      </div>

      <div className='craft-reveal'>
        <section className='craft-band' aria-labelledby='craft-ways-title'>
          <div className='craft-band-head'>
            <h2 id='craft-ways-title'>Choose your route.</h2>
            <p>
              Each surface has a clear job, whether an agent, application, or
              person is doing the work.
            </p>
          </div>
          <ul className='craft-ways'>
            {WAYS.map((way, index) => (
              <li
                key={way.label}
                style={{ '--i': index } as React.CSSProperties}
              >
                <h3>{way.label}</h3>
                <p>{way.body}</p>
                <a href={way.href}>
                  {way.action}
                  <span aria-hidden='true'>→</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className='craft-reveal'>
        <CraftPricing />
      </div>

      <div className='craft-reveal'>
        <section className='craft-band' aria-labelledby='craft-trust-title'>
          <div className='craft-band-head'>
            <h2 id='craft-trust-title'>Context you can check.</h2>
          </div>
          <dl className='craft-trust'>
            {TRUST.map((item, index) => (
              <div
                key={item.title}
                style={{ '--i': index } as React.CSSProperties}
              >
                <dt>{item.title}</dt>
                <dd>{item.body}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <div className='craft-reveal'>
        <section className='craft-close' aria-labelledby='craft-close-title'>
          <h2 id='craft-close-title'>Built to be cited, not scraped.</h2>
          <p>
            Every segment keeps the timestamp it came from, so an agent can
            point at the source instead of paraphrasing it.
          </p>
          <div className='craft-actions'>
            <a className='craft-primary' href='/dashboard'>
              Open the workspace
            </a>
            <a className='craft-secondary' href='/dashboard/developer'>
              Get an API key
            </a>
          </div>
        </section>
      </div>

      {/* Ft4 — dense typographic colophon. */}
      <footer className='craft-colophon'>
        <p>
          <b>video2ctx</b> - turn videos into context for LLMs and agents.
          YouTube first, not YouTube only. Apache 2.0.
        </p>
        <p>
          <a href='/privacy'>Privacy</a> · <a href='/terms'>Terms</a> ·{' '}
          <a href='#pricing'>Pricing</a> ·{' '}
          <a href='https://docs.video2ctx.dev/api-reference/introduction'>
            API reference
          </a>{' '}
          ·{' '}
          <a href='https://www.npmjs.com/package/@video2ctx/cli'>
            @video2ctx/cli
          </a>{' '}
          ·{' '}
          <a href='https://www.npmjs.com/package/all-things-youtube'>
            all-things-youtube
          </a>
        </p>
      </footer>
    </main>
  );
}
