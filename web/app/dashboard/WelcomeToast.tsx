'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { isWelcomeVisit, withoutWelcomeParam } from '../../lib/welcome-toast';
import { burstConfetti, whenSettled } from './confetti';

const TOAST_CLASS = 'welcome-toast';

/** Greets an account on the dashboard visit that follows its signup. */
export function WelcomeToast({ name }: { name?: string | null }) {
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current || !isWelcomeVisit(window.location.search)) return;
    shown.current = true;
    window.history.replaceState(window.history.state, '', withoutWelcomeParam(`${window.location.pathname}${window.location.search}${window.location.hash}`));

    const firstName = name?.trim().split(/\s+/)[0];
    toast(firstName ? `Welcome to video2ctx, ${firstName}! 🎉` : 'Welcome to video2ctx! 🎉', {
      id: 'welcome',
      className: TOAST_CLASS,
      description: "1,000 free credits are in your account. Can't wait to see what you build.",
    });

    // Burst from just inside the toast's top edge, centred, once it has slid into
    // place. Not cancelled on cleanup: React's development double-run would drop it.
    whenSettled(`.${TOAST_CLASS}`, (rect) => burstConfetti(rect.left + rect.width / 2, rect.top + 12));
  }, [name]);
  return null;
}
