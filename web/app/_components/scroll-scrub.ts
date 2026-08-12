/* Scroll-scrubbed timeline core.
 *
 * Ported from the scroll-world skill's scrub engine, reduced to what a single
 * continuous take needs: no segment chain, no connectors, no seam crossfade.
 * What survives is the decoder discipline, which is the part that is hard to
 * get right — seek coalescing, blob loading, and iOS priming.
 *
 * The video is optional. With no `video`/`src` the module is a pure scroll
 * timeline that only reports progress, which is how the CSS stage is driven —
 * so swapping the placeholder for real footage is an additive change, not a
 * rewrite. Either way this module owns time, not layout: it never writes to the
 * DOM except `video.currentTime`, so the caller keeps control of the markup.
 */

export interface ScrubOptions {
  /** Tall element whose scroll span maps onto the timeline. */
  track: HTMLElement;
  /** The clip. Must already be `muted`, `playsInline`, and `preload="none"`. */
  video?: HTMLVideoElement | null;
  /** Clip URL. Fetched as a Blob so seeking never depends on range requests. */
  src?: string | null;
  /**
   * Number of beats to settle on. The camera decelerates into each beat
   * boundary and accelerates out, so it rests where the copy peaks instead of
   * sliding past at constant speed. 0 disables the remap.
   */
  beats?: number;
  /** Strength of that settling, 0..0.6. Above ~0.6 it reads as stuttering. */
  linger?: number;
  /** Called on every committed frame with progress 0..1 and the active beat. */
  onProgress?: (progress: number, beat: number) => void;
}

/** Seek deltas below this are not worth a decoder round-trip. */
const SEEK_EPSILON = 0.01;

/**
 * True when scrubbing is appropriate: a real pointer, a wide enough viewport,
 * and no reduced-motion preference. Phones get static DOM instead — seeking a
 * long clip across a phone decoder is the dominant source of jank, and it costs
 * a mobile visitor bytes they did not ask for.
 */
export function shouldScrub(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return false;
  // Must match the pin's breakpoint in cinematic.css — below it the CSS falls
  // back to the static list, and a running engine would have nothing to drive.
  return window.matchMedia('(min-width: 1081px)').matches;
}

/**
 * Bias progress so it settles at each beat boundary. Blends the linear mapping
 * toward a per-segment smoothstep, which decelerates into the boundary and
 * accelerates out of it without ever moving backwards.
 */
function settle(progress: number, beats: number, linger: number): number {
  if (beats < 2 || linger <= 0) return progress;
  const span = 1 / beats;
  const index = Math.min(beats - 1, Math.floor(progress / span));
  const local = (progress - index * span) / span;
  const eased = local * local * (3 - 2 * local);
  const stepped = (index + eased) * span;
  return progress + (stepped - progress) * linger;
}

export function mountScrub(options: ScrubOptions): () => void {
  const { track, video = null, src = null, beats = 0, linger = 0, onProgress } = options;

  let objectUrl: string | null = null;
  let frame = 0;
  let active = false;
  let disposed = false;
  let target = 0;
  let committed = -1;
  let duration = 0;

  const readDuration = () => {
    // A live stream or a still-loading clip reports Infinity or NaN; both would
    // poison every seek target, so treat them as "not ready yet".
    duration = video && Number.isFinite(video.duration) ? video.duration : 0;
  };

  const measure = () => {
    const rect = track.getBoundingClientRect();
    // The track is taller than the viewport; progress runs from the moment its
    // top reaches the viewport top to the moment its bottom reaches the bottom.
    const span = rect.height - window.innerHeight;
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, -rect.top / span));
  };

  const tick = () => {
    frame = 0;
    if (disposed) return;
    if (video && !duration) readDuration();

    const progress = measure();
    const eased = settle(progress, beats, linger);
    onProgress?.(progress, beats ? Math.min(beats - 1, Math.floor(progress * beats)) : 0);

    if (video && duration) {
      // Stop a hair short of the end: seeking to exactly `duration` makes some
      // decoders fire `ended` and drop back to frame 0.
      target = Math.min(duration - 0.05, eased * duration);
      commit();
    }
  };

  /* Seek coalescing. Issuing `currentTime` while the decoder is still seeking
   * queues work it cannot keep up with, and a fast flick piles up enough of
   * those to freeze the element outright. So only one seek is ever in flight;
   * the newest target wins when it lands. */
  const commit = () => {
    if (!video || video.seeking) return;
    if (Math.abs(target - committed) < SEEK_EPSILON) return;
    committed = target;
    video.currentTime = target;
  };

  const schedule = () => {
    if (!active || disposed || frame) return;
    frame = window.requestAnimationFrame(tick);
  };

  const onSeeked = () => {
    // Whatever arrived while this seek was in flight is now stale — re-aim.
    if (Math.abs(target - committed) >= SEEK_EPSILON) commit();
  };

  /* iOS refuses to paint a frame until the element has played at least once, so
   * an unprimed video shows blank until the first seek resolves — sometimes
   * never. A muted play/pause on first interaction is the sanctioned unlock. */
  let primed = false;
  const prime = () => {
    if (primed || !video) return;
    primed = true;
    const played = video.play();
    if (played && typeof played.then === 'function') {
      played.then(() => video.pause()).catch(() => {
        /* Autoplay refusal is fine — desktop paints without priming. */
      });
    }
  };

  /* The clip is fetched as a Blob rather than assigned as a URL. A plain URL
   * source is only seekable if the server honours range requests; a Blob always
   * is, which makes scrubbing behave identically on any host. */
  const load = async () => {
    if (!video || !src) return;
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`${response.status}`);
      const blob = await response.blob();
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      video.src = objectUrl;
      video.load();
    } catch {
      // Leave the poster in place. The band still reads correctly without the
      // clip — every word in it is DOM, not footage.
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      active = entries.some((entry) => entry.isIntersecting);
      if (active) {
        // Deferred until the band is near — the clip is never on the critical path.
        if (video && src && !objectUrl) void load();
        schedule();
      } else if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    { rootMargin: '25% 0px' },
  );

  observer.observe(track);
  video?.addEventListener('loadedmetadata', readDuration);
  video?.addEventListener('seeked', onSeeked);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('pointerdown', prime, { once: true, passive: true });
  window.addEventListener('touchstart', prime, { once: true, passive: true });

  return () => {
    disposed = true;
    observer.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
    video?.removeEventListener('loadedmetadata', readDuration);
    video?.removeEventListener('seeked', onSeeked);
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('pointerdown', prime);
    window.removeEventListener('touchstart', prime);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}
