import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

import { YouTubeClientError } from 'all-things-youtube';
import { jpegDimensions } from './jpeg';
import type { ExtractedFrame } from './types';

const FRAME_TIMEOUT_MS = 30_000;

function pathValue(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return environment.PATH ?? '';
  const key = Object.keys(environment).find((name) => name.toLowerCase() === 'path');
  return key ? environment[key] ?? '' : '';
}

function executableNames(command: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || extname(command)) return [command];
  const extensions = (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolveFfmpegExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const trimmed = command.trim();
  const hasPath = isAbsolute(trimmed) || /[\\/]/.test(trimmed);
  const directories = hasPath ? [''] : pathValue(environment, platform).split(delimiter).filter(Boolean);
  const names = executableNames(trimmed, environment, platform);

  for (const directory of directories) {
    for (const name of names) {
      const candidate = hasPath ? resolve(name) : resolve(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }

  throw new YouTubeClientError(
    'DEPENDENCY_MISSING',
    'FFmpeg is required for exact frames. Install FFmpeg, set FFMPEG_PATH, or provide ffmpegPath.',
  );
}

interface ProcessResult {
  code: number | null;
  stderr: string;
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveProcess({
        code: timedOut ? null : code,
        stderr: timedOut ? 'FFmpeg frame extraction timed out.' : stderr,
      });
    });
  });
}

function conciseError(stderr: string): string {
  if (/\b403\b|Forbidden|access denied/i.test(stderr)) {
    return 'The selected YouTube media format rejected range access.';
  }
  if (/timed out/i.test(stderr)) return 'FFmpeg frame extraction timed out.';
  return 'FFmpeg could not decode the requested frame.';
}

export async function extractJpeg(
  ffmpegPath: string,
  inputUrl: string,
  outputDir: string,
  videoId: string,
  timestampMs: number,
  maxWidth: number,
  sourceWidth?: number,
  sourceHeight?: number,
): Promise<ExtractedFrame> {
  const directory = resolve(outputDir, 'frames');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${videoId}-${timestampMs}-${randomUUID()}.jpg`);
  const seconds = (timestampMs / 1_000).toFixed(3);
  try {
    const result = await runProcess(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', seconds,
      '-i', inputUrl,
      '-map', '0:v:0',
      '-frames:v', '1',
      '-vf', `scale=min(${maxWidth}\\,iw):-2`,
      '-pix_fmt', 'yuvj420p',
      '-c:v', 'mjpeg',
      '-q:v', '2',
      '-strict', 'unofficial',
      '-y',
      path,
    ], FRAME_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new YouTubeClientError(
        /\b403\b|Forbidden|access denied/i.test(result.stderr)
          ? 'MEDIA_UNAVAILABLE'
          : 'FRAME_EXTRACTION_FAILED',
        conciseError(result.stderr),
        { retryable: true },
      );
    }
    const bytes = await readFile(path);
    const dimensions = jpegDimensions(bytes);
    if (!dimensions) {
      throw new YouTubeClientError('FRAME_EXTRACTION_FAILED', 'FFmpeg returned an invalid JPEG.');
    }
    return {
      timestampMs,
      path,
      mimeType: 'image/jpeg',
      width: dimensions.width,
      height: dimensions.height,
      sourceWidth,
      sourceHeight,
    };
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}
