import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadStoryboard } from '../storyboard.mjs';

test('storyboard transports JPEG bytes and frame mapping and removes temporary files', async () => {
  let directory;
  const result = await loadStoryboard('Ct-mtWqV3Ro', async (options) => {
    directory = options.outputDir;
    assert.equal(options.maxSheets, 20);
    assert.equal(options.selection, 'spread');
    const path = join(directory, 'sheet.jpg');
    await writeFile(path, Buffer.from([255, 216, 255, 217]));
    return { videoId: options.videoId, selection: { mode: 'spread' }, frameCount: 2, intervalMs: 5000,
      sheets: [{ path, firstFrameIndex: 0, frameCount: 2, columns: 2, rows: 1, intervalMs: 5000 }] };
  });
  assert.equal(result.sheets[0].imageBase64, '/9j/2Q==');
  assert.equal(result.sheets[0].path, undefined);
  assert.equal(result.sheets[0].frameCount, 2);
  await assert.rejects(access(directory));
});
test('forwards target timestamps and retains a late-sheet mapping', async () => {
  const result = await loadStoryboard('Ct-mtWqV3Ro', async options => {
    assert.deepEqual(options.timestampsMs, [905000]);
    const path = join(options.outputDir, 'late.jpg');
    await writeFile(path, Buffer.from([255, 216, 255, 217]));
    return { selection: { mode: 'timestamps', requestedTimestampsMs: [905000] },
      sheets: [{ path, firstFrameIndex: 75, frameCount: 25, intervalMs: 10000 }] };
  }, { timestampsMs: [905000] });
  assert.equal(result.sheets[0].firstFrameIndex, 75);
});
test('rejects an old library that silently ignores selection and removes its files', async () => {
  let directory;
  await assert.rejects(loadStoryboard('Ct-mtWqV3Ro', async options => {
    directory = options.outputDir;
    return { sheets: [] };
  }), /selection support/);
  await assert.rejects(access(directory));
});
test('rejects malformed timestamp requests before extraction', async () => {
  for (const timestampsMs of [[], [-1], [1.1], [Infinity], Array.from({ length: 21 }, (_, i) => i), '100']) {
    await assert.rejects(loadStoryboard('Ct-mtWqV3Ro', () => assert.fail('must not run'), { timestampsMs }), /timestampsMs/);
  }
});
test('storyboard cleans up when extraction fails', async () => {
  let directory;
  await assert.rejects(loadStoryboard('Ct-mtWqV3Ro', async (options) => {
    directory = options.outputDir;
    throw new Error('No storyboard');
  }), /No storyboard/);
  await assert.rejects(access(directory));
});
test('storyboard rejects invalid video identifiers before extraction', async () => {
  await assert.rejects(loadStoryboard('../invalid', () => assert.fail('must not run')), /Invalid/);
});

test('returns metadata without transporting image bytes', async () => {
  const manifest = { totalSheets: 12, framesPerSheet: 25 };
  const result = await loadStoryboard('Ct-mtWqV3Ro', async options => {
    assert.equal(options.metadataOnly, true);
    return { manifest, selection: { mode: 'metadata' }, sheets: [] };
  }, { metadataOnly: true });
  assert.deepEqual(result.manifest, manifest);
  assert.deepEqual(result.sheets, []);
});
test('transports all four selected sheets without slicing them to two', async () => {
  const result = await loadStoryboard('Ct-mtWqV3Ro', async options => {
    assert.equal(options.maxSheets, 4);
    assert.deepEqual(options.sheetIndexes, [1, 2, 3, 4]);
    const sheets = [];
    for (const index of options.sheetIndexes) {
      const path = join(options.outputDir, `${index}.jpg`);
      await writeFile(path, Buffer.from([255, 216, 255, 217]));
      sheets.push({ path, firstFrameIndex: index * 25 });
    }
    return { selection: { mode: 'indexes', requestedSheetIndexes: options.sheetIndexes }, sheets };
  }, { maxSheets: 4, sheetIndexes: [1, 2, 3, 4] });
  assert.deepEqual(result.sheets.map(sheet => sheet.firstFrameIndex), [25, 50, 75, 100]);
});
test('rejects oversized total image payload instead of silently dropping sheets', async () => {
  let directory;
  await assert.rejects(loadStoryboard('Ct-mtWqV3Ro', async options => {
    directory = options.outputDir;
    const sheets = [];
    for (let i = 0; i < 3; i++) {
      const path = join(directory, `${i}.jpg`);
      const bytes = Buffer.alloc(3 * 1024 * 1024);
      bytes.set([255, 216, 255, 217]);
      await writeFile(path, bytes);
      sheets.push({ path });
    }
    return { selection: { mode: 'spread' }, sheets };
  }, { maxSheets: 3 }), /8 MiB/);
  await assert.rejects(access(directory));
});
