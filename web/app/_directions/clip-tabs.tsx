'use client';

import { useLayoutEffect, useRef } from 'react';

/* The clip-path tab strip.
 *
 * The row is rendered twice: once as real buttons, once as a duplicate styled
 * as if every tab were active. The duplicate is clipped to the active tab's box
 * and the clip is animated, so a label changes colour exactly at the moving
 * edge of the pill. Crossfading two text colours never lands that cleanly no
 * matter how the timing is tuned.
 *
 * Used for both the result panel and the code sample — one tab idiom across the
 * page, because cohesion is most of what makes motion feel designed rather than
 * applied.
 */

export interface ClipTab<T extends string> {
  id: T;
  label: string;
}

export function ClipTabs<T extends string>({
  tabs,
  value,
  onChange,
  idPrefix,
  label,
}: {
  tabs: ClipTab<T>[];
  value: T;
  onChange: (next: T) => void;
  idPrefix: string;
  label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  useLayoutEffect(() => {
    const container = listRef.current;
    const active = buttons.current[tabs.findIndex((tab) => tab.id === value)];
    if (!container || !active) return;

    const measure = () => {
      const box = container.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      if (!box.width) return;
      container.style.setProperty('--clip-left', `${((item.left - box.left) / box.width) * 100}%`);
      container.style.setProperty(
        '--clip-right',
        `${((box.right - item.right) / box.width) * 100}%`,
      );
    };

    measure();
    // Fonts landing late or the container reflowing would otherwise leave the
    // pill measured against a stale box.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [tabs, value]);

  /* Arrow-key roving focus, per the tablist pattern. Keyboard-initiated moves
   * still animate here — unlike a command palette this is not a hundred-times-
   * a-day action, so the clip transition stays. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    onChange(next.id);
    buttons.current[tabs.indexOf(next)]?.focus();
  };

  return (
    <div
      className='craft-tablist'
      ref={listRef}
      role='tablist'
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type='button'
          role='tab'
          id={`${idPrefix}-tab-${tab.id}`}
          aria-selected={value === tab.id}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}

      <div className='craft-tablist-active' aria-hidden='true'>
        {tabs.map((tab) => (
          <span key={tab.id}>{tab.label}</span>
        ))}
      </div>
    </div>
  );
}
