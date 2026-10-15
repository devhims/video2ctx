/* A one-off confetti burst for the welcome toast, built on the Web Animations API
 * so it needs no dependency and leaves nothing behind once it finishes. */

const COLORS = [
  'var(--color-dashboard-accent)',
  'var(--color-dashboard-ink)',
  'var(--color-dashboard-warning)',
  'var(--color-dashboard-success)',
];
const PIECES = 36;
const GRAVITY = 600; // px/s²
const DRAG = 3; // per second; with gravity this caps the fall at a gentle 200 px/s
const STEPS = 16;

/** Bursts confetti upward from a viewport point. Skipped when reduced motion is preferred. */
export function burstConfetti(originX: number, originY: number, parent: HTMLElement = document.body): () => void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute('data-confetti', '');
  // One below Sonner's toaster, so pieces rise from behind the toast and fall behind it.
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '999999998', overflow: 'hidden' });
  parent.append(layer);

  const animations = Array.from({ length: PIECES }, (_, index) => {
    const piece = document.createElement('span');
    const width = 5 + Math.random() * 4;
    const round = index % 4 === 0;
    Object.assign(piece.style, {
      position: 'absolute',
      left: `${originX}px`,
      top: `${originY}px`,
      width: `${width}px`,
      height: `${round ? width : width * 1.6}px`,
      borderRadius: round ? '50%' : '1px',
      background: COLORS[index % COLORS.length],
      willChange: 'transform, opacity',
    });
    layer.append(piece);

    // An upward fan, 40° either side of vertical.
    const angle = (-90 + (Math.random() * 2 - 1) * 40) * (Math.PI / 180);
    const speed = 750 + Math.random() * 350;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const sway = 6 + Math.random() * 10;
    const phase = Math.random() * Math.PI * 2;
    const spin = (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 540);
    const duration = 2000 + Math.random() * 600;
    const seconds = duration / 1000;

    // Projectile motion with air drag: a quick rise, a brief hang, then a slow flutter down.
    const keyframes = Array.from({ length: STEPS + 1 }, (_, step) => {
      const progress = step / STEPS;
      const t = progress * seconds;
      const decay = (1 - Math.exp(-DRAG * t)) / DRAG;
      const x = vx * decay + Math.sin(t * 6 + phase) * sway * progress;
      const y = (vy - GRAVITY / DRAG) * decay + (GRAVITY * t) / DRAG;
      return {
        transform: `translate(${x}px, ${y}px) rotate(${spin * progress}deg)`,
        opacity: progress < 0.65 ? 1 : 1 - (progress - 0.65) / 0.35,
      };
    });
    return piece.animate(keyframes, { duration, easing: 'linear', fill: 'forwards' });
  });

  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => layer.remove());
  return () => { animations.forEach(animation => animation.cancel()); layer.remove(); };
}

/** Calls back with the element's box once it exists and its entrance transition has come to rest. */
export function whenSettled(selector: string, callback: (rect: DOMRect) => void): () => void {
  let frame: number;
  let lastTop = Number.NaN;
  let still = 0;
  let frames = 0;
  const tick = () => {
    const element = document.querySelector(selector);
    if (++frames > 120) return; // About two seconds: the toast never appeared or kept moving.
    if (!element) { frame = requestAnimationFrame(tick); return; }
    const rect = element.getBoundingClientRect();
    const mounted = element.getAttribute('data-mounted') !== 'false';
    still = mounted && Math.abs(rect.top - lastTop) < 0.5 ? still + 1 : 0;
    lastTop = rect.top;
    if (still >= 3) callback(rect);
    else frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
