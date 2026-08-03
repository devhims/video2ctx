'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const openDashboard = (section: 'trends' | 'discover' = 'trends') => {
    router.push(section === 'trends' ? '/dashboard' : `/dashboard?section=${section}`);
  };

  const submitQuestion = (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    router.push(`/dashboard?section=discover&mode=ask&q=${encodeURIComponent(value)}`);
  };

  return <main className='lens-home'>
    <header className='lens-home-nav'>
      <a className='lens-brand' href='/' aria-label='all things youtube home'><span className='lens-brand-mark' aria-hidden='true'><i /></span><span className='lens-brand-type'><b>all things</b><strong>youtube</strong></span></a>
      <nav aria-label='Homepage links'><button onClick={() => openDashboard('trends')}>Trend lab</button><button onClick={() => openDashboard('discover')}>Research library</button><button className='lens-nav-primary' onClick={() => openDashboard('trends')}>Dashboard <span aria-hidden='true'>↗</span></button></nav>
    </header>

    <section className='lens-hero' aria-labelledby='lens-title'>
      <div className='lens-copy'>
        <div>
          <p className='lens-kicker'><i /> Start with a human question</p>
          <h1 id='lens-title'>Ask what<br />YouTube <em>knows.</em></h1>
          <p className='lens-subtitle'>A unified research layer for videos, channels, transcripts, playlists, and the conversations around them.</p>
        </div>
        <form className='lens-question' onSubmit={submitQuestion}>
          <label htmlFor='lens-question'>Question /</label>
          <input id='lens-question' value={query} onChange={(event) => setQuery(event.target.value)} placeholder='What are creators saying about…' />
          <button disabled={!query.trim()} aria-label='Open the research lens'>↗</button>
        </form>
        <p className='lens-helper'>Ask a question or paste any YouTube video, channel, or playlist URL.</p>
      </div>

      <div className='lens-stage' role='img' aria-label='A YouTube research lens connecting transcripts, channels, playlists, and comments'>
        <div className='lens-grid' aria-hidden='true' />
        <div className='lens-orbits' aria-hidden='true'>
          <div className='lens-orbit orbit-one'><span><b>Transcript</b><small>resolved</small></span></div>
          <div className='lens-orbit orbit-two'><span><b>Channel</b><small>mapped</small></span></div>
          <div className='lens-orbit orbit-three'><span><b>Playlist</b><small>linked</small></span></div>
          <div className='lens-orbit orbit-four'><span><b>Comments</b><small>indexed</small></span></div>
        </div>
        <div className='lens-object-shadow' aria-hidden='true' />
        <div className='lens-object' aria-hidden='true'><i /></div>
      </div>
    </section>

    <section className='lens-premise'>
      <aside><span>What this is</span><b>001</b></aside>
      <div><h2>Turn public video into <em>shared understanding.</em></h2><footer><p>Follow an idea across exact moments, channels, playlists, and audience conversations—then keep every conclusion attached to its evidence.</p><button onClick={() => openDashboard('discover')}>Explore the source layer <span aria-hidden='true'>↗</span></button></footer></div>
    </section>
  </main>;
}
