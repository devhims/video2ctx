import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** yt-dlp needs a JavaScript runtime for YouTube; Node qualifies from version 22. */
const NODE_RUNTIME_MIN_MAJOR = 22;
const FETCH_TIMEOUT_MS = 90 * 60_000;

/**
 * Arguments for the user's own yt-dlp: best H.264 video up to `maxHeight` plus AAC audio,
 * merged to MP4 by our FFmpeg. Cookies, PO-token plugins, and other access settings stay
 * in the user's yt-dlp configuration; this never adds them.
 */
export function ytDlpArgs(options: {
  videoId: string;
  directory: string;
  maxHeight: number;
  ffmpeg: string;
  nodeMajor: number;
  proxy?: string;
}): string[] {
  const h = options.maxHeight;
  return [
    '--no-playlist',
    '--no-progress',
    '-f', `bv*[height<=${h}][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=${h}]+ba/b[height<=${h}]`,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', options.ffmpeg,
    ...(options.nodeMajor >= NODE_RUNTIME_MIN_MAJOR ? ['--js-runtimes', 'node'] : []),
    ...(options.proxy ? ['--proxy', options.proxy] : []),
    '--print', 'after_move:filepath',
    '-o', join(options.directory, `${options.videoId}-%(height)sp.%(ext)s`),
    `https://www.youtube.com/watch?v=${options.videoId}`,
  ];
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run an external tool (yt-dlp, npx) without a shell and collect its output. */
export function runCommand(command: string, args: string[], timeoutMs = FETCH_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-100_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-100_000); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
