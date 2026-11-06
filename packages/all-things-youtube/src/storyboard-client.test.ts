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


test.each([1, 2, 5])('honors lower caller retry limits and the supplied wait (%s attempts)', async maxAttempts => {
  const { getStoryboardWithFallback } = await import('./storyboard-client');
  const outputDir = await mkdtemp(join(tmpdir(), 'storyboard-retries-'));
  dirs.push(outputDir);
  const fetch = vi.fn(async () => new Response('', { status: 503, headers: { 'retry-after': '2' } }));
  const wait = vi.fn(async () => {});
  await expect(getStoryboardWithFallback({ videoId: 'abcdefghijk', outputDir, metadataOnly: true,
    fetch, retry: { policy: { maxAttempts }, wait } })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(fetch).toHaveBeenCalledTimes(4 * Math.min(2, maxAttempts));
  expect(wait).toHaveBeenCalledTimes(4 * (Math.min(2, maxAttempts) - 1));
});

test('the top-level signal interrupts even a custom wait that never settles', async () => {
  const { getStoryboardWithFallback } = await import('./storyboard-client');
  const outputDir = await mkdtemp(join(tmpdir(), 'storyboard-wait-abort-'));
  dirs.push(outputDir);
  const controller = new AbortController();
  const fetch = vi.fn(async () => new Response('', { status: 503 }));
  const wait = vi.fn(async () => { controller.abort(); await new Promise<void>(() => {}); });
  await expect(getStoryboardWithFallback({ videoId: 'abcdefghijk', outputDir, metadataOnly: true,
    signal: controller.signal, fetch, retry: { wait } })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(wait).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

// Web watch pages also list L3. L0 has no interval and is never selected.
const webSpec = { playabilityStatus: { status: 'OK' }, storyboards: { playerStoryboardSpecRenderer: {
  spec: 'https://i.ytimg.com/sb/abcdefghijk/L$L/$N.jpg?sigh=secret|48#27#100#10#10#0#default#s0|80#45#30#10#10#10000#M$M#s1'
    + '|160#90#30#5#5#10000#M$M#s2|320#180#30#3#3#10000#M$M#s3',
} } };
const mobileSpec = { playabilityStatus: { status: 'OK' }, storyboards: { playerStoryboardSpecRenderer: {
  spec: webSpec.storyboards.playerStoryboardSpecRenderer.spec.split('|').slice(0, 4).join('|'),
} } };
function players(byClient: { watch?: unknown; mobile?: unknown[] }) {
  const mobile = [...(byClient.mobile ?? [])];
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/sb/')) return new Response(Uint8Array.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.includes('/watch?')) return new Response(`var ytInitialPlayerResponse = ${JSON.stringify(byClient.watch)};`);
    return Response.json(mobile.shift());
  });
}
async function storyboardDir() {
  const outputDir = await mkdtemp(join(tmpdir(), 'storyboard-resolution-'));
  dirs.push(outputDir);
  return outputDir;
}

test('high resolution reads the watch page first and selects its L3 level', async () => {
  const fetch = players({ watch: webSpec, mobile: [mobileSpec] });
  const events: Array<Record<string, unknown>> = [];
  const { getStoryboardWithFallback } = await import('./storyboard-client');
  const result = await getStoryboardWithFallback({ videoId: 'abcdefghijk', outputDir: await storyboardDir(), timestampsMs: [95_000],
    resolution: 'high', fetch, onDiagnostic: event => events.push(event as Record<string, unknown>) });
  expect(String(fetch.mock.calls[0]![0])).toContain('/watch?v=abcdefghijk');
  expect(result).toMatchObject({ level: 3, resolution: 'high', manifest: { totalSheets: 4, framesPerSheet: 9, tileWidth: 320, tileHeight: 180 },
    meta: { warnings: ['Storyboard: limited to 1 sheets'] } });
  expect(result.sheets).toEqual([expect.objectContaining({ firstFrameIndex: 9, columns: 3, rows: 3 })]);
  expect(events).toContainEqual(expect.objectContaining({ stage: 'complete', profile: 'web', level: 3, resolution: 'high' }));
  expect(String(fetch.mock.calls[1]![0])).toMatch(/\/L3\/M1\.jpg\?sigh=s3$/);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('standard resolution keeps L2 even when only the watch page responds', async () => {
  const fetch = players({ watch: webSpec, mobile: [{ playabilityStatus: { status: 'LOGIN_REQUIRED' } },
    { playabilityStatus: { status: 'LOGIN_REQUIRED' } }, { playabilityStatus: { status: 'UNPLAYABLE' } }] });
  const result = await createYouTubeClient({ fetch }).getStoryboard({ videoId: 'abcdefghijk', outputDir: await storyboardDir(), metadataOnly: true });
  expect(String(fetch.mock.calls[0]![0])).toContain('youtubei.googleapis.com');
  expect(result).toMatchObject({ level: 2, resolution: 'standard', manifest: { framesPerSheet: 25, tileWidth: 160 } });
});

test('high resolution falls back to standard sheets with a warning when the watch page is blocked', async () => {
  const fetch = players({ watch: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } },
    mobile: [mobileSpec] });
  const result = await createYouTubeClient({ fetch }).getStoryboard({ videoId: 'abcdefghijk', outputDir: await storyboardDir(),
    metadataOnly: true, resolution: 'high' });
  expect(result).toMatchObject({ level: 2, resolution: 'standard', manifest: { framesPerSheet: 25 },
    meta: { partial: true, warnings: ['Storyboard: high resolution unavailable; returned standard sheets'] } });
});

test('high resolution labels an L2-only video as standard so both resolutions share one manifest', async () => {
  const fetch = players({ watch: mobileSpec });
  const result = await createYouTubeClient({ fetch }).getStoryboard({ videoId: 'abcdefghijk', outputDir: await storyboardDir(),
    metadataOnly: true, resolution: 'high' });
  const standard = await createYouTubeClient({ fetch: players({ mobile: [mobileSpec] }) }).getStoryboard({ videoId: 'abcdefghijk',
    outputDir: await storyboardDir(), metadataOnly: true });
  expect(result).toMatchObject({ level: 2, resolution: 'standard',
    meta: { partial: true, warnings: ['Storyboard: high resolution unavailable; returned standard sheets'] } });
  expect(result.manifest).toEqual(standard.manifest);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('the public API forwards resolution and rejects an unknown one before contacting YouTube', async () => {
  const outputDir = await storyboardDir();
  await expect(getStoryboard({ videoId: 'abcdefghijk', outputDir, metadataOnly: true, resolution: 'high', fetch: players({ watch: webSpec }) }))
    .resolves.toMatchObject({ level: 3, resolution: 'high' });
  const fetch = players({});
  await expect(createYouTubeClient({ fetch }).getStoryboard({ videoId: 'abcdefghijk', outputDir: await storyboardDir(),
    resolution: 'max' as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fetch).not.toHaveBeenCalled();
});
