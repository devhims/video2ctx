import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSourceData, videoIdFromInput, isVideoId, CAPTIONS_UNAVAILABLE_MESSAGE, retryableSourceDatasets } from './source-data.ts';
import { platformRequest, PlatformApiError } from './platform-request.ts';

for (const [status, code, message] of [
  [404, 'NOT_FOUND', 'No transcript found for this video.'],
  [504, 'PROVIDER_TIMEOUT', 'YouTube extraction timed out.'],
  [429, 'RATE_LIMITED', 'Request limit exceeded.'],
  [402, 'INSUFFICIENT_CREDITS', 'Not enough credits.'],
] as const) {
  test(`source panel preserves the actual ${code} API error`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code, message } }, { status }));
    assert.deepEqual(await loadSourceData(() => platformRequest('/v1/videos/video/transcript?provider=youtube')), { error: message });
  });
}

test('source cancellation is not classified as missing data', async () => {
  await assert.rejects(loadSourceData(async () => { throw new DOMException('Cancelled', 'AbortError'); }), { name: 'AbortError' });
});

test('only confirmed caption absence is excluded from failed-request retries', async () => {
  const result = await loadSourceData(async () => { throw new PlatformApiError(404, 'CAPTIONS_UNAVAILABLE', 'Provider caption absence'); });
  assert.deepEqual(result, { error: CAPTIONS_UNAVAILABLE_MESSAGE });
  assert.deepEqual(retryableSourceDatasets({ transcript: result.error, metadata: 'Metadata timed out.' }), ['metadata']);
  assert.deepEqual(retryableSourceDatasets({ transcript: 'YouTube is temporarily unavailable.' }), ['transcript']);
  assert.deepEqual(retryableSourceDatasets({ transcript: 'The requested YouTube resource was not found.' }), ['transcript']);
});

for (const input of [
  '0oXOOlqVu5M', ' https://youtu.be/0oXOOlqVu5M?t=20 ',
  'https://www.youtube.com/watch?v=0oXOOlqVu5M&list=PL123',
  'https://m.youtube.com/watch?v=0oXOOlqVu5M',
  'https://youtube.com/shorts/0oXOOlqVu5M', 'https://youtube.com/live/0oXOOlqVu5M',
]) test(`recognizes a video locally: ${input}`, () => {
  assert.equal(videoIdFromInput(input), '0oXOOlqVu5M');
});

for (const input of [
  'AI agent tutorials', 'https://youtube.com/playlist?list=PL123',
  'https://youtube.com/shorts/0oXOOlqVu5M?list=PL123',
  'https://youtube.com/@creator', 'https://youtu.be/short-id',
  'https://youtube.com.evil.example/watch?v=0oXOOlqVu5M',
  'https://vimeo.com/0oXOOlqVu5M', 'javascript:0oXOOlqVu5M',
]) test(`leaves ambiguous or unsupported input to the platform: ${input}`, () => {
  assert.equal(videoIdFromInput(input), undefined);
});

test('only eleven URL-safe characters form a video ID', () => {
  for (const id of ['0oXOOlqVu5M', 'WUvTyaaNkzM', 'a_b-c_d-e_f']) assert.equal(isVideoId(id), true, id);
  for (const id of ['invalid', '', 'abcdefghij', 'abcdefghijkl', 'abcde.ghijk', 'abc efghijk', null, undefined]) assert.equal(isVideoId(id), false, String(id));
});
