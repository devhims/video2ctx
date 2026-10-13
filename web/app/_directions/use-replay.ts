'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/* Shared clock for the homepage's replayed runs (agent, monitor, use cases).
 *
 * Step n becomes true at timeline[n - 1] ms, and the last step is the finished
 * state. The server renders that finished state, so without JS, or with reduced
 * motion, nothing is hidden. With motion, the figure is reset while still off
 * screen and plays once when it is about half in view. */

const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useReplay(timeline: readonly number[]) {
  const figure = useRef<HTMLElement>(null);
  const timers = useRef<number[]>([]);
  const final = timeline.length;
  const [step, setStep] = useState(final);

  const play = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    if (reducedMotion()) {
      setStep(timeline.length);
      return;
    }
    setStep(0);
    timers.current = timeline.map((at, index) =>
      window.setTimeout(() => setStep(index + 1), at),
    );
  }, [timeline]);

  useEffect(() => {
    const node = figure.current;
    // A new timeline (the use cases switch between several) starts finished
    // when it cannot play, so a longer run never strands its last steps.
    if (!node || !('IntersectionObserver' in window) || reducedMotion()) {
      setStep(timeline.length);
      return;
    }

    // Arm the replay while the figure is still off screen, so the reset to
    // step 0 is never visible.
    setStep(0);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        play();
      },
      { threshold: 0.45 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      timers.current.forEach(window.clearTimeout);
    };
  }, [play]);

  return { figure, step, final, running: step > 0 && step < final, play };
}
