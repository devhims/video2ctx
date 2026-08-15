'use client';

import { useEffect, useRef, useState } from 'react';

/* N10 — a bar at rest that morphs into a floating pill once the hero is behind
 * you. The morph is motivated rather than decorative: the cinematic band below
 * is dark and full-bleed, and a full-width bar would compete with it.
 *
 * Detection uses a sentinel + IntersectionObserver rather than a scroll
 * listener, so nothing runs on the main thread between thresholds.
 */

/* All three entry points, not just the API. The workspace and the npm package
 * are equal surfaces of the same open-source product. */
const LINKS = [
  { label: 'Workspace', href: '/dashboard' },
  {
    label: 'API reference',
    href: 'https://docs.video2ctx.dev/api-reference/introduction',
  },
  { label: 'npm', href: 'https://www.npmjs.com/package/all-things-youtube' },
  { label: 'API keys', href: '/dashboard/developer' },
];

export function SiteNav() {
  const sentinel = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState(false);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => setFloating(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} className='nav-sentinel' aria-hidden='true' />
      <header className='site-nav' data-floating={floating ? 'true' : 'false'}>
        <div className='site-nav-inner'>
          <a className='lens-brand' href='/' aria-label='video2ctx home'>
            <img src='/brand/logo-120.png' alt='' width='28' height='28' />
            <span>video2ctx</span>
          </a>

          <nav className='site-nav-links' aria-label='Main'>
            {LINKS.map((link) => (
              <a key={link.label} href={link.href}>
                {link.label}
              </a>
            ))}
          </nav>

          <a className='site-nav-cta' href='/dashboard'>
            Open video2ctx
            <span className='site-nav-cta-icon' aria-hidden='true'>
              →
            </span>
          </a>
        </div>
      </header>
    </>
  );
}
