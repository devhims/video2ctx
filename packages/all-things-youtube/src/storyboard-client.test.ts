import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYouTubeClient } from './youtube-client';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const withSpec = { playabilityStatus: { status: 'OK' }, storyboards: { playerStoryboardSpecRenderer: {
  spec: 'https://i.ytimg.com/sb/abcdefghijk/L$L/$N.jpg?sigh=secret|160#90#30#5#5#10000#M$M#secret',
} } };
async function run(responses: unknown[], options = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), 'storyboard-client-'));
  dirs.push(outputDir);
  const fetch = vi.fn(async (input: any) => String(input).includes('/watch?')
    ? new Response(`var ytInitialPlayerResponse = ${JSON.stringify(responses.shift())};`)
    : Response.json(responses.shift()));
  return { fetch, result: createYouTubeClient({ fetch, retry: { policy: { maxAttempts: 1 } } })
    .getStoryboard({ videoId: 'abcdefghijk', outputDir, metadataOnly: true, ...options }) };
}
test('continues after a playable IOS response without a storyboard', async () => {
  const { result, fetch } = await run([{ playabilityStatus: { status: 'OK' } }, withSpec]);
  expect((await result).frameCount).toBe(30);
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('falls back to the desktop player after mobile profiles omit or block storyboards', async () => {
  const { result, fetch } = await run([{ playabilityStatus: { status: 'OK' } },
    { playabilityStatus: { status: 'LOGIN_REQUIRED' } }, { playabilityStatus: { status: 'UNPLAYABLE' } }, withSpec]);
  expect((await result).manifest?.totalSheets).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(4);
});
test('blocked players are unavailable, not a definitive missing storyboard', async () => {
  const { result } = await run(Array.from({ length: 4 }, () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED' } })));
  await expect(result).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
});

test('only reports absence when every checked client was playable without a spec', async () => {
  const { result } = await run(Array.from({ length: 4 }, () => ({ playabilityStatus: { status: 'OK' } })));
  await expect(result).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
});
test('distinguishes malformed specs and recovers when a later profile has a valid spec', async () => {
  const bad = { playabilityStatus: { status: 'OK' }, storyboards: { playerStoryboardSpecRenderer: { spec: 'invalid' } } };
  await expect((await run([bad, withSpec])).result).resolves.toMatchObject({ frameCount: 30 });
  await expect((await run([bad, bad, bad, bad])).result).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
test('does not contact YouTube for invalid selection options', async () => {
  const { result, fetch } = await run([], { maxSheets: 0 });
  await expect(result).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fetch).not.toHaveBeenCalled();
});
