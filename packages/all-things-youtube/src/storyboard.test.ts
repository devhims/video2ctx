import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  const fixture = (name: string) => readFile(join(__dirname, 'fixtures', `storyboard-${name}.webp`));
  async function downloadImage(response: Response) {
    const outputDir = await mkdtemp(join(tmpdir(), 'storyboard-image-'));
    directories.push(outputDir);
    return downloadStoryboard(rawSpec(), { videoId: 'abcdefghijk', outputDir, maxSheets: 1 },
      vi.fn(async () => response));
  }

  test.each(['lossy', 'lossless', 'alpha'])('preserves native %s WebP bytes and tile mappings at a .jpg source URL', async name => {
    const bytes = await fixture(name);
    const result = await downloadImage(new Response(bytes, { headers: { 'content-type': 'image/webp' } }));
    expect(result.sheets[0]).toMatchObject({ firstFrameIndex: 0, frameCount: 25, columns: 5,
      rows: 5, tileWidth: 160, tileHeight: 90, intervalMs: 10000 });
    expect(result.sheets[0]!.path).toMatch(/-sheet-0\.webp$/);
    expect(await readFile(result.sheets[0]!.path)).toEqual(bytes);
  });

  test.each(['image/jpeg', 'image/jpg', 'IMAGE/WEBP; charset=binary'])('uses WebP bytes to select the extension with %s headers', async type => {
    const result = await downloadImage(new Response(await fixture('lossy'), { headers: { 'content-type': type } }));
    expect(result.sheets[0]!.path).toMatch(/\.webp$/);
  });

  test('keeps JPEG bytes and filenames when the allowed image header is inaccurate', async () => {
    const bytes = Uint8Array.from([255, 216, 255, 217]);
    const result = await downloadImage(new Response(bytes, { headers: { 'content-type': 'image/webp' } }));
    expect(result.sheets[0]!.path).toMatch(/\.jpg$/);
    expect(await readFile(result.sheets[0]!.path)).toEqual(Buffer.from(bytes));
  });

  test('rejects malformed, truncated, animated and header-only WebP without writing a sheet', async () => {
    const valid = await fixture('lossy');
    const badSize = Buffer.from(valid); badSize.writeUInt32LE(valid.length, 4);
    const badChunk = Buffer.from(valid); badChunk.writeUInt32LE(valid.length, 16);
    const noImage = Buffer.from(valid); noImage.write('JUNK', 12);
    const badVp8 = Buffer.from(valid); badVp8[23] = 0;
    const animated = await fixture('alpha'); animated[20] = animated[20]! | 0x02;
    const headerOnly = (await fixture('alpha')).subarray(0, 30); headerOnly.writeUInt32LE(22, 4);
    for (const bytes of [Buffer.from('not an image'), valid.subarray(0, 11), valid.subarray(0, -1),
      badSize, badChunk, noImage, badVp8, animated, headerOnly]) {
      await expect(downloadImage(new Response(bytes, { headers: { 'content-type': 'image/webp' } })))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(await readdir(join(directories.at(-1)!, 'storyboards'))).toEqual([]);
    }
  });

  test.each(['text/html', 'image/png', 'image/jpeg-malformed', ''])('rejects unsupported content type %s and cancels the body', async type => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    await expect(downloadImage(new Response(body, { headers: { 'content-type': type } })))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test.each([true, false])('bounds WebP downloads and cancels oversized bodies, content-length=%s', async withLength => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel,
    });
    await expect(downloadImage(new Response(body, { headers: {
      'content-type': 'image/webp', ...(withLength ? { 'content-length': String(4 * 1024 * 1024 + 1) } : {}),
    } }))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await readdir(join(directories.at(-1)!, 'storyboards'))).toEqual([]);
  });

  async function selected(options: { selection?: 'spread'; timestampsMs?: number[]; maxSheets?: number; metadataOnly?: boolean; sheetIndexes?: number[] }) {
    const directory = await mkdtemp(join(tmpdir(), 'storyboard-selection-'));
    directories.push(directory);
    const raw = rawSpec();
    raw.storyboards.playerStoryboardSpecRenderer.spec = raw.storyboards.playerStoryboardSpecRenderer.spec.replaceAll('#30#', '#102#');
    const fetchMock = vi.fn(async () => new Response(Uint8Array.from([255, 216, 255, 217]),
      { headers: { 'content-type': 'image/jpeg' } }));
    const result = await downloadStoryboard(raw, { videoId: 'abcdefghijk', outputDir: directory, maxSheets: 2, ...options }, fetchMock);
    return { result, fetchMock };
  }

  test('returns complete selection metadata without downloading any images', async () => {
    const { result, fetchMock } = await selected({ metadataOnly: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.sheets).toEqual([]);
    expect(result.selection?.mode).toBe('metadata');
    expect(result.manifest).toEqual({ totalSheets: 5, framesPerSheet: 25, tileWidth: 160, tileHeight: 90,
      columns: 5, rows: 5, lastSampleMs: 1010000 });
    expect(result.meta.partial).toBe(false);
  });

  test('downloads an agent-selected count greater than two', async () => {
    const { result, fetchMock } = await selected({ selection: 'spread', maxSheets: 4 });
    expect(result.sheets.map(sheet => sheet.firstFrameIndex)).toEqual([0, 25, 75, 100]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('downloads chosen non-contiguous sheet indexes and deduplicates them', async () => {
    const { result, fetchMock } = await selected({ sheetIndexes: [4, 1, 4, 2], maxSheets: 3 });
    expect(result.sheets.map(sheet => sheet.firstFrameIndex)).toEqual([25, 50, 100]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.selection?.mode).toBe('indexes');
  });

  test('rejects missing sheets and conflicting selection modes before downloading', async () => {
    for (const options of [{ sheetIndexes: [5] }, { sheetIndexes: [-1] }, { sheetIndexes: [0], timestampsMs: [0] },
      { metadataOnly: true, sheetIndexes: [0] }]) {
      await expect(selected(options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  test('spreads a two-sheet overview to the end of a long video without downloading intermediate sheets', async () => {
    const { result, fetchMock } = await selected({ selection: 'spread' });
    expect(result.sheets.map(sheet => sheet.firstFrameIndex)).toEqual([0, 100]);
    expect(result.sheets.map(sheet => sheet.frameCount)).toEqual([25, 2]);
    expect(result.selection).toEqual({ mode: 'spread' });
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining('/M0.jpg'), expect.stringContaining('/M4.jpg'),
    ]);
    expect(result.meta.partial).toBe(true);
  });

  test('selects only the late sheet containing a requested moment and deduplicates nearby timestamps', async () => {
    const { result, fetchMock } = await selected({ timestampsMs: [905000, 910000] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.sheets[0]).toMatchObject({ firstFrameIndex: 75, frameCount: 25, intervalMs: 10000 });
    expect(result.selection).toEqual({ mode: 'timestamps', requestedTimestampsMs: [905000, 910000] });
  });

  test('selects both sides of a sheet boundary and retains chronological source indexes', async () => {
    const { result } = await selected({ timestampsMs: [250000, 249999] });
    expect(result.sheets.map(sheet => sheet.firstFrameIndex)).toEqual([0, 25]);
  });

  test('uses the middle sheet for a single-sheet overview', async () => {
    const { result } = await selected({ selection: 'spread', maxSheets: 1 });
    expect(result.sheets[0]!.firstFrameIndex).toBe(50);
  });

  test.each([[-1], [], [NaN], [Infinity], [1.5], [1020000]].map(timestampsMs => ({ timestampsMs })))('rejects invalid or out-of-range timestamps $timestampsMs', async ({ timestampsMs }) => {
    await expect(selected({ timestampsMs })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('rejects a request that exceeds the sheet budget rather than silently dropping a target', async () => {
    await expect(selected({ timestampsMs: [0, 500000, 1000000] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

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
