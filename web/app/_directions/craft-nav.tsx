'use client';

import { List, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { authClient } from '../../lib/auth-client';

const LINKS = [
  { label: 'Docs', href: 'https://docs.video2ctx.dev' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'FAQ', href: 'https://api.video2ctx.dev/docs#tag/FAQ' },
  { label: 'GitHub', href: 'https://github.com/devhims/video2ctx' },
  { label: 'CLI + Skill', href: '#agent-setup', isNew: true },
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
        <a className='craft-nav-brand' href='/' aria-label='video2ctx home'>
          <img
            src='/brand/logo-120.png'
            alt=''
            width='36'
            height='36'
          />
          <span className='craft-nav-wordmark'>
            video2<span>ctx</span>
          </span>
        </a>

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
              >
                {link.label}
                {link.isNew ? <span className='craft-nav-new'>NEW</span> : null}
              </a>
            );
          })}
        </nav>

        <div className='craft-nav-actions'>
          <a className='craft-nav-account' href='/dashboard'>
            {session?.user ? 'Dashboard' : 'Sign in'}
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
