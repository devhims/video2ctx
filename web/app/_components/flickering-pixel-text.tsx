'use client';

import { useEffect, useRef } from 'react';

interface FlickeringPixelTextProps {
  children: string;
  className?: string;
  color?: string;
  flickerChance?: number;
  gridGap?: number;
  maxOpacity?: number;
  minOpacity?: number;
  squareSize?: number;
}

interface GridState {
  cols: number;
  dpr: number;
  height: number;
  mask: HTMLCanvasElement;
  opacities: Float32Array;
  rows: number;
  width: number;
}

/* Magic UI's Flickering Grid behavior, adapted to a text-sized canvas. Each
 * cell changes opacity independently; a text mask keeps the grid inside the
 * glyphs while the real word remains accessible underneath. */
export function FlickeringPixelText({
  children,
  className,
  color,
  flickerChance = 0.65,
  gridGap = 0,
  maxOpacity = 1,
  minOpacity = 0.72,
  squareSize = 2,
}: FlickeringPixelTextProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!container || !canvas || !context) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animationFrame = 0;
    let disposed = false;
    let grid: GridState | null = null;
    let inView = true;
    let lastTime = 0;
    let resolvedColor = color ?? window.getComputedStyle(container).color;

    const drawTextMask = (
      maskContext: CanvasRenderingContext2D,
      width: number,
      height: number,
      dpr: number,
    ) => {
      const style = window.getComputedStyle(container);
      const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
      const characters = Array.from(children);

      maskContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      maskContext.clearRect(0, 0, width, height);
      maskContext.fillStyle = '#fff';
      maskContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      maskContext.textBaseline = 'alphabetic';

      const characterWidths = characters.map(
        (character) => maskContext.measureText(character).width,
      );
      const textWidth =
        characterWidths.reduce((total, value) => total + value, 0) +
        Math.max(0, characters.length - 1) * letterSpacing;
      const textMetrics = maskContext.measureText(children);
      const baseline =
        (height +
          textMetrics.actualBoundingBoxAscent -
          textMetrics.actualBoundingBoxDescent) /
        2;
      let x = (width - textWidth) / 2;

      characters.forEach((character, index) => {
        maskContext.fillText(character, x, baseline);
        x += characterWidths[index] + letterSpacing;
      });
    };

    const setup = () => {
      if (disposed) return;
      const bounds = container.getBoundingClientRect();
      const width = Math.max(1, Math.ceil(bounds.width));
      const height = Math.max(1, Math.ceil(bounds.height));
      const dpr = window.devicePixelRatio || 1;
      const cols = Math.ceil(width / (squareSize + gridGap));
      const rows = Math.ceil(height / (squareSize + gridGap));
      const opacities = new Float32Array(cols * rows);
      const mask = document.createElement('canvas');
      const opacityRange = Math.max(0, maxOpacity - minOpacity);

      resolvedColor = color ?? window.getComputedStyle(container).color;

      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      mask.width = canvas.width;
      mask.height = canvas.height;

      for (let index = 0; index < opacities.length; index += 1) {
        opacities[index] = minOpacity + Math.random() * opacityRange;
      }

      const maskContext = mask.getContext('2d');
      if (!maskContext) return;
      drawTextMask(maskContext, width, height, dpr);
      grid = { cols, dpr, height, mask, opacities, rows, width };
    };

    const draw = () => {
      if (!grid || disposed) return;
      const { cols, dpr, height, mask, opacities, rows, width } = grid;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = resolvedColor;

      for (let column = 0; column < cols; column += 1) {
        for (let row = 0; row < rows; row += 1) {
          const index = column * rows + row;
          context.globalAlpha = opacities[index];
          context.fillRect(
            column * (squareSize + gridGap),
            row * (squareSize + gridGap),
            squareSize,
            squareSize,
          );
        }
      }

      context.globalAlpha = 1;
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(mask, 0, 0, width, height);
      context.globalCompositeOperation = 'source-over';
      container.dataset.flickerReady = 'true';
    };

    const animate = (time: number) => {
      animationFrame = 0;
      if (!grid || !inView || reducedMotion.matches) return;

      const deltaTime = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0;
      const opacityRange = Math.max(0, maxOpacity - minOpacity);
      lastTime = time;
      for (let index = 0; index < grid.opacities.length; index += 1) {
        if (Math.random() < flickerChance * deltaTime) {
          grid.opacities[index] = minOpacity + Math.random() * opacityRange;
        }
      }
      draw();
      animationFrame = window.requestAnimationFrame(animate);
    };

    const start = () => {
      if (!disposed && !animationFrame && inView && !reducedMotion.matches) {
        lastTime = 0;
        animationFrame = window.requestAnimationFrame(animate);
      }
    };
    const stop = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    const resizeObserver = new ResizeObserver(() => {
      setup();
      draw();
      start();
    });
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView) start();
      else stop();
    });
    const handleMotionPreference = () => {
      if (reducedMotion.matches) {
        stop();
        delete container.dataset.flickerReady;
        context.clearRect(0, 0, canvas.width, canvas.height);
      } else {
        draw();
        start();
      }
    };

    resizeObserver.observe(container);
    intersectionObserver.observe(container);
    reducedMotion.addEventListener('change', handleMotionPreference);
    void document.fonts.ready.then(() => {
      if (disposed) return;
      setup();
      draw();
      start();
    });

    return () => {
      disposed = true;
      delete container.dataset.flickerReady;
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      reducedMotion.removeEventListener('change', handleMotionPreference);
    };
  }, [children, color, flickerChance, gridGap, maxOpacity, minOpacity, squareSize]);

  return (
    <span ref={containerRef} className={className}>
      <span className='flickering-pixel-text-label'>{children}</span>
      <canvas
        ref={canvasRef}
        className='flickering-pixel-text-canvas'
        aria-hidden='true'
      />
    </span>
  );
}
