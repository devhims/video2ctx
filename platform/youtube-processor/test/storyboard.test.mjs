import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadStoryboard } from '../storyboard.mjs';

test('storyboard transports JPEG bytes and frame mapping and removes temporary files', async () => {
  let directory;
  const result = await loadStoryboard('Ct-mtWqV3Ro', async (options) => {
    directory = options.outputDir;
    assert.equal(options.maxSheets, 2);
    const path = join(directory, 'sheet.jpg');
    await writeFile(path, Buffer.from([255, 216, 255, 217]));
    return { videoId: options.videoId, frameCount: 2, intervalMs: 5000,
      sheets: [{ path, firstFrameIndex: 0, frameCount: 2, columns: 2, rows: 1, intervalMs: 5000 }] };
  });
  assert.equal(result.sheets[0].imageBase64, '/9j/2Q==');
  assert.equal(result.sheets[0].path, undefined);
  assert.equal(result.sheets[0].frameCount, 2);
  await assert.rejects(access(directory));
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
