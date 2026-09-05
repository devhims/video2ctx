import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only bounded image bytes cross the processor boundary, never local paths or signed URLs.
export async function loadStoryboard(videoId, getStoryboard, options = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw Object.assign(new Error('Invalid storyboard video ID.'), { code: 'INVALID_INPUT', retryable: false });
  }
  const directory = await mkdtemp(join(tmpdir(), 'agent-storyboard-'));
  try {
    const index = await getStoryboard({ ...options, videoId, outputDir: directory, maxSheets: 2 });
    const sheets = await Promise.all(index.sheets.slice(0, 2).map(async ({ path, ...sheet }) => {
      const bytes = await readFile(path);
      if (bytes.length > 4 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new Error('Invalid or oversized storyboard JPEG.');
      }
      return { ...sheet, imageBase64: bytes.toString('base64') };
    }));
    return { ...index, sheets };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
