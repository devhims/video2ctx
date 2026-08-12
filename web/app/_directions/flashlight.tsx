'use client';

import { useEffect, useRef, useState } from 'react';

/* The fold's motion layer: a looping scene, plus a flashlight over it.
 *
 * The landscape rests almost unlit. A soft circular light tracks the pointer
 * and the terrain inside it comes up out of the dark — so the scene stays sharp
 * everywhere and the effect is carried entirely by light.
 *
 * Both are mounted here, from JS, under one gate. That gate is the whole
 * performance story: a device without a fine pointer never creates the <video>
 * element at all, so it downloads zero bytes of it and keeps the poster still.
 * Putting the video in the server-rendered markup and hiding it with CSS would
 * not achieve that.
 *
 * The light is a `backdrop-filter`, which brightens whatever is painted behind
 * it. The resting darkness is a separate translucent layer, so the video itself
 * remains fully opaque and is never softened by blending with the still image.
 * One source, one filter, no copy.
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

/* Which scene, if any, this device should fetch.
 *
 * A phone pays roughly eight times as much for the same decoration, on the
 * connections least able to afford it, so it is asked for explicitly rather
 * than by default — and never when the browser reports a metered or slow link.
 * `saveData` is a direct user preference and is treated as final. */
type Scene = 'none' | 'landscape' | 'portrait';

function chooseScene(): Scene {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'none';

  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return 'landscape';

  // Touch from here on: the portrait crop, and only over a link that can take it.
  const link = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (link?.saveData) return 'none';
  if (link?.effectiveType && !/4g|5g/.test(link.effectiveType)) return 'none';

  return window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'none';
}

export function Flashlight() {
  const lensRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [scene, setScene] = useState<Scene>('none');

  useEffect(() => {
    const lens = lensRef.current;
    if (!lens) return;

    const chosen = chooseScene();
    setScene(chosen);

    /* The light is pointer-driven, so it exists only on the landscape path.
     * Touch devices get the scene moving but no lens — there is no pointer to
     * follow, and `.voxel-dimmer` keeps the composite readable either way. */
    if (chosen !== 'landscape') return;

    const field = lens.parentElement;
    if (!field) return;

    let raf = 0;
    let live = false;
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    // Read from the element rather than a constant, so the size lives in CSS
    // only and the two can never drift apart.
    let lensSize = 0;

    const measure = () => {
      lensSize = lens.offsetWidth;
    };

    const paint = () => {
      raf = 0;
      const dx = targetX - x;
      const dy = targetY - y;
      x += dx * EASE;
      y += dy * EASE;

      const half = lensSize / 2;
      lens.style.transform = `translate3d(${x - half}px, ${y - half}px, 0)`;

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

      /* A refresh can place the pointer inside the fold before this effect has
       * attached `pointerenter`. Make movement self-healing instead of waiting
       * for the pointer to leave and enter again. Start at the pointer so the
       * recovered lens fades in locally rather than flying across the scene. */
      if (!live) {
        live = true;
        x = targetX;
        y = targetY;
        lens.dataset.live = 'true';
      }

      schedule();
    };

    const onEnter = (event: PointerEvent) => {
      if (!lensSize) measure();
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

  /* iOS will not autoplay anything it does not consider muted, and React's
   * `muted` prop is not reliably reflected onto a dynamically created <video>
   * element — the attribute renders but the property can stay false, so the
   * play is refused and the poster is all you get. Setting it imperatively
   * before asking to play is the fix.
   *
   * The play promise is caught rather than ignored: Low Power Mode refuses
   * autoplay outright, and that is fine — the poster is a designed state, not
   * a failure. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    const played = video.play();
    if (played && typeof played.then === 'function') {
      played.catch(() => {
        /* Autoplay declined. The poster stands in, which is the fallback the
         * scene is designed around anyway. */
      });
    }
  }, [scene]);

  return (
    <>
      {scene !== 'none' ? (
        <>
          <video
            key={scene}
            ref={videoRef}
            className='voxel-video'
            autoPlay
            loop
            muted
            playsInline
            preload='auto'
            poster={
              scene === 'portrait'
                ? '/scene/fold-scene-portrait-poster.webp'
                : '/scene/fold-scene-poster.webp'
            }
            aria-hidden='true'
          >
            {scene === 'portrait' ? (
              <>
                <source src='/scene/fold-scene-portrait.webm' type='video/webm' />
                <source src='/scene/fold-scene-portrait.mp4' type='video/mp4' />
              </>
            ) : (
              <>
                <source src='/scene/fold-scene.webm' type='video/webm' />
                <source src='/scene/fold-scene.mp4' type='video/mp4' />
              </>
            )}
          </video>
          <div className='voxel-dimmer' aria-hidden='true' />
        </>
      ) : null}
      <div className='voxel-lens' ref={lensRef} data-live='false' aria-hidden='true' />
    </>
  );
}
