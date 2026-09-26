import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'youtube-package-smoke-')));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd = root) => execFileSync(npm, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
try {
  run(['run', 'build']);
  const [packed] = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  assert(packed.files.every(file => /^(dist\/|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$)/.test(file.path)));
  assert(!packed.files.some(file => /test|fixtures/.test(file.path)));
  run(['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)]);
  const require = createRequire(join(temporary, 'package.json'));
  const entry = require.resolve('all-things-youtube');
  assert(entry.startsWith(temporary));
  const commonjs = require('all-things-youtube');
  const esm = await import(pathToFileURL(entry).href);
  assert.equal(typeof commonjs.getStoryboard, 'function');
  assert.equal(typeof esm.getStoryboard, 'function');
  const version = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
  assert.equal(version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
  const bytes = await readFile(join(root, 'src/fixtures/storyboard-lossy.webp'));
  let calls = 0;
  const mocked = await commonjs.getStoryboard({
    videoId: 'abcdefghijk', outputDir: join(temporary, 'fixture'), maxSheets: 1,
    fetch: async input => {
      calls++;
      const url = String(input);
      if (url.includes('/sb/')) return new Response(bytes, { headers: { 'content-type': 'image/webp' } });
      const player = { playabilityStatus: { status: 'OK' } };
      if (!url.includes('/watch?')) return Response.json(player);
      return new Response(`var ytInitialPlayerResponse = ${JSON.stringify({ ...player, storyboards: {
        playerStoryboardSpecRenderer: { spec: 'https://i.ytimg.test/sb/$L/$N.jpg|16#12#1#1#1#1000#M$M#signature' },
      } })};`);
    },
  });
  assert.equal(calls, 5);
  assert.equal(mocked.sheets.length, 1);
  assert(mocked.sheets[0].path.endsWith('.webp'));
  assert.deepEqual(await readFile(mocked.sheets[0].path), bytes);
  console.log(JSON.stringify({ test: 'packed-fixture', version, integrity: packed.integrity,
    commonjs: true, esm: true, calls, passed: true }));

  for (const api of [commonjs, esm]) {
    let playerCalls = 0;
    const retryEvents = [];
    const captionRequests = [];
    const result = await api.getTranscript({ videoId: 'AR1Gi3RHanE', lang: 'en',
      retry: { policy: { maxAttempts: 2 }, wait: async () => {}, onRetry: event => retryEvents.push(event) },
      fetch: async input => {
        const url = String(input);
        if (url.includes('/youtubei/v1/player')) return Response.json({ playabilityStatus: { status: 'OK' }, captions: {
          playerCaptionsTracklistRenderer: { captionTracks: [
            { baseUrl: ++playerCalls === 1 ? 'bad?token=secret' : 'https://captions.test/en', languageCode: 'en', vssId: '.en' },
            { baseUrl: 'https://captions.test/fr', languageCode: 'fr', vssId: '.fr' },
          ] },
        } });
        if (url.includes('/watch?')) return new Response('', { status: 404 });
        captionRequests.push(url);
        return Response.json({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Recovered transcript' }] }] });
      },
    });
    assert.equal(result.track.languageCode, 'en');
    assert.equal(result.segments[0].text, 'Recovered transcript');
    assert.equal(playerCalls, 2);
    assert.deepEqual(captionRequests, ['https://captions.test/en?fmt=json3']);
    assert.equal(retryEvents[0].reason, 'preparation');
    assert(!JSON.stringify(retryEvents).includes('token'));
  }
  console.log(JSON.stringify({ test: 'packed-caption-recovery', commonjs: true, esm: true, passed: true }));

  for (const api of [commonjs, esm]) {
    await assert.rejects(api.getTranscript({ videoId: 'AR1Gi3RHanE',
      retry: { policy: { maxAttempts: 1 } },
      fetch: async input => {
        const player = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } };
        return String(input).includes('/watch?')
          ? new Response(`var ytInitialPlayerResponse = ${JSON.stringify(player)};`) : Response.json(player);
      },
    }), { code: 'UNAVAILABLE', retryable: true });
  }
  console.log(JSON.stringify({ test: 'packed-caption-availability', commonjs: true, esm: true, passed: true }));

  if (process.argv.includes('--live')) {
    const requests = [];
    const result = await esm.getStoryboard({
      videoId: '6vzKDtKs5EM', outputDir: join(temporary, 'live'), maxSheets: 5,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        requests.push({ kind: String(input).includes('/watch?') ? 'desktop' : init?.method === 'POST' ? 'player' : 'image',
          status: response.status, contentType: response.headers.get('content-type') });
        return response;
      },
    });
    assert(result.sheets.length > 0);
    const images = [];
    for (const sheet of result.sheets) {
      const bytes = await readFile(sheet.path);
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      assert(webp || (bytes[0] === 255 && bytes[1] === 216));
      assert(sheet.path.endsWith(webp ? '.webp' : '.jpg'));
      assert(bytes.length <= 4 * 1024 * 1024);
      if (process.argv.includes('--decode')) {
        execFileSync('ffmpeg', ['-v', 'error', '-i', sheet.path, '-f', 'null', '-'], { stdio: 'pipe' });
      }
      images.push({ format: webp ? 'webp' : 'jpeg', bytes: bytes.length, firstFrameIndex: sheet.firstFrameIndex });
    }
    console.log(JSON.stringify({ test: 'packed-live', version, videoId: result.videoId,
      frameCount: result.frameCount, intervalMs: result.intervalMs, images, requests,
      decoded: process.argv.includes('--decode'), passed: true }));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
