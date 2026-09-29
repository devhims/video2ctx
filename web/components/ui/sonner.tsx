"use client";

import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

// shadcn's Sonner wrapper, using the dashboard's existing theme tokens.
export function Toaster(props: ToasterProps) {
  return <Sonner
    theme='system'
    position='bottom-right'
    closeButton
    duration={8000}
    style={{
      '--normal-bg': 'var(--color-dashboard-surface)',
      '--normal-text': 'var(--color-dashboard-ink)',
      '--normal-border': 'var(--color-dashboard-rule)',
      '--border-radius': 'var(--radius-dashboard-md)',
      fontFamily: 'var(--font-geist-sans), sans-serif',
    } as CSSProperties}
    {...props}
  />;
}
