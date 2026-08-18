import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { downloadStoryboard, parseStoryboardSpec } from './storyboard';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function rawSpec() {
  return {
    storyboards: {
      playerStoryboardSpecRenderer: {
        spec: [
          'https://i.ytimg.test/sb/video/storyboard3_L$L/$N.jpg?sqp=value',
          '48#27#100#10#10#0#default#ignored',
          '80#45#30#5#5#10000#M$M#signature-one',
          '160#90#30#5#5#10000#M$M#signature-two',
        ].join('|'),
      },
    },
  };
}

describe('storyboard contact sheets', () => {
  test('parses usable levels and ignores the zero-interval preview level', () => {
    const parsed = parseStoryboardSpec(rawSpec());

    expect(parsed?.levels).toHaveLength(2);
    expect(parsed?.levels[1]).toMatchObject({
      index: 2,
      tileWidth: 160,
      tileHeight: 90,
      intervalMs: 10_000,
    });
  });

  test('downloads the highest-resolution level and returns formula-ready sheet mappings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'storyboard-test-'));
    directories.push(directory);
    const fetchMock = vi.fn(async () => new Response(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      { headers: { 'content-type': 'image/jpeg' } },
    ));

    const result = await downloadStoryboard(rawSpec(), {
      videoId: 'abcdefghijk', outputDir: directory, maxSheets: 1,
    }, fetchMock as unknown as typeof fetch);

    expect(result).toMatchObject({
      videoId: 'abcdefghijk', level: 2, frameCount: 30, intervalMs: 10_000,
      meta: { partial: true, warnings: ['Storyboard: limited to 1 sheets'] },
    });
    expect(result.sheets).toEqual([expect.objectContaining({
      tileWidth: 160,
      tileHeight: 90,
      columns: 5,
      rows: 5,
      firstFrameIndex: 0,
      frameCount: 25,
      intervalMs: 10_000,
    })]);
    const requestedUrl = String(fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('i.ytimg.test')
    )?.[0]);
    expect(requestedUrl).toContain('storyboard3_L2/M0.jpg');
    expect(requestedUrl).toContain('sigh=signature-two');
    expect(await readFile(result.sheets[0]!.path)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );
  });

  test('rejects malformed requests before contacting YouTube', async () => {
    const fetchMock = vi.fn();

    await expect(downloadStoryboard(rawSpec(), {
      videoId: 'short', outputDir: '/tmp/storyboard-test',
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(downloadStoryboard(rawSpec(), {
      videoId: 'abcdefghijk', outputDir: '/tmp/storyboard-test', maxSheets: 21,
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
