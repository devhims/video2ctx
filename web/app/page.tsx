'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const researchQuestions = [
  'What are creators saying about AI video tools?',
  'How do these channels disagree on the same topic?',
  'Which ideas repeat across this playlist?',
  'What questions keep appearing in the comments?',
  'Where does this video change the creator’s position?',
];

export default function HomePage() {
  const router = useRouter();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [visibleCharacters, setVisibleCharacters] = useState(0);

  const activeQuestion = researchQuestions[questionIndex];

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    if (prefersReducedMotion) {
      if (visibleCharacters !== activeQuestion.length) {
        setVisibleCharacters(activeQuestion.length);
      }
      return;
    }

    if (visibleCharacters < activeQuestion.length) {
      const typingTimer = window.setTimeout(
        () => setVisibleCharacters((current) => current + 1),
        32,
      );
      return () => window.clearTimeout(typingTimer);
    }

    if (questionIndex < researchQuestions.length - 1) {
      const nextQuestionTimer = window.setTimeout(() => {
        setQuestionIndex((current) => current + 1);
        setVisibleCharacters(0);
      }, 1400);
      return () => window.clearTimeout(nextQuestionTimer);
    }
  }, [activeQuestion, questionIndex, visibleCharacters]);

  const openDashboard = (section: 'trends' | 'discover' = 'trends') => {
    router.push(
      section === 'trends' ? '/dashboard' : `/dashboard?section=${section}`,
    );
  };

  return (
    <main className='lens-home'>
      <header className='lens-home-nav'>
        <a className='lens-brand' href='/' aria-label='video2ctx home'>
          <span className='lens-brand-mark' aria-hidden='true'>
            <img src='/brand/video2ctx-mark-red.svg' alt='' width='32' height='32' />
          </span>
          <span className='lens-brand-type'>
            <strong>video2ctx</strong>
          </span>
        </a>
        <button
          className='lens-nav-primary'
          onClick={() => openDashboard('trends')}
        >
          Dashboard <span aria-hidden='true'>→</span>
        </button>
      </header>

      <section className='lens-map-hero' aria-labelledby='lens-title'>
        <div className='lens-copy'>
          {/* <p className='lens-orientation'>Question → sources → evidence.</p> */}
          <h1 id='lens-title'>Ask what YouTube knows</h1>
          <p className='lens-subtitle'>
            A unified research layer for videos, channels, transcripts,
            playlists, and the conversations around them.
          </p>

          <section
            className='lens-question-showcase'
            aria-label='Example research questions'
          >
            <header className='lens-question-showcase-head' aria-hidden='true'>
              <span>Questions people ask</span>
              <span>
                {String(questionIndex + 1).padStart(2, '0')} /{' '}
                {String(researchQuestions.length).padStart(2, '0')}
              </span>
            </header>
            <p className='lens-question-text' aria-hidden='true'>
              {activeQuestion.slice(0, visibleCharacters)}
            </p>
            <p className='lens-helper'>
              Start with a topic, video, channel, or playlist.
            </p>
            <ol className='sr-only'>
              {researchQuestions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ol>
          </section>

          <nav className='lens-paths' aria-label='Research paths'>
            <button onClick={() => openDashboard('trends')}>
              Trend lab <span aria-hidden='true'>↗</span>
            </button>
            <button onClick={() => openDashboard('discover')}>
              Research library <span aria-hidden='true'>↗</span>
            </button>
          </nav>
        </div>

        <figure className='lens-stage' aria-labelledby='lens-map-caption'>
          {/* <figcaption id='lens-map-caption'>
            Four public source layers, one visible research path.
          </figcaption> */}
          <div className='lens-map' aria-hidden='true'>
            <div className='lens-map-grid' />
            <div className='lens-orbit lens-orbit-transcript'>
              <span className='lens-source-node'>
                <b>Transcript</b>
                <small>resolved</small>
              </span>
            </div>
            <div className='lens-orbit lens-orbit-channel'>
              <span className='lens-source-node'>
                <b>Channel</b>
                <small>mapped</small>
              </span>
            </div>
            <div className='lens-orbit lens-orbit-playlist'>
              <span className='lens-source-node'>
                <b>Playlist</b>
                <small>linked</small>
              </span>
            </div>
            <div className='lens-orbit lens-orbit-comments'>
              <span className='lens-source-node'>
                <b>Comments</b>
                <small>indexed</small>
              </span>
            </div>
            <div className='lens-core'>
              <i />
            </div>
          </div>
        </figure>
      </section>

      <section className='lens-premise' aria-labelledby='lens-premise-title'>
        <header className='lens-premise-head'>
          <h2 id='lens-premise-title'>
            Turn youtube video into shared understanding
          </h2>
          <p>
            Follow an idea across exact moments, channels, playlists, and
            audience conversations—then keep every conclusion attached to its
            evidence.
          </p>
        </header>

        <ol className='lens-workflow'>
          <li>
            <span aria-hidden='true'>01</span>
            <div>
              <h3>Ask</h3>
              <p>Start with a human question or a public YouTube URL.</p>
            </div>
          </li>
          <li>
            <span aria-hidden='true'>02</span>
            <div>
              <h3>Trace</h3>
              <p>
                Move through transcripts, channels, playlists, and audience
                conversations.
              </p>
            </div>
          </li>
          <li>
            <span aria-hidden='true'>03</span>
            <div>
              <h3>Keep</h3>
              <p>
                Carry exact moments and sources forward with every conclusion.
              </p>
            </div>
          </li>
        </ol>

        <button
          className='lens-premise-cta'
          onClick={() => openDashboard('discover')}
        >
          Explore the source layer <span aria-hidden='true'>↗</span>
        </button>
      </section>

      <footer className='lens-home-footer'>
        <p>
          <strong>video2ctx</strong>
          <span>Evidence-first research.</span>
        </p>
        <div>
          <button onClick={() => openDashboard('trends')}>Trend lab</button>
          <button onClick={() => openDashboard('discover')}>
            Research library
          </button>
          <a href='/privacy'>Privacy</a>
          <a href='/terms'>Terms</a>
        </div>
      </footer>
    </main>
  );
}
