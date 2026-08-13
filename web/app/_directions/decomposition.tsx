/* Direction: "Decomposition" — Hallmark Feature Stack.
 *
 * The first contender, kept verbatim so the comparison has a real baseline.
 * It is NOT the chosen answer; it sits at /explore/decomposition alongside the
 * others until one is picked and promoted.
 */

import { Suspense } from 'react';
import { LandingDemo } from '../_components/landing-demo';
import { DecompositionCinematic } from '../_components/decomposition-cinematic';
import { SiteNav } from '../_components/site-nav';

/* Everything except the inspect form and the cinematic stage is server-rendered.
 * The headline and lede used to sit inside a client component, which put the
 * LCP element behind hydration for no reason. */

/* The API is one surface of three. Naming all three in the hero is what stops
 * the page reading as an API-only product — the workspace and the npm package
 * are equal entry points, and the whole thing is self-hostable. */
const WAYS_IN = [
  { label: 'Research workspace', name: 'Open the dashboard', href: '/dashboard' },
  {
    label: 'Hosted API',
    name: 'docs.video2ctx.dev',
    href: 'https://docs.video2ctx.dev/api-reference/introduction',
  },
  { label: 'TypeScript package', name: 'all-things-youtube', href: 'https://www.npmjs.com/package/all-things-youtube' },
];

/* The experience, not the endpoint list. These four stages are what the product
 * actually does once a video has been taken apart — inspect, collect, ask,
 * monitor — and they map to real surfaces (projects, imports, answers,
 * monitors) rather than aspiration. */
const WORKFLOW = [
  {
    stage: 'Inspect',
    title: 'Start with one video',
    body: 'Paste a URL. Everything around it comes back together — the words, who published it, what the audience said, the series it belongs to.',
  },
  {
    stage: 'Collect',
    title: 'Keep the exact moment',
    body: 'Save the segments that matter into a private project, with the timestamp intact. Not a summary of the video — the part of it you actually needed.',
  },
  {
    stage: 'Ask',
    title: 'Get answers you can check',
    body: 'Ask questions across everything you have collected. Answers come back citing the moment they came from, so you can play the source and confirm it.',
  },
  {
    stage: 'Monitor',
    title: 'Watch it change',
    body: 'Follow channels and topics over time, compare which are gaining ground, and export the research when you need it somewhere else.',
  },
];

/* Reasons to trust it, in plain language. Deliberately no adoption counts, no
 * speed multiples, no invented metrics — and no header names or response shapes
 * either; those belong in the API reference, not on a landing page. */
const GUARANTEES = [
  {
    title: 'Every moment keeps its source',
    body: 'A transcript segment does not only say what was said — it says when. Each one links back to that second in the video, so you can play it and hear it for yourself.',
  },
  {
    title: 'Missing data says so',
    body: 'Plenty of videos have comments switched off or no captions at all. You are told that plainly, instead of getting an empty result you have to interpret.',
  },
  {
    title: 'Try it without an account',
    body: 'Five videos a day, no sign-up, no key. Re-checking one you have already looked at does not use up another.',
  },
  {
    title: 'Nothing is locked in',
    body: 'Apache 2.0, and the workspace and API are the same codebase — so you can use the hosted version, install the package, or run the whole thing yourself.',
  },
];

export function DecompositionDirection() {
  return (
    <main className='lens-home'>
      <SiteNav />

      <section className='hero' aria-labelledby='hero-title'>
        <div className='hero-copy'>
          {/* Kept from the Context-engine prototype — the most compressed line the
              project has. It sits above the headline rather than below it, so the
              hero still carries one display statement instead of two. */}
          <p className='hero-eyebrow'>A video in. Context out.</p>
          <h1 id='hero-title'>A video is more than a transcript.</h1>
          <p className='hero-lede'>
            Inspect a public video, then carry its exact moments, channel identity, and audience
            response into your agent — or into a research project you keep. Open source, and yours
            to run.
          </p>

          <Suspense fallback={null}>
            <LandingDemo />
          </Suspense>

          <ul className='hero-ways' aria-label='Ways to use video2ctx'>
            {WAYS_IN.map((way) => (
              <li key={way.label}>
                <a href={way.href}>
                  <span className='hero-way-label'>{way.label}</span>
                  <span className='hero-way-name'>{way.name}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className='hero-aside' aria-hidden='true'>
          <div className='hero-slab'>
            <span className='hero-slab-sheen' />
          </div>
          <p className='hero-hint'>Scroll to take it apart</p>
        </div>
      </section>

      <DecompositionCinematic />

      <section className='workflow' aria-labelledby='workflow-title'>
        <header className='band-head'>
          <p className='band-eyebrow'>The shape of the work</p>
          <h2 id='workflow-title'>From one video to something you can cite.</h2>
          <p className='band-lede'>
            The same four steps whether you are clicking through the workspace, calling the API, or
            running the whole thing yourself.
          </p>
        </header>

        <ol className='workflow-steps'>
          {WORKFLOW.map((step, index) => (
            <li key={step.stage}>
              <p className='workflow-stage'>
                <span>{String(index + 1).padStart(2, '0')}</span> {step.stage}
              </p>
              <h3>{step.title}</h3>
              <p className='workflow-body'>{step.body}</p>
            </li>
          ))}
        </ol>

        <p className='workflow-note'>
          Every route, request shape, and error is documented in the{' '}
          <a href='https://docs.video2ctx.dev/api-reference/introduction'>
            API reference
          </a>
          .
        </p>
      </section>

      <section className='guarantees' aria-labelledby='guarantees-title'>
        <header className='band-head'>
          <p className='band-eyebrow'>What you can rely on</p>
          <h2 id='guarantees-title'>Context agents can verify.</h2>
          <p className='band-lede'>
            YouTube is the first source it supports, and deliberately not the last.
          </p>
        </header>

        <dl className='guarantee-list'>
          {GUARANTEES.map((item) => (
            <div key={item.title}>
              <dt>{item.title}</dt>
              <dd>{item.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className='lens-home-footer'>
        <p className='footer-statement'>
          Stop scraping videos. Start citing them.
        </p>
        <div className='footer-meta'>
          <a className='footer-cta' href='/dashboard'>
            Open video2ctx <span aria-hidden='true'>→</span>
          </a>
          <nav aria-label='Legal'>
            <a href='/privacy'>Privacy</a>
            <a href='/terms'>Terms</a>
          </nav>
          <p>
            <strong>video2ctx</strong>
          </p>
        </div>
      </footer>
    </main>
  );
}
