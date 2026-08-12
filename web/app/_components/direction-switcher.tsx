'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { DIRECTIONS } from '../_directions/registry';

/* A fixed pill for moving between contenders without going back to the index.
 * Arrow keys work too, so directions can be flicked through and compared from
 * the same scroll position rather than judged one at a time.
 *
 * Only ever rendered under /explore, so it cannot leak onto the live homepage.
 */

export function DirectionSwitcher({ current }: { current: string }) {
  const router = useRouter();
  const index = DIRECTIONS.findIndex((direction) => direction.slug === current);

  useEffect(() => {
    const move = (step: number) => {
      const next = DIRECTIONS[(index + step + DIRECTIONS.length) % DIRECTIONS.length];
      router.push(`/explore/${next.slug}`, { scroll: false });
    };

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowRight') move(1);
      if (event.key === 'ArrowLeft') move(-1);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, router]);

  if (index < 0) return null;
  const previous = DIRECTIONS[(index - 1 + DIRECTIONS.length) % DIRECTIONS.length];
  const next = DIRECTIONS[(index + 1) % DIRECTIONS.length];

  return (
    <nav className='direction-switcher' aria-label='Landing page directions'>
      <a href={`/explore/${previous.slug}`} aria-label='Previous direction'>
        ←
      </a>
      <span>
        <b>{DIRECTIONS[index].name}</b>
        <small>
          {index + 1} of {DIRECTIONS.length}
        </small>
      </span>
      <a href={`/explore/${next.slug}`} aria-label='Next direction'>
        →
      </a>
      <a className='direction-switcher-index' href='/explore'>
        All
      </a>
    </nav>
  );
}
