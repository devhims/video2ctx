import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { describe, expect, test } from 'vitest';

import { extractFrames, getWatchIndex } from './workflow';

const describeLive = process.env.YOUTUBE_LIVE === '1' ? describe : describe.skip;

describeLive('youtube-watch private live workflow', () => {
  test('loads a storyboard/transcript index and exact best-effort frames', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'youtube-watch-live-'));
    try {
      const index = await getWatchIndex({
        videoId: '4vItmdk8F_M', outputDir, maxStoryboardSheets: 1,
      });
      const frames = await extractFrames({
        videoId: '4vItmdk8F_M', outputDir, timestampsMs: [30_000, 686_000, 1_000_000],
      });
      expect(index.storyboard?.sheets).toHaveLength(1);
      expect(index.transcript?.segments.length).toBeGreaterThan(0);
      expect(frames.frames).toHaveLength(3);
      expect(JSON.stringify({ index, frames })).not.toContain('googlevideo.com');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 180_000);
});
