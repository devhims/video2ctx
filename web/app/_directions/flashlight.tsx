'use client';

import { useEffect, useRef } from 'react';

/* A flashlight over the scene.
 *
 * The landscape rests almost unlit. A soft circular light tracks the pointer
 * and the terrain inside it comes up out of the dark — so the scene stays sharp
 * everywhere and the effect is carried entirely by light, with no quantised or
 * degraded resting state to apologise for.
 *
 * Deliberately not WebGL. Canvas UI's dither components are the obvious
 * off-the-shelf answer, but they are built on the experimental html-in-canvas
 * API to process *live DOM*; against a static image that is an experimental
 * dependency bought for nothing, and their own fallback is that the effect
 * simply does not run. Two layers and two transforms get the same result
 * everywhere.
 *
 * Every per-frame write is a `transform` set directly on an element — never a
 * custom property on a shared parent, which would recalculate styles for the
 * whole subtree on every pointer move.
 */

/** Per-frame approach rate. Lower trails further behind the cursor. */
const EASE = 0.18;
/** Below this the lens has effectively arrived and the loop can stop. */
const SETTLED = 0.4;

export function Flashlight() {
  const lensRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const lens = lensRef.current;
    const inner = innerRef.current;
    if (!lens || !inner) return;

    /* Pointer-driven and purely decorative, so it is scoped to devices that
     * actually have a pointer and to users who have not asked for less motion.
     *
     * These two conditions must stay in step with the `.voxel-base` dimming in
     * craft.css: the resting scene is only darkened where a flashlight exists to
     * light it again. Dim it anywhere this component does not mount and the
     * scene is simply too dark, with nothing able to recover it. */
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!fine.matches || still.matches) return;

    const field = lens.parentElement;
    if (!field) return;

    let raf = 0;
    let live = false;
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let width = 0;
    let height = 0;
    // Read from the element rather than a constant, so the size lives in CSS
    // only and the two can never drift apart.
    let lensSize = 0;

    const measure = () => {
      const box = field.getBoundingClientRect();
      width = box.width;
      height = box.height;
      lensSize = lens.offsetWidth;
      // The lit layer is a full copy of the field, so it can be counter
      // translated to stay registered with the dim scene beneath it.
      inner.style.width = `${width}px`;
      inner.style.height = `${height}px`;
    };

    const paint = () => {
      raf = 0;
      const dx = targetX - x;
      const dy = targetY - y;
      x += dx * EASE;
      y += dy * EASE;

      const half = lensSize / 2;
      lens.style.transform = `translate3d(${x - half}px, ${y - half}px, 0)`;
      inner.style.transform = `translate3d(${half - x}px, ${half - y}px, 0)`;

      // Keep going only while it is still catching up; a resting lens costs
      // nothing.
      if (live && (Math.abs(dx) > SETTLED || Math.abs(dy) > SETTLED)) schedule();
    };

    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(paint);
    };

    const onMove = (event: PointerEvent) => {
      const box = field.getBoundingClientRect();
      targetX = event.clientX - box.left;
      targetY = event.clientY - box.top;
      schedule();
    };

    const onEnter = (event: PointerEvent) => {
      if (!width) measure();
      live = true;
      const box = field.getBoundingClientRect();
      // Start where the pointer already is, so the lens does not fly in from
      // wherever it was last left.
      x = targetX = event.clientX - box.left;
      y = targetY = event.clientY - box.top;
      lens.dataset.live = 'true';
      schedule();
    };

    const onLeave = () => {
      live = false;
      lens.dataset.live = 'false';
    };

    const host = field.parentElement ?? field;
    measure();
    host.addEventListener('pointerenter', onEnter);
    host.addEventListener('pointermove', onMove, { passive: true });
    host.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', measure, { passive: true });

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      host.removeEventListener('pointerenter', onEnter);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div className='voxel-lens' ref={lensRef} data-live='false' aria-hidden='true'>
      <div className='voxel-lens-inner' ref={innerRef}>
        <picture>
          <source
            media='(orientation: portrait) and (max-width: 900px)'
            srcSet='/scene/voxel-horizon-portrait.webp'
          />
          <source media='(max-width: 1100px)' srcSet='/scene/voxel-horizon-900.webp' />
          <img src='/scene/voxel-horizon.webp' alt='' width={1672} height={941} decoding='async' />
        </picture>
      </div>
    </div>
  );
}
