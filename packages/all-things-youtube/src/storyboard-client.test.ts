import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYouTubeClient } from './youtube-client';
import { getStoryboard } from './index';

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

test('public API recovers from missing mobile storyboards and downloads desktop WebP', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'storyboard-public-webp-'));
  dirs.push(outputDir);
  const bytes = await readFile(join(__dirname, 'fixtures', 'storyboard-lossy.webp'));
  const fetch = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes('/sb/')) return new Response(bytes, { headers: { 'content-type': 'image/webp' } });
    if (url.includes('/watch?')) return new Response(`var ytInitialPlayerResponse = ${JSON.stringify(withSpec)};`);
    return Response.json({ playabilityStatus: { status: 'OK' } });
  });
  const result = await getStoryboard({ videoId: 'abcdefghijk', outputDir, maxSheets: 1, fetch });
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(result.sheets[0]!.path).toMatch(/\.webp$/);
  expect(await readFile(result.sheets[0]!.path)).toEqual(bytes);
  expect(result.sheets[0]).toMatchObject({ firstFrameIndex: 0, intervalMs: 10000 });
});

test('records a sheet 429 in diagnostics when a later player recovers', async () => {
  const { getStoryboardWithFallback } = await import('./storyboard-client');
  const outputDir = await mkdtemp(join(tmpdir(), 'storyboard-429-'));
  dirs.push(outputDir);
  const events: unknown[] = [];
  let images = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/sb/')) {
      if (++images === 1) return new Response('limited', { status: 429 });
      return new Response(Uint8Array.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });
    }
    return Response.json(withSpec);
  });
  const result = await getStoryboardWithFallback({ videoId: 'abcdefghijk', outputDir, maxSheets: 1,
    fetch, onDiagnostic: event => events.push(event) });
  expect(result.sheets).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ stage: 'download', outcome: 'error', status: 429 }));
  expect(events).toContainEqual(expect.objectContaining({ stage: 'complete', outcome: 'success' }));
  expect(JSON.stringify(events)).not.toContain('secret');
});

test('marks bot-challenged player responses, but not other sign-in requirements', async () => {
  const { getStoryboardWithFallback } = await import('./storyboard-client');
  const outputDir = await mkdtemp(join(tmpdir(), 'storyboard-bot-'));
  dirs.push(outputDir);
  const events: Array<Record<string, unknown>> = [];
  const players = [
    { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } },
    { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' } },
    withSpec,
  ];
  const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/watch?')
    ? new Response(`var ytInitialPlayerResponse = ${JSON.stringify(players.shift())};`)
    : Response.json(players.shift()));
  await getStoryboardWithFallback({ videoId: 'abcdefghijk', outputDir, metadataOnly: true, fetch,
    onDiagnostic: event => events.push(event as Record<string, unknown>) });
  const player = events.filter(event => event.stage === 'player');
  expect(player[0]).toMatchObject({ playabilityStatus: 'LOGIN_REQUIRED', failureReason: 'bot_challenge' });
  expect(player[1]).toMatchObject({ playabilityStatus: 'LOGIN_REQUIRED' });
  expect(player[1]!.failureReason).toBeUndefined();
  // The reason text itself never leaves the extractor.
  expect(JSON.stringify(events)).not.toContain('not a bot');
});
