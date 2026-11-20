import { describe, expect, test } from 'vitest';

import { applyFit, drawnBox, fitFor, forMeasuring, hasFitTarget, unionBox } from './fit';

function frame(width: number, height: number, background: number, shapes: Array<[number, number, number, number, number]>): Uint8Array {
  const gray = new Uint8Array(width * height).fill(background);
  for (const [x1, y1, x2, y2, value] of shapes) {
    for (let y = y1; y < y2; y += 1) for (let x = x1; x < x2; x += 1) gray[y * width + x] = value;
  }
  return gray;
}

describe('drawnBox', () => {
  test('finds the shapes brighter than the background', () => {
    const gray = frame(100, 80, 30, [[20, 50, 40, 60, 230], [60, 55, 70, 70, 120]]);
    expect(drawnBox(gray, 100, 80)).toEqual({ x1: 20, y1: 50, x2: 70, y2: 70 });
  });

  test('ignores shapes no brighter than the background, and rows outside the range', () => {
    const gray = frame(100, 80, 30, [[10, 5, 30, 15, 230], [40, 40, 50, 50, 40]]);
    expect(drawnBox(gray, 100, 80, [20, 80])).toBeUndefined();
  });
});

describe('unionBox', () => {
  test('covers every state of the scene', () => {
    expect(unionBox([{ x1: 10, y1: 10, x2: 20, y2: 20 }, undefined, { x1: 5, y1: 15, x2: 30, y2: 18 }])).toEqual({ x1: 5, y1: 10, x2: 30, y2: 20 });
    expect(unionBox([undefined])).toBeUndefined();
  });
});

describe('fitFor', () => {
  test('moves a drawing that floats high in the bottom half to the half\'s middle, and scales it up', () => {
    // 450 x 200 px drawn around (500, 1150): it moves down to y 1440 and grows to the 1.6x cap.
    const fit = fitFor({ x1: 275, y1: 1050, x2: 725, y2: 1250 }, 'bottom');
    expect(fit).toEqual({ x: 40, y: 290, scale: 1.6, originX: 500, originY: 1150 });
  });

  test('shrinks a tall bottom-half drawing to the area height', () => {
    const fit = fitFor({ x1: 200, y1: 1000, x2: 880, y2: 1820 }, 'bottom');
    expect(fit.scale).toBe(0.634);
    expect(fit).toMatchObject({ x: 0, y: 30, originX: 540, originY: 1410 });
  });

  test('centres a full-frame drawing below the wordmark', () => {
    expect(fitFor({ x1: 90, y1: 500, x2: 990, y2: 1300 }, 'full')).toEqual({ x: 0, y: -70, scale: 1, originX: 540, originY: 900 });
  });
});

describe('applyFit', () => {
  const scene = '<template>\n  <style>#root { inset: 0; }</style>\n  <div id="root" data-composition-id="s1"><div data-fit>…</div></div>\n</template>\n';

  test('adds one marked rule inside the template, replacing an earlier one', () => {
    const once = applyFit(scene, { x: 40, y: 75, scale: 1.2, originX: 500, originY: 1150 });
    expect(once).toContain('<template>\n<style data-fit-style>[data-fit] { transform-origin: 500px 1150px; transform: translate(40px, 75px) scale(1.2); }</style>\n');
    const twice = applyFit(once, { x: 0, y: 0, scale: 1, originX: 540, originY: 1440 });
    expect(twice.match(/data-fit-style/g)).toHaveLength(1);
    expect(twice).toContain('scale(1)');
  });

  test('finds the fit target and strips the fit and sounds for measuring', () => {
    expect(hasFitTarget(scene)).toBe(true);
    expect(hasFitTarget('<div id="root"></div>')).toBe(false);
    const measured = forMeasuring(applyFit(scene, { x: 1, y: 1, scale: 1, originX: 0, originY: 0 }).replace('</div></div>', '</div><audio class="clip" src="assets/sfx/pop.mp3"></audio></div>'));
    expect(measured).not.toContain('data-fit-style');
    expect(measured).not.toContain('<audio');
  });
});
