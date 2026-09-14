import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { extractFrames } from './dist/extractor.mjs';
import { MAX_IMAGE_BYTES, parseFrameRequest } from './contract.mjs';

const directory = process.argv[2];
const proxyUrl = process.env.OUTBOUND_PROXY_URL?.trim();
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
try {
  const request = parseFrameRequest(JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')));
  const result = await extractFrames({
    ...request, outputDir: directory, preferResolution: true,
    fetch: dispatcher ? (input, init) => undiciFetch(input, { ...init, dispatcher }) : globalThis.fetch,
    retry: { policy: { maxAttempts: 2, attemptTimeoutMs: 8_000 } },
  });
  const frames = [];
  let totalBytes = 0;
  for (const { path, ...frame } of result.frames) {
    const size = (await stat(path)).size;
    if (size > 4 * 1024 * 1024 || totalBytes + size > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error('Frame images exceed 8 MiB. Request fewer timestamps or a smaller maxWidth.'),
        { code: 'INVALID_INPUT' });
    }
    const bytes = await readFile(path);
    totalBytes += bytes.length;
    frames.push({ ...frame, imageBase64: bytes.toString('base64') });
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify({ value: { ...result, frames } }));
} catch (error) {
  // No upstream messages, signed media URLs, local paths, or proxy credentials cross the boundary.
  const codes = new Set(['INVALID_INPUT', 'UNAVAILABLE', 'NOT_FOUND', 'AUTH_REQUIRED', 'RATE_LIMITED',
    'DEPENDENCY_MISSING', 'MEDIA_UNAVAILABLE', 'FRAME_EXTRACTION_FAILED']);
  const code = codes.has(error?.code) ? error.code : 'FRAME_EXTRACTION_FAILED';
  const safeValidationMessage = /^Timestamp \d+ms must be less than the video duration of \d+ms\.$/.test(error?.message ?? '')
    || error?.message === 'Frame images exceed 8 MiB. Request fewer timestamps or a smaller maxWidth.';
  const message = code === 'INVALID_INPUT' ? (safeValidationMessage ? error.message
    : 'Invalid frame request. Check timestamps against video duration and reduce the image selection if needed.')
    : 'The requested YouTube frames could not be extracted.';
  await writeFile(join(directory, 'result.json'), JSON.stringify({ error: { code, message,
    retryable: code !== 'INVALID_INPUT' && code !== 'NOT_FOUND' && code !== 'DEPENDENCY_MISSING' } }));
} finally {
  await dispatcher?.close();
}
