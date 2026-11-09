import { describe, expect, test } from 'vitest';

import { videoGraph } from './layout';

describe('videoGraph', () => {
  test('crops a full-height 9:16 window around x, clamped to the frame', () => {
    expect(videoGraph({ atMs: 0, mode: 'crop', x: 0.5 }, 1920, 1080)).toBe('[0:v]crop=606:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1,format=yuv420p[v]');
    expect(videoGraph({ atMs: 0, mode: 'crop', x: 0 }, 1920, 1080)).toContain('crop=606:1080:0:0');
    expect(videoGraph({ atMs: 0, mode: 'crop', x: 1 }, 1920, 1080)).toContain('crop=606:1080:1314:0');
  });

  test('stacks the left half over the right half, swapped on request', () => {
    const graph = videoGraph({ atMs: 0, mode: 'stack', y: 0.45 }, 1920, 1080);
    expect(graph).toContain('[a]crop=960:852:0:60,');
    expect(graph).toContain('[b]crop=960:852:960:60,');
    expect(graph).toContain('vstack=inputs=2');
    expect(videoGraph({ atMs: 0, mode: 'stack', swap: true }, 1920, 1080)).toContain('[a]crop=960:852:960:');
  });

  test('narrows each half when the source is too short for 9:8', () => {
    expect(videoGraph({ atMs: 0, mode: 'stack' }, 2560, 800)).toContain('[a]crop=900:800:190:0,');
  });

  test('fits the whole frame over a blurred fill', () => {
    expect(videoGraph({ atMs: 0, mode: 'fit' }, 1920, 1080)).toContain('gblur=sigma=40[bg]');
  });
});
