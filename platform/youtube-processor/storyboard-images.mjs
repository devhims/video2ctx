import sharp from 'sharp';
import { readBoundedBytes, YouTubeClientError } from './storyboard-extractor.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const invalid = () => new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned an invalid or oversized storyboard WebP.');

export function storyboardImageFetch(fetchImpl, onDiagnostic = () => {}) {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/webp') return response;
    const startedAt = Date.now();
    const bytes = Buffer.from(await readBoundedBytes(response, MAX_BYTES));
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw invalid();
    const signal = init?.signal;
    signal?.throwIfAborted();
    const pipeline = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' }).jpeg({ quality: 90 }).timeout({ seconds: 2 });
    let abort;
    try {
      const aborted = new Promise((_, reject) => {
        abort = () => { pipeline.destroy(); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
      });
      const { data, info } = await Promise.race([pipeline.toBuffer({ resolveWithObject: true }), aborted]);
      if (data.length > MAX_BYTES) throw invalid();
      try { onDiagnostic({ stage: 'image_normalized', inputFormat: 'webp', outputFormat: 'jpeg',
        inputBytes: bytes.length, outputBytes: data.length, width: info.width, height: info.height, elapsedMs: Date.now() - startedAt }); } catch { /* Observability only. */ }
      // Signed source URLs and upstream headers must not escape into logs or the result.
      return new Response(data, { headers: { 'content-type': 'image/jpeg', 'content-length': String(data.length) } });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw invalid();
    } finally {
      signal?.removeEventListener('abort', abort);
      pipeline.destroy();
    }
  };
}
