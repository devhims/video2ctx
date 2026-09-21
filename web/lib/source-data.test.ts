import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSourceData } from './source-data.ts';
import { platformRequest } from './platform-request.ts';

for (const [status, code, message] of [
  [404, 'NOT_FOUND', 'No transcript found for this video.'],
  [504, 'PROVIDER_TIMEOUT', 'YouTube extraction timed out.'],
  [429, 'RATE_LIMITED', 'Request limit exceeded.'],
  [402, 'INSUFFICIENT_CREDITS', 'Not enough credits.'],
] as const) {
  test(`source panel preserves the actual ${code} API error`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code, message } }, { status }));
    assert.deepEqual(await loadSourceData(() => platformRequest('/v1/providers/youtube/videos/video/transcript')), { error: message });
  });
}

test('source cancellation is not classified as missing data', async () => {
  await assert.rejects(loadSourceData(async () => { throw new DOMException('Cancelled', 'AbortError'); }), { name: 'AbortError' });
});
