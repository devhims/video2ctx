'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { isWelcomeVisit, welcomeMessage, withoutWelcomeParam } from '../../lib/welcome-toast';
import { burstConfetti, whenSettled } from './confetti';
import { useAccountResource } from './DashboardDataProvider';

const TOAST_CLASS = 'welcome-toast';

/** Greets an account on the dashboard visit that follows its signup. */
export function WelcomeToast({ name }: { name?: string | null }) {
  const { data: usage, ready, error } = useAccountResource('usage', null);
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current || !isWelcomeVisit(window.location.search)) return;
    if (!ready && !error) return;
    shown.current = true;
    window.history.replaceState(window.history.state, '', withoutWelcomeParam(`${window.location.pathname}${window.location.search}${window.location.hash}`));

    const message = welcomeMessage(name, usage?.plan === 'starter' ? usage.includedCredits : null);
    toast(message.title, {
      id: 'welcome',
      className: TOAST_CLASS,
      description: message.description,
    });

    // Burst from just inside the toast's top edge, centred, once it has slid into
    // place. Not cancelled on cleanup: React's development double-run would drop it.
    whenSettled(`.${TOAST_CLASS}`, (rect) => burstConfetti(rect.left + rect.width / 2, rect.top + 12));
  }, [name, usage, ready, error]);
  return null;
}
