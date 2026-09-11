import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only bounded image bytes cross the processor boundary, never local paths or signed URLs.
export async function loadStoryboard(videoId, getStoryboard, options = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw Object.assign(new Error('Invalid storyboard video ID.'), { code: 'INVALID_INPUT', retryable: false });
  }
  const timestampsMs = options.timestampsMs;
  if (timestampsMs !== undefined && (!Array.isArray(timestampsMs) || timestampsMs.length < 1 || timestampsMs.length > 20
    || timestampsMs.some(time => !Number.isSafeInteger(time) || time < 0))) {
    throw Object.assign(new Error('Provide 1 to 20 nonnegative integer timestampsMs.'), { code: 'INVALID_INPUT', retryable: false });
  }
  if (options.metadataOnly !== undefined && typeof options.metadataOnly !== 'boolean') {
    throw Object.assign(new Error('metadataOnly must be a boolean.'), { code: 'INVALID_INPUT', retryable: false });
  }
  const maxSheets = options.maxSheets ?? 20;
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 1 || maxSheets > 20) {
    throw Object.assign(new Error('maxSheets must be an integer from 1 to 20.'), { code: 'INVALID_INPUT', retryable: false });
  }
  if (options.sheetIndexes !== undefined && (!Array.isArray(options.sheetIndexes) || options.sheetIndexes.length < 1
    || options.sheetIndexes.length > 20 || options.sheetIndexes.some(index => !Number.isSafeInteger(index) || index < 0))) {
    throw Object.assign(new Error('sheetIndexes must contain 1 to 20 nonnegative integers.'), { code: 'INVALID_INPUT', retryable: false });
  }
  if ((timestampsMs && options.sheetIndexes) || (options.metadataOnly && (timestampsMs || options.sheetIndexes))) {
    throw Object.assign(new Error('Choose metadata, sheet indexes, or timestamps separately.'), { code: 'INVALID_INPUT', retryable: false });
  }
  const directory = await mkdtemp(join(tmpdir(), 'agent-storyboard-'));
  try {
    const index = await getStoryboard({ ...options, videoId, outputDir: directory, maxSheets, selection: 'spread' });
    // Older published extractors silently ignore the new selection options.
    if (index.selection?.mode !== (options.metadataOnly ? 'metadata' : options.sheetIndexes ? 'indexes' : timestampsMs ? 'timestamps' : 'spread')
      || (timestampsMs && JSON.stringify(index.selection.requestedTimestampsMs) !== JSON.stringify(timestampsMs))
      || (options.sheetIndexes && JSON.stringify(index.selection.requestedSheetIndexes) !== JSON.stringify(options.sheetIndexes))) {
      throw Object.assign(new Error('The processor requires an extraction library with storyboard selection support.'),
        { code: 'UNAVAILABLE', retryable: false });
    }
    if (index.sheets.length > maxSheets) throw new Error('Extractor exceeded the requested sheet budget.');
    if (options.metadataOnly && (!index.manifest || index.sheets.length)) throw new Error('Invalid storyboard metadata response.');
    const sheets = [];
    let totalBytes = 0;
    for (const { path, ...sheet } of index.sheets) {
      const bytes = await readFile(path);
      if (bytes.length > 4 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new Error('Invalid or oversized storyboard JPEG.');
      }
      totalBytes += bytes.length;
      if (totalBytes > 8 * 1024 * 1024) {
        throw Object.assign(new Error('Selected sheets exceed the 8 MiB image budget. Request fewer sheets per call.'),
          { code: 'INVALID_INPUT', retryable: false });
      }
      sheets.push({ ...sheet, imageBase64: bytes.toString('base64') });
    }
    return { ...index, sheets };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
