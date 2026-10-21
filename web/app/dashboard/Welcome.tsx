'use client';

import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { isWelcomeVisit, withoutWelcomeParam } from '../../lib/welcome-toast';
import { burstConfetti, whenSettled } from './confetti';
import { WelcomeOnboarding } from './WelcomeOnboarding';

const TOAST_CLASS = 'welcome-toast';

/** Onboards an account on the dashboard visit that follows its signup, then greets it. */
export function Welcome({ name }: { name?: string | null }) {
  // Read during render, so the server sends the onboarding with the page instead of the dashboard flashing first.
  const searchParams = useSearchParams();
  const [onboarding, setOnboarding] = useState(() => isWelcomeVisit(searchParams.toString()));
  const greeted = useRef(false);

  const finish = useCallback(() => {
    if (greeted.current) return;
    greeted.current = true;
    setOnboarding(false);
    window.history.replaceState(window.history.state, '', withoutWelcomeParam(`${window.location.pathname}${window.location.search}${window.location.hash}`));

    const firstName = name?.trim().split(/\s+/)[0];
    toast(firstName ? `Welcome to video2ctx, ${firstName}! 🎉` : 'Welcome to video2ctx! 🎉', {
      id: 'welcome',
      className: TOAST_CLASS,
      description: "Your $10 launch gift is ready. We've added 5,000 free credits to your account.",
    });

    // Burst from just inside the toast's top edge, centred, once it has slid into place.
    whenSettled(`.${TOAST_CLASS}`, (rect) => burstConfetti(rect.left + rect.width / 2, rect.top + 12));
  }, [name]);

  return onboarding ? <WelcomeOnboarding onDone={finish} /> : null;
}
