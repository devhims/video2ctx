'use client';

import { GithubLogo, List, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { authClient } from '../../lib/auth-client';

const LINKS = [
  { label: 'Docs', href: 'https://docs.video2ctx.dev' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'FAQs', href: '#faq' },
  { label: 'Installation', href: '#agent-setup' },
  /* Phones drop the GitHub icon from the bar, so it lives in the menu there. */
  { label: 'GitHub', href: 'https://github.com/devhims/video2ctx', phonesOnly: true },
];

export function CraftNav() {
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  return (
    <header className='craft-nav' data-open={open ? 'true' : 'false'}>
      <div className='craft-nav-inner'>
        <div className='craft-nav-identity'>
          <a className='craft-nav-brand' href='/' aria-label='video2ctx home'>
            <img
              src='/brand/logo-120.png'
              alt=''
              width='36'
              height='36'
            />
          </a>
          <a
            className='craft-nav-product-hunt'
            href='https://www.producthunt.com/products/video2ctx?launch=video2ctx'
            target='_blank'
            rel='noopener noreferrer'
            aria-label='View video2ctx on Product Hunt'
            title='View video2ctx on Product Hunt'
          >
            <svg width='20' height='20' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
              <circle cx='12' cy='12' r='12' fill='currentColor' />
              <path d='M8 6h5a4 4 0 0 1 0 8h-2.5v4H8V6Zm2.5 2.5v3H13a1.5 1.5 0 0 0 0-3h-2.5Z' fill='white' />
            </svg>
            <span>Product Hunt</span>
          </a>
        </div>

        <nav
          id='craft-product-links'
          className='craft-nav-links'
          aria-label='Product'
        >
          {LINKS.map((link) => {
            const external = link.href.startsWith('http');
            return (
              <a
                key={link.label}
                href={link.href}
                target={external ? '_blank' : undefined}
                rel={external ? 'noreferrer' : undefined}
                onClick={() => setOpen(false)}
                data-phones-only={link.phonesOnly ? 'true' : undefined}
              >
                {link.label}
              </a>
            );
          })}
        </nav>

        <div className='craft-nav-actions'>
          {/* "Get Started" rather than "Sign in": most visitors here are new,
              and returning users reach the same login page through it. */}
          <a className='craft-nav-account' href={session?.user ? '/dashboard' : '/login'}>
            {session?.user ? 'Dashboard' : 'Get Started'}
          </a>
          <a
            className='craft-nav-github'
            href='https://github.com/devhims/video2ctx'
            target='_blank'
            rel='noreferrer'
            aria-label='Open video2ctx on GitHub'
            title='GitHub'
          >
            <GithubLogo size={18} weight='fill' aria-hidden='true' />
          </a>
          <button
            className='craft-nav-menu'
            type='button'
            aria-label={open ? 'Close navigation' : 'Open navigation'}
            aria-controls='craft-product-links'
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? (
              <X size={17} weight='bold' />
            ) : (
              <List size={18} weight='bold' />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
