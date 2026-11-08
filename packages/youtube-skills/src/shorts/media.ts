import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { RenderSegment } from './edl';
import { videoGraph } from './layout';

const STDERR_LIMIT = 400_000;
const PROBE_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 15 * 60_000;

export class MediaError extends Error {
  readonly code = 'MEDIA_FAILED';

  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface ProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

export function runFfmpeg(ffmpeg: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args], {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-STDERR_LIMIT); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, options.timeoutMs ?? STEP_TIMEOUT_MS);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

async function mustRun(ffmpeg: string, args: string[], what: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<ProcessResult> {
  const result = await runFfmpeg(ffmpeg, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-3).join(' ');
    throw new MediaError(`FFmpeg failed to ${what}: ${detail}`, result.stderr);
  }
  return result;
}

export interface MasterInfo {
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  /** Video frame rate; 30 when FFmpeg does not report one. */
  fps: number;
}

export async function probeMaster(ffmpeg: string, path: string): Promise<MasterInfo> {
  const { stderr } = await runFfmpeg(ffmpeg, ['-i', path], { timeoutMs: PROBE_TIMEOUT_MS });
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  const video = /Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
  if (!duration || !video) throw new MediaError(`Could not read a video stream and duration from ${basename(path)}.`, stderr);
  return {
    width: Number(video[1]),
    height: Number(video[2]),
    durationSec: Number(duration[1]) * 3_600 + Number(duration[2]) * 60 + Number(duration[3]),
    hasAudio: /Stream #[^\n]*Audio:/.test(stderr),
    fps: Number(/Stream #[^\n]*Video:[^\n]*?([\d.]+) fps/.exec(stderr)?.[1]) || 30,
  };
}

export interface Capabilities {
  videoCodecArgs: string[];
  encoder: string;
  canBurnCaptions: boolean;
}

export async function detectCapabilities(ffmpeg: string): Promise<Capabilities> {
  const [encoders, filters] = await Promise.all([
    runFfmpeg(ffmpeg, ['-encoders'], { timeoutMs: PROBE_TIMEOUT_MS }),
    runFfmpeg(ffmpeg, ['-filters'], { timeoutMs: PROBE_TIMEOUT_MS }),
  ]);
  const has = (name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(encoders.stdout);
  const canBurnCaptions = /^\s*\S+\s+(subtitles|ass)\s/m.test(filters.stdout);
  if (has('libx264')) {
    return { encoder: 'libx264', videoCodecArgs: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'], canBurnCaptions };
  }
  if (has('h264_videotoolbox')) {
    return { encoder: 'h264_videotoolbox', videoCodecArgs: ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-pix_fmt', 'yuv420p'], canBurnCaptions };
  }
  return { encoder: 'mpeg4', videoCodecArgs: ['-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p'], canBurnCaptions };
}

const seconds = (ms: number) => (ms / 1_000).toFixed(3);

/** Source times (ms) of hard cuts between `inMs` and `outMs`. */
export async function detectShotChanges(ffmpeg: string, master: string, inMs: number, outMs: number, threshold: number): Promise<number[]> {
  const { stderr } = await mustRun(ffmpeg, [
    '-ss', seconds(inMs), '-t', seconds(outMs - inMs), '-i', master,
    '-an', '-vf', `scale=320:-2,select='gt(scene\\,${threshold})',showinfo`, '-f', 'null', '-',
  ], 'detect shot changes');
  const changes: number[] = [];
  for (const match of stderr.matchAll(/pts_time:\s*([\d.]+)/g)) {
    const at = inMs + Math.round(Number(match[1]) * 1_000);
    if (!changes.length || at - changes.at(-1)! > 500) changes.push(at);
  }
  return changes.filter((at) => at > inMs + 200 && at < outMs - 200);
}

/** Pauses (absolute ms) in the audio between `fromMs` and `toMs`, at or below `noiseDb` for at least `minMs`. */
export async function detectSilences(ffmpeg: string, master: string, fromMs: number, toMs: number, noiseDb = -35, minMs = 50): Promise<Array<{ startMs: number; endMs: number }>> {
  const start = Math.max(0, fromMs);
  const { stderr } = await mustRun(ffmpeg, [
    '-ss', seconds(start), '-t', seconds(toMs - start), '-i', master,
    '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${(minMs / 1_000).toFixed(3)}`, '-f', 'null', '-',
  ], 'detect pauses', { timeoutMs: PROBE_TIMEOUT_MS * 4 });
  const silences: Array<{ startMs: number; endMs: number }> = [];
  let open: number | undefined;
  for (const match of stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    const at = start + Math.round(Number(match[2]) * 1_000);
    if (match[1] === 'start') open = at;
    else {
      silences.push({ startMs: open ?? start, endMs: at });
      open = undefined;
    }
  }
  if (open !== undefined) silences.push({ startMs: open, endMs: toMs });
  return silences;
}

/** Mono 16 kHz WAV of the whole source, the input Whisper expects. */
export async function extractSpeechAudio(ffmpeg: string, source: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await mustRun(ffmpeg, ['-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', path], 'extract audio for transcription', { timeoutMs: STEP_TIMEOUT_MS * 2 });
}

export async function extractThumbnail(ffmpeg: string, master: string, atMs: number, path: string, width = 480): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await mustRun(ffmpeg, [
    '-ss', seconds(atMs), '-i', master, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', '-y', path,
  ], 'extract a thumbnail', { timeoutMs: PROBE_TIMEOUT_MS });
}

/** Tile images (same size, in order) into one sheet. Order is the caller's record of what is where. */
export async function tileImages(ffmpeg: string, images: string[], path: string, columns: number): Promise<void> {
  const staging = `${path}.tiles`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await Promise.all(images.map((image, index) => copyFile(image, join(staging, `${String(index).padStart(3, '0')}.jpg`))));
    const cols = Math.min(columns, images.length);
    const rows = Math.ceil(images.length / cols);
    await mustRun(ffmpeg, [
      '-framerate', '1', '-i', join(staging, '%03d.jpg'),
      '-vf', `tile=${cols}x${rows}:padding=8:color=white`, '-frames:v', '1', '-q:v', '3', '-y', path,
    ], 'build a contact sheet', { timeoutMs: PROBE_TIMEOUT_MS });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Encode one vertical video segment (no audio; the short's audio is rendered once, whole). */
export async function renderSegment(
  ffmpeg: string,
  master: string,
  info: MasterInfo,
  segment: RenderSegment,
  capabilities: Capabilities,
  path: string,
): Promise<void> {
  // Exact frame counts (cuts are already on the frame grid) keep the joined video as long as the audio.
  const frames = Math.max(1, Math.round(((segment.outMs - segment.inMs) / 1_000) * info.fps));
  await mustRun(ffmpeg, [
    '-ss', seconds(segment.inMs), '-i', master,
    '-filter_complex', videoGraph(segment.layout, info.width, info.height),
    '-map', '[v]', '-frames:v', String(frames), '-an', ...capabilities.videoCodecArgs, '-y', path,
  ], `render ${basename(path)}`);
}

export interface AudioCut {
  inMs: number;
  outMs: number;
  /** Edges with no pause found get a longer fade to soften a clipped sound. */
  softIn?: boolean;
  softOut?: boolean;
}

const EDGE_FADE_SEC = 0.02;
const SOFT_FADE_SEC = 0.08;

/**
 * Join video segments, render the audio once per cut straight from the master (fades only at
 * real cut edges, so camera changes inside a cut never dip the sound), normalize to about -14 LUFS,
 * and mux.
 */
export async function assembleShort(
  ffmpeg: string,
  master: string,
  segments: string[],
  cuts: AudioCut[],
  path: string,
  hasAudio: boolean,
): Promise<void> {
  const list = `${path}.txt`;
  const video = `${path}.video.mp4`;
  const audio = `${path}.audio.m4a`;
  await writeFile(list, segments.map((segment) => `file '${segment.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await mustRun(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-an', '-y', video], 'join segments');
    if (!hasAudio) {
      await mustRun(ffmpeg, ['-i', video, '-c', 'copy', '-movflags', '+faststart', '-y', path], 'finish the short');
      return;
    }
    const inputs = cuts.flatMap((cut) => ['-ss', seconds(cut.inMs), '-t', seconds(cut.outMs - cut.inMs), '-i', master]);
    const chains = cuts.map((cut, index) => {
      const duration = (cut.outMs - cut.inMs) / 1_000;
      const fadeIn = Math.min(cut.softIn ? SOFT_FADE_SEC : EDGE_FADE_SEC, duration / 4);
      const fadeOut = Math.min(cut.softOut ? SOFT_FADE_SEC : EDGE_FADE_SEC, duration / 4);
      return `[${index}:a:0]aresample=48000,atrim=end=${duration.toFixed(4)},asetpts=PTS-STARTPTS,afade=t=in:d=${fadeIn.toFixed(3)},` +
        `afade=t=out:st=${(duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[a${index}]`;
    });
    const graph = `${chains.join(';')};${cuts.map((_, index) => `[a${index}]`).join('')}concat=n=${cuts.length}:v=0:a=1,loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
    await mustRun(ffmpeg, [...inputs, '-filter_complex', graph, '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-y', audio], 'render audio');
    await mustRun(ffmpeg, ['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', '-y', path], 'mux video and audio');
  } finally {
    await Promise.all([list, video, audio].map((file) => rm(file, { force: true })));
  }
}

export async function burnCaptions(ffmpeg: string, video: string, ass: string, path: string, capabilities: Capabilities): Promise<void> {
  // Run inside the captions directory so the filter argument needs no path escaping.
  await mustRun(ffmpeg, [
    '-i', basename(video), '-vf', `subtitles=${basename(ass)}`, ...capabilities.videoCodecArgs,
    '-c:a', 'copy', '-movflags', '+faststart', '-y', basename(path),
  ], 'burn captions', { cwd: dirname(video) });
}

export async function previewSheet(ffmpeg: string, video: string, durationMs: number, path: string): Promise<void> {
  const frames = [0.1, 0.5, 0.9].map((fraction) => Math.round(durationMs * fraction));
  const images = frames.map((_, index) => `${path}.${index}.jpg`);
  try {
    await Promise.all(frames.map((atMs, index) => extractThumbnail(ffmpeg, video, atMs, images[index]!, 360)));
    await tileImages(ffmpeg, images, path, 3);
  } finally {
    await Promise.all(images.map((image) => rm(image, { force: true })));
  }
}

