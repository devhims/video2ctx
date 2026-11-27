import { describe, expect, test } from 'vitest';

import { ytDlpArgs } from './ytdlp';

describe('ytDlpArgs', () => {
  test('asks for H.264 up to the height cap with AAC, merged by our FFmpeg', () => {
    const args = ytDlpArgs({ videoId: 'abcdefghijk', directory: '/p/source', maxHeight: 1080, ffmpeg: '/bin/ffmpeg', nodeMajor: 25 });
    expect(args).toEqual(expect.arrayContaining(['--no-playlist', '--merge-output-format', 'mp4', '--js-runtimes', 'node']));
    expect(args[args.indexOf('-f') + 1]).toBe('bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]');
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('/bin/ffmpeg');
    expect(args[args.indexOf('-o') + 1]).toBe('/p/source/abcdefghijk-%(height)sp.%(ext)s');
    expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=abcdefghijk');
  });

  test('leaves the JS runtime to yt-dlp on old Node and never adds cookies', () => {
    const args = ytDlpArgs({ videoId: 'abcdefghijk', directory: '/p', maxHeight: 720, ffmpeg: 'ffmpeg', nodeMajor: 20, proxy: 'http://proxy:8080' });
    expect(args).not.toContain('--js-runtimes');
    expect(args.join(' ')).not.toMatch(/cookies/);
    expect(args[args.indexOf('--proxy') + 1]).toBe('http://proxy:8080');
  });
});
