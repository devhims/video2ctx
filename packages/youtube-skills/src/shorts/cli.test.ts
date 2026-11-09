import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { YouTubeClientError, type Transcript, type Video } from 'all-things-youtube';

import { runShortsCli, type CliDependencies } from './cli';
import { segment } from './fixtures';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-cli-'));
  directories.push(directory);
  return directory;
}

function io() {
  const output: string[] = [];
  const errors: string[] = [];
  return { output, errors, stdout: (value: string) => output.push(value), stderr: (value: string) => errors.push(value) };
}

const transcript = {
  videoId: 'abcdefghijk',
  track: { id: 'a.en', name: 'English (auto-generated)', languageCode: 'en', kind: 'asr', isTranslatable: true },
  granularity: 'word',
  text: '',
  segments: [
    segment(1_000, [['the', 1_000], [' minions', 1_300], [' love', 1_600], [' Guru.', 1_900]]),
    segment(5_000, [['>> They', 5_000], [' bake', 5_300], [' cake.', 5_600]]),
  ],
  meta: { source: 'test', fetchedAt: '', partial: false, warnings: [] },
} as unknown as Transcript;

const details = {
  id: 'abcdefghijk',
  title: 'A long talk',
  durationSeconds: 8,
  description: '00:00 Intro\n00:05 Cake',
  meta: { warnings: [] },
} as unknown as Video;

const dependencies: CliDependencies = {
  getDetails: async () => details,
  getTranscript: async (options) => {
    expect(options).toMatchObject({ videoId: 'abcdefghijk', granularity: 'word' });
    return transcript;
  },
};

async function readProject(): Promise<string> {
  const directory = await project();
  const capture = io();
  expect(await runShortsCli(['read', '--video-id', 'abcdefghijk', '--project', directory], capture, {}, dependencies)).toBe(0);
  return directory;
}

describe('shorts CLI', () => {
  test('read writes video.json, words.json, and a timestamped transcript', async () => {
    const directory = await project();
    const capture = io();
    expect(await runShortsCli(['read', '--video-id', 'abcdefghijk', '--project', directory], capture, {}, dependencies)).toBe(0);
    const result = JSON.parse(capture.output.join(''));
    expect(result).toMatchObject({ words: 7, video: { chapters: 2 } });
    expect(result.warnings).toContainEqual(expect.stringMatching(/glossary/));
    const markdown = await readFile(join(directory, 'transcript.md'), 'utf8');
    expect(markdown).toContain('- 00:05 Cake');
    expect(markdown).toContain('[00:01] the minions love Guru. >> They bake cake.');
  });

  test('read hands off to transcribe when the video has no captions', async () => {
    const directory = await project();
    const capture = io();
    const noCaptions: CliDependencies = {
      getDetails: async () => details,
      getTranscript: async () => { throw new YouTubeClientError('CAPTIONS_UNAVAILABLE', 'Captions are not available for this video.'); },
    };
    expect(await runShortsCli(['read', '--video-id', 'abcdefghijk', '--project', directory], capture, {}, noCaptions)).toBe(0);
    const result = JSON.parse(capture.output.join(''));
    expect(result).toMatchObject({ captions: 'unavailable', next: expect.stringMatching(/transcribe/) });
    expect(JSON.parse(await readFile(join(directory, 'video.json'), 'utf8'))).toMatchObject({ videoId: 'abcdefghijk', track: null });
    await expect(stat(join(directory, 'words.json'))).rejects.toThrow();
  });

  test('plan resolves phrases, writes corrected caption text back, and reports issues', async () => {
    const directory = await readProject();
    await writeFile(join(directory, 'edl.json'), JSON.stringify({
      videoId: 'abcdefghijk',
      glossary: { guru: 'Gru' },
      shorts: [{ id: 'S1', hook: 'Minions', cuts: [{ from: 'minions love', to: 'bake cake' }] }],
    }));
    const capture = io();
    expect(await runShortsCli(['plan', '--project', directory], capture)).toBe(0);
    const result = JSON.parse(capture.output.join(''));
    expect(result).toMatchObject({ ok: true, shorts: [{ id: 'S1', cuts: [{ start: '00:01.30', startMs: 1_300, endMs: 6_600 }] }] });
    const edl = JSON.parse(await readFile(join(directory, 'edl.json'), 'utf8'));
    expect(edl.shorts[0].cuts[0]).toMatchObject({ from: 'minions love', startMs: 1_300, text: 'minions love Gru. They bake cake.' });
    expect(edl.shorts[0].durationSec).toBe(5.4);
  });

  test('render refuses an EDL with errors before touching media', async () => {
    const directory = await readProject();
    await writeFile(join(directory, 'edl.json'), JSON.stringify({
      videoId: 'abcdefghijk', shorts: [{ id: 'S1', cuts: [{ from: 'not said', to: 'anywhere' }] }],
    }));
    const capture = io();
    expect(await runShortsCli(['render', '--project', directory, '--master', '/missing.mp4'], capture)).toBe(2);
    expect(JSON.parse(capture.errors.join('')).error.message).toMatch(/Fix edl.json first/);
  });

  test('requires exactly one media source', async () => {
    const directory = await readProject();
    await writeFile(join(directory, 'edl.json'), JSON.stringify({
      videoId: 'abcdefghijk', shorts: [{ id: 'S1', hook: 'H', cuts: [{ from: 'minions love', to: 'bake cake' }] }],
    }));
    for (const source of [[], ['--master', '/x.mp4', '--from-youtube']]) {
      const capture = io();
      expect(await runShortsCli(['render', '--project', directory, ...source], capture)).toBe(2);
      expect(capture.errors.join('')).toMatch(/exactly one source/);
    }
  });

  test('fetch explains how to get yt-dlp when it is missing', async () => {
    const directory = await readProject();
    const capture = io();
    expect(await runShortsCli(['fetch', '--project', directory, '--yt-dlp-path', join(directory, 'no-yt-dlp')], capture)).toBe(1);
    const error = JSON.parse(capture.errors.join('')).error;
    expect(error.code).toBe('DEPENDENCY_MISSING');
    expect(error.message).toMatch(/yt-dlp is not installed/);
  });

  test('rejects unknown commands and flags as input errors', async () => {
    const capture = io();
    expect(await runShortsCli(['cut'], capture)).toBe(2);
    expect(await runShortsCli(['plan', '--project', '/x', '--master', 'y'], capture)).toBe(2);
    expect(capture.errors.join('')).toMatch(/--master is not valid for plan/);
  });
});

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const describeFfmpeg = process.env.SHORTS_FFMPEG_TEST === '1' ? describe : describe.skip;

describeFfmpeg('shorts CLI with real FFmpeg', () => {
  test('fetch runs yt-dlp and returns the merged file to use as the master', async () => {
    const directory = await readProject();
    const stub = join(directory, 'yt-dlp');
    // Stand-in for yt-dlp: writes a short 1080p file at the -o template and prints its path.
    await writeFile(stub, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1].replace('%(height)s', '1080').replace('%(ext)s', 'mp4');
const ffmpeg = args[args.indexOf('--ffmpeg-location') + 1];
const made = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '8', '-c:a', 'aac', out]);
if (made.status !== 0) process.exit(1);
console.log(out);
`, { mode: 0o755 });
    const capture = io();
    expect(await runShortsCli(['fetch', '--project', directory, '--yt-dlp-path', stub], capture)).toBe(0);
    const result = JSON.parse(capture.output.join(''));
    expect(result).toMatchObject({ master: join(directory, 'source', 'abcdefghijk-1080p.mp4'), width: 1920, height: 1080, hasAudio: true });
  }, 60_000);

  test('finds a hard cut, then renders a vertical short with sidecar captions', async () => {
    const directory = await readProject();
    const master = join(directory, 'master.mp4');
    const made = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
      '-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-filter_complex', "[0:v][1:v]overlay=enable='gte(t,3)'[v]",
      '-map', '[v]', '-map', '2:a', '-t', '8', '-c:a', 'aac', master,
    ]);
    expect(made.status).toBe(0);
    await writeFile(join(directory, 'edl.json'), JSON.stringify({
      videoId: 'abcdefghijk',
      shorts: [{ id: 'S1', hook: 'Minions', cuts: [{ from: 'minions love', to: 'bake cake' }] }],
    }));

    const shots = io();
    expect(await runShortsCli(['shots', '--project', directory, '--master', master], shots)).toBe(0);
    const found = JSON.parse(shots.output.join('')).shorts[0];
    expect(found.shots.map((shot: { atMs: number }) => shot.atMs)).toEqual([1_200, 3_000]);
    await stat(found.sheet);

    const edl = JSON.parse(await readFile(join(directory, 'edl.json'), 'utf8'));
    edl.shorts[0].layout = [{ atMs: 1_200, mode: 'crop', x: 0.3 }, { atMs: 3_000, mode: 'stack' }];
    await writeFile(join(directory, 'edl.json'), JSON.stringify(edl));
    const render = io();
    expect(await runShortsCli(['render', '--project', directory, '--master', master], render)).toBe(0);
    const result = JSON.parse(render.output.join(''));
    expect(result.shorts[0]).toMatchObject({ size: '1080x1920', segments: [{ mode: 'crop' }, { mode: 'stack' }] });
    expect(Math.abs(result.shorts[0].durationSec - 5.4)).toBeLessThan(0.3);
    expect(await readFile(result.shorts[0].srt, 'utf8')).toContain('minions love Guru.');
    await stat(result.shorts[0].preview);

    // Overlay: end card on the final frame with the thumbnail, a zoom, a mounted scene, bundled sounds.
    await writeFile(join(directory, 'scene.html'), '<template><div id="root" data-composition-id="demo-scene" data-width="1080" data-height="1920">' +
      '<audio id="demo-pop" class="clip" src="assets/sfx/sparkle.mp3" data-start="0.2" data-duration="0.5" data-volume="0.5"></audio></div>' +
      '<script>window.__timelines["demo-scene"] = gsap.timeline({ paused: true });</script></template>');
    edl.brand = { endCard: { channel: 'on Test' } };
    edl.shorts[0].overlay = { zooms: [{ atSec: 0.4 }], scenes: [{ src: 'scene.html', mode: 'full', atSec: 1, durationSec: 1.5 }] };
    await writeFile(join(directory, 'edl.json'), JSON.stringify(edl));
    const requested: string[][] = [];
    const overlay = io();
    expect(await runShortsCli(['overlay', '--project', directory], overlay, process.env, {
      fetchThumbnail: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      resolveSfx: async (keys, cache) => {
        requested.push(keys);
        await mkdir(cache, { recursive: true });
        const files: Record<string, string> = {};
        for (const key of keys) await writeFile(files[key] = join(cache, `${key}.mp3`), 'mp3');
        return { files, missing: [] };
      },
    }), overlay.errors.join('')).toBe(0);
    const built = JSON.parse(overlay.output.join('')).shorts[0];
    expect(Math.abs(built.durationSec - result.shorts[0].durationSec - 2.8)).toBeLessThan(0.05);
    const html = await readFile(join(built.project, 'index.html'), 'utf8');
    expect(html).toContain('data-composition-src="compositions/scene.html"');
    expect(html).toContain('<img src="assets/endcard/thumbnail.jpg"');
    expect(requested[0]).toEqual(expect.arrayContaining(['riser', 'pop', 'sparkle']));
    for (const file of ['endcard/freeze.jpg', 'endcard/freeze-blur.jpg', 'sfx/sparkle.mp3']) await stat(join(built.project, 'assets', file));
    await stat(join(built.project, 'compositions', 'scene.html'));
  }, 180_000);
});
