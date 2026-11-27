import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, homedir, tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

import { YouTubeClientError, getDetails, getTranscript, type Transcript } from 'all-things-youtube';
import { createRequestFetch } from '../direct/cli';
import { resolveFfmpegExecutable } from '../watch/ffmpeg';
import {
  buildCues,
  captionText,
  captionWords,
  parseEdl,
  renderSegments,
  resolveShorts,
  toAss,
  toSrt,
  type Edl,
  type Issue,
  type ResolvedCut,
  type ResolvedShort,
  snapCutToSilence,
  alignCutToFrames,
} from './edl';
import {
  MediaError,
  runFfmpeg,
  audioLevelDb,
  burnCaptions,
  detectAllShotChanges,
  detectCapabilities,
  detectSceneChanges,
  grayFrame,
  detectSilences,
  mergeShotChanges,
  extractSpeechAudio,
  extractThumbnail,
  assembleShort,
  previewSheet,
  probeMaster,
  renderSegment,
  tileImages,
  type MasterInfo,
} from './media';
import { EDGE_WINDOW_MS, edgeHasSpeech, edgeHuggingChanges, flashShots, overlayVideoProblem } from './check';
import { FIT_AREAS, applyFit, drawnBox, fitFor, forMeasuring, hasFitTarget, unionBox, type SceneFit } from './fit';
import { OVERLAY_SFX, buildOverlay, sceneWindows, type SfxKey } from './overlay';
import { detectFaces } from './faces';
import { openYouTubeSource } from './source';
import { runCommand, ytDlpArgs } from './ytdlp';
import { dtwPreset, parseWhisperCliJson, whisperToTranscript } from './transcribe';
import { DEFAULT_IDLE_MS, REVIEW_FILE, projectState, resolveComments, startReviewServer } from './review';
import { ShortsInputError, flattenWords, formatTime, parseChapters, renderTranscript, type Word } from './transcript';

const HELP = `youtube-shorts

Plan and render vertical Shorts from a long YouTube video. Prints one JSON value.

Usage:
  shorts.mjs read   --video-id <id> --project <dir> [--lang <code>] [--proxy <url>]
  shorts.mjs plan   --project <dir>
  shorts.mjs shots  --project <dir> (--master <file> | --from-youtube) [--only <id,...>] [--scene <0-1>]
  shorts.mjs render --project <dir> (--master <file> | --from-youtube) [--only <id,...>]
  shorts.mjs overlay --project <dir> [--only <id,...>]
  shorts.mjs check  --project <dir> [--master <file>] [--only <id,...>] [--variant <name>]
  shorts.mjs fit    --project <dir> [--only <id,...>]
  shorts.mjs fetch  --project <dir> [--max-height <px>]
  shorts.mjs transcribe --project <dir> (--master <file> | --from-youtube) [--model small.en]
  shorts.mjs review --project <dir> [--port <n>] [--idle-minutes <n>]
  shorts.mjs decisions --project <dir> [--resolve <comment-id,...>]

Commands:
  read    Fetch metadata and a word-timed transcript into the project:
          video.json, words.json, and transcript.md (timestamped paragraphs)
  plan    Resolve <project>/edl.json cuts from quoted phrases to word-accurate times,
          attach corrected caption text, and report errors and warnings
  shots   Find camera cuts inside each short on the master file and write one
          thumbnail per shot plus a contact sheet per short under <project>/shots
  render  Write <project>/render/<id>.mp4 (1080x1920, loudness-normalized),
          <id>.srt, <id>.ass, <id>-preview.jpg, and <id>-captioned.mp4 when
          FFmpeg can burn subtitles. Moves each cut edge into the nearest
          pause in the audio and warns where none exists (likely clipped
          words); the final edges go to <id>.cuts.json for overlay
  fetch   Download a master with your own yt-dlp (best H.264 up to --max-height,
          default 1080, plus AAC audio) into <project>/source; pass the printed
          path to shots and render as --master. Only for videos you own or
          have permission to download
  transcribe
          Transcribe the source locally with whisper.cpp and DTW word timing
          when YouTube has no captions or they are unusable; writes the same
          words.json and transcript.md as read. Installs whisper.cpp and the
          model through HyperFrames on first use
  overlay Write a HyperFrames project per rendered short under <project>/overlay/<id>
          with the channel's wordmark, hook, name tag, context cards, captions,
          zooms, mounted scenes, and an end card with the source thumbnail after
          the last word, each placed clear of the faces detected in the short
          (macOS Vision); sound effects come from HyperFrames' bundled library.
          Render it with HyperFrames
  check   Check every rendered short for what a viewer notices: shots under
          1 s (flashes of the wrong framing), speech at a cut edge (a clipped
          word, or the next one starting; needs --master), cuts ending on a
          word that starts the next thought, an overlay project built from an
          older cut, and an overlay video that no longer matches its cut
  fit     Centre each scene's drawing in its area and size it to fill it: renders
          every scene on its own with HyperFrames, measures what its [data-fit]
          element draws, and writes the translate and scale into the scene's
          "fit" in edl.json, which overlay then applies. "fit": false skips one

Options:
  --master <file>       The creator's source file for this exact upload
  --from-youtube        Review copy: stream YouTube's own video with audio (usually
                        360p) instead of a master. Not publishing quality
  --only <id,...>       Limit shots, render, overlay or check to these short ids
  --variant <name>      Overlay video for check to compare: render/<id>-<name>.mp4; default overlay
  --scene <0-1>         Shot-change sensitivity; default 0.3 (lower finds more)
  --silence-db <dB>     Pause threshold for snapping cuts in render; default -35
                        (raise toward -30 for noisy rooms)
  --ffmpeg-path <path>  FFmpeg executable; defaults to FFMPEG_PATH or ffmpeg
  --yt-dlp-path <path>  yt-dlp executable for fetch; defaults to YT_DLP_PATH or yt-dlp
  --model <name>        Whisper model for transcribe; default small.en
  --whisper-path <path> whisper-cli for transcribe; defaults to WHISPER_CLI_PATH or whisper-cli
  --whisper-model <file> ggml model file; defaults to HyperFrames' cached model
  --proxy <url>         HTTP(S) proxy for YouTube requests; defaults to OUTBOUND_PROXY_URL
  --port <n>            Port for review; default a free one
  --idle-minutes <n>    Stop review after this long with no page open; default 30
  --resolve <id,...>    Comment ids for decisions to mark resolved
  --pretty              Pretty-print JSON
`;

/** HyperFrames CLI version the overlay projects were written against. */
const HYPERFRAMES_VERSION = '0.9.22';

const commandFlags = {
  read: ['video-id', 'project', 'lang', 'proxy'],
  plan: ['project'],
  shots: ['project', 'master', 'from-youtube', 'only', 'scene', 'ffmpeg-path', 'proxy'],
  render: ['project', 'master', 'from-youtube', 'only', 'ffmpeg-path', 'proxy', 'silence-db'],
  overlay: ['project', 'only', 'ffmpeg-path'],
  check: ['project', 'master', 'only', 'variant', 'ffmpeg-path'],
  fit: ['project', 'only', 'ffmpeg-path'],
  fetch: ['project', 'max-height', 'yt-dlp-path', 'ffmpeg-path', 'proxy'],
  transcribe: ['project', 'master', 'from-youtube', 'model', 'language', 'ffmpeg-path', 'proxy', 'whisper-path', 'whisper-model'],
  review: ['project', 'port', 'idle-minutes'],
  decisions: ['project', 'resolve'],
} as const;
type Command = keyof typeof commandFlags;
type Flags = Record<string, string | true>;
const BOOLEAN_FLAGS = new Set(['pretty', 'from-youtube']);

export interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export interface CliDependencies {
  getDetails?: typeof getDetails;
  getTranscript?: typeof getTranscript;
  /** The source video's thumbnail as JPEG bytes, or undefined when it cannot be fetched. */
  fetchThumbnail?: (videoId: string) => Promise<Uint8Array | undefined>;
  /** Bundled sound effects by library key, as files under `cache`. */
  resolveSfx?: (keys: string[], cache: string) => Promise<{ files: Record<string, string>; missing: string[] }>;
  /** Stops review in place of Ctrl-C or SIGTERM; used by tests. */
  reviewSignal?: AbortSignal;
}

class DependencyError extends Error {
  readonly code = 'DEPENDENCY_MISSING';
}

function parseArguments(argv: string[]): { command: Command; flags: Flags } {
  const command = argv[0];
  if (!command || !Object.hasOwn(commandFlags, command)) {
    throw new ShortsInputError(command ? `Unknown command: ${command}. Run with --help.` : 'Missing command. Run with --help.');
  }
  const flags: Flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) throw new ShortsInputError(`Unexpected argument: ${argument}.`);
    const name = argument.slice(2);
    if (Object.hasOwn(flags, name)) throw new ShortsInputError(`--${name} was provided more than once.`);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ShortsInputError(`--${name} requires a value.`);
    flags[name] = value;
    index += 1;
  }
  const allowed = new Set<string>([...commandFlags[command as Command], 'pretty']);
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) throw new ShortsInputError(`--${name} is not valid for ${command}. Run with --help.`);
  }
  return { command: command as Command, flags };
}

function required(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || !value.trim()) throw new ShortsInputError(`--${name} is required.`);
  return value;
}

function onlySet(flags: Flags): Set<string> | undefined {
  const value = flags.only;
  if (typeof value !== 'string') return undefined;
  return new Set(value.split(',').map((id) => id.trim()).filter(Boolean));
}

async function readJson(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ShortsInputError(`${what} not found at ${path}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ShortsInputError(`${what} at ${path} is not valid JSON.`);
  }
}

async function loadProject(project: string): Promise<{ words: Word[]; edl: Edl; video: Record<string, unknown> }> {
  const transcript = await readJson(join(project, 'words.json'), 'words.json (run read first)') as Transcript;
  const edl = parseEdl(await readJson(join(project, 'edl.json'), 'edl.json'));
  const video = await readJson(join(project, 'video.json'), 'video.json (run read first)') as Record<string, unknown>;
  if (edl.videoId !== video.videoId) {
    throw new ShortsInputError(`edl.json videoId ${edl.videoId} does not match video.json ${String(video.videoId)}.`);
  }
  return { words: flattenWords(transcript.segments), edl, video };
}

function errorsOf(issues: Issue[]): Issue[] {
  return issues.filter((issue) => issue.level === 'error');
}

async function resolveFfmpeg(flags: Flags, environment: NodeJS.ProcessEnv): Promise<string> {
  const command = (typeof flags['ffmpeg-path'] === 'string' ? flags['ffmpeg-path'] : undefined) ?? environment.FFMPEG_PATH ?? 'ffmpeg';
  try {
    return await resolveFfmpegExecutable(command, environment);
  } catch {
    throw new DependencyError('FFmpeg is required for shots and render. Install FFmpeg, set FFMPEG_PATH, or pass --ffmpeg-path.');
  }
}

interface PreparedMedia {
  master: string;
  label: string;
  ffmpeg: string;
  masterInfo: MasterInfo;
  warnings: string[];
  close(): Promise<void>;
}

async function prepareMedia(flags: Flags, environment: NodeJS.ProcessEnv, video: Record<string, unknown>): Promise<PreparedMedia> {
  const fromYouTube = flags['from-youtube'] === true;
  if (fromYouTube === (typeof flags.master === 'string')) {
    throw new ShortsInputError('Give exactly one source: --master <file> or --from-youtube.');
  }
  const ffmpeg = await resolveFfmpeg(flags, environment);
  const warnings: string[] = [];
  if (fromYouTube) {
    const proxy = (typeof flags.proxy === 'string' ? flags.proxy : undefined) ?? environment.OUTBOUND_PROXY_URL;
    const fetchResource = createRequestFetch(proxy);
    try {
      const source = await openYouTubeSource(ffmpeg, String(video.videoId), fetchResource.fetch);
      warnings.push(`Review copy from YouTube's ${source.info.width}x${source.info.height} stream: framing and audio are real, sharpness is not. Render from the master to publish, and clip only videos you own or have rights to.`);
      return {
        master: source.url,
        label: `youtube:${String(video.videoId)}${source.formatId ? ` (itag ${source.formatId})` : ''}`,
        ffmpeg,
        masterInfo: source.info,
        warnings,
        close: async () => { await source.close(); await fetchResource.close(); },
      };
    } catch (error) {
      await fetchResource.close();
      throw error;
    }
  }
  const master = resolve(required(flags, 'master'));
  const info = await stat(master).catch(() => undefined);
  if (!info?.isFile()) throw new ShortsInputError(`Master file not found: ${master}.`);
  const masterInfo = await probeMaster(ffmpeg, master);
  const expected = typeof video.durationSeconds === 'number' ? video.durationSeconds : undefined;
  if (expected !== undefined && Math.abs(masterInfo.durationSec - expected) > 2) {
    warnings.push(`Master runs ${masterInfo.durationSec.toFixed(1)}s but the upload runs ${expected}s. Transcript times only line up with the exact uploaded cut.`);
  }
  if (masterInfo.height < 1080) warnings.push(`Master is ${masterInfo.width}x${masterInfo.height}; a 9:16 crop will be upscaled and soft.`);
  if (!masterInfo.hasAudio) warnings.push('Master has no audio stream.');
  return { master, label: master, ffmpeg, masterInfo, warnings, close: async () => {} };
}

function requireResolved(words: Word[], edl: Edl, only?: Set<string>): { shorts: ResolvedShort[]; issues: Issue[] } {
  const result = resolveShorts(words, edl, only);
  const errors = errorsOf(result.issues);
  if (errors.length) {
    throw new ShortsInputError(`Fix edl.json first (run plan): ${errors.map((issue) => `${issue.short ?? ''} ${issue.message}`.trim()).join(' | ')}`);
  }
  return result;
}

interface VideoRecord {
  videoId: string;
  title: string;
  durationSeconds?: number;
  description?: string;
  [key: string]: unknown;
}

/** Write words.json and transcript.md from a word-timed transcript, and note its track in video.json. */
async function writeTranscript(project: string, video: VideoRecord, transcript: Transcript): Promise<number> {
  const words = flattenWords(transcript.segments);
  const chapters = parseChapters(video.description);
  await Promise.all([
    writeFile(join(project, 'video.json'), `${JSON.stringify({ ...video, track: transcript.track }, null, 2)}\n`),
    writeFile(join(project, 'words.json'), JSON.stringify(transcript)),
    writeFile(join(project, 'transcript.md'), renderTranscript(words, {
      title: video.title, videoId: video.videoId, durationSeconds: video.durationSeconds, chapters,
    })),
  ]);
  return words.length;
}

const NO_CAPTIONS = new Set(['CAPTIONS_UNAVAILABLE', 'NOT_FOUND']);

async function commandRead(flags: Flags, environment: NodeJS.ProcessEnv, dependencies: CliDependencies) {
  const videoId = required(flags, 'video-id');
  const project = resolve(required(flags, 'project'));
  const proxy = (typeof flags.proxy === 'string' ? flags.proxy : undefined) ?? environment.OUTBOUND_PROXY_URL;
  const fetchResource = createRequestFetch(proxy);
  try {
    const lang = typeof flags.lang === 'string' ? flags.lang : undefined;
    const details = await (dependencies.getDetails ?? getDetails)({ videoId, fetch: fetchResource.fetch });
    const chapters = parseChapters(details.description);
    const video: VideoRecord = {
      videoId,
      title: details.title,
      channel: details.channel,
      durationSeconds: details.durationSeconds,
      description: details.description,
      chapters: chapters.map((chapter) => ({ at: formatTime(chapter.startMs, false), startMs: chapter.startMs, title: chapter.title })),
    };
    await mkdir(project, { recursive: true });
    const files = {
      transcript: join(project, 'transcript.md'),
      words: join(project, 'words.json'),
      video: join(project, 'video.json'),
      edl: join(project, 'edl.json'),
    };
    let transcript: Transcript;
    try {
      transcript = await (dependencies.getTranscript ?? getTranscript)({ videoId, lang, granularity: 'word', fetch: fetchResource.fetch });
    } catch (error) {
      if (!(error instanceof YouTubeClientError) || !NO_CAPTIONS.has(error.code)) throw error;
      await writeFile(files.video, `${JSON.stringify({ ...video, track: null }, null, 2)}\n`);
      return {
        project,
        files: { video: files.video },
        video: { title: details.title, durationSeconds: details.durationSeconds, chapters: chapters.length },
        captions: 'unavailable',
        next: 'YouTube has no captions for this video. Run transcribe with --master <file> or --from-youtube to transcribe it locally with Whisper.',
        warnings: [error.message],
      };
    }
    const count = await writeTranscript(project, video, transcript);
    const warnings = [...(details.meta?.warnings ?? []), ...(transcript.meta?.warnings ?? [])];
    if (transcript.track?.kind === 'asr') warnings.push('Captions are auto-generated; build a glossary of misheard names before rendering.');
    return {
      project,
      files,
      video: { title: details.title, durationSeconds: details.durationSeconds, chapters: chapters.length },
      captions: 'youtube',
      words: count,
      warnings,
    };
  } finally {
    await fetchResource.close();
  }
}

async function resolveWhisper(flags: Flags, environment: NodeJS.ProcessEnv, model: string): Promise<{ cli: string; modelPath: string }> {
  const command = (typeof flags['whisper-path'] === 'string' ? flags['whisper-path'] : undefined) ?? environment.WHISPER_CLI_PATH ?? 'whisper-cli';
  const modelPath = resolve((typeof flags['whisper-model'] === 'string' ? flags['whisper-model'] : undefined)
    ?? join(environment.HOME ?? homedir(), '.cache', 'hyperframes', 'whisper', 'models', `ggml-${model}.bin`));
  const find = async () => ({
    cli: await resolveFfmpegExecutable(command, environment).catch(() => undefined),
    model: (await stat(modelPath).catch(() => undefined))?.isFile() ?? false,
  });
  let found = await find();
  if (!found.cli || !found.model) {
    // HyperFrames installs whisper.cpp and downloads the model on its first transcription.
    const npx = await resolveFfmpegExecutable('npx', environment).catch(() => undefined);
    if (npx) {
      const work = await mkdtemp(join(tmpdir(), 'shorts-whisper-setup-'));
      try {
        const ffmpeg = await resolveFfmpeg(flags, environment);
        const silence = join(work, 'silence.wav');
        await runCommand(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', silence]);
        await runCommand(npx, ['-y', `hyperframes@${HYPERFRAMES_VERSION}`, 'transcribe', silence, '--engine', 'whisper', '--model', model, '--json', '-d', work]);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
      found = await find();
    }
  }
  if (!found.cli) throw new DependencyError('whisper-cli (whisper.cpp) is not installed. Run `npx hyperframes transcribe <any audio>` once, install whisper-cpp, or pass --whisper-path.');
  if (!found.model) throw new DependencyError(`Whisper model not found at ${modelPath}. Run \`npx hyperframes transcribe <any audio> --model ${model}\` once, or pass --whisper-model.`);
  return { cli: found.cli, modelPath };
}

async function commandTranscribe(flags: Flags, environment: NodeJS.ProcessEnv) {
  const project = resolve(required(flags, 'project'));
  const video = await readJson(join(project, 'video.json'), 'video.json (run read first)') as VideoRecord;
  const model = typeof flags.model === 'string' ? flags.model : 'small.en';
  const language = typeof flags.language === 'string' ? flags.language : 'en';
  if (!/^[a-z0-9.-]+$/i.test(model) || !/^[a-z]{2,3}$/i.test(language)) throw new ShortsInputError('--model or --language has an unexpected value.');
  const whisper = await resolveWhisper(flags, environment, model);
  const media = await prepareMedia(flags, environment, video);
  const work = await mkdtemp(join(tmpdir(), 'shorts-whisper-'));
  try {
    const wav = join(work, 'speech-16k.wav');
    await extractSpeechAudio(media.ffmpeg, media.master, wav);
    const result = await runCommand(whisper.cli, [
      '-m', whisper.modelPath, '-f', wav, '-l', language,
      '--dtw', dtwPreset(model), '-nfa', '-ojf', '-of', join(work, 'whisper'), '-np',
      '-t', String(Math.max(1, Math.min(8, cpus().length))),
    ]);
    if (result.code !== 0) {
      const detail = result.stderr.trim().split('\n').slice(-3).join(' ');
      throw new MediaError(`Whisper transcription failed: ${detail}`, result.stderr);
    }
    const words = parseWhisperCliJson(await readJson(join(work, 'whisper.json'), 'whisper-cli output'));
    if (!words.length) throw new MediaError('Whisper found no speech in the source.');
    const count = await writeTranscript(project, video, whisperToTranscript(video.videoId, words, model, language));
    return {
      project,
      captions: `whisper:${model}`,
      words: count,
      files: { transcript: join(project, 'transcript.md'), words: join(project, 'words.json') },
      warnings: [...media.warnings, 'Whisper mishears names too: build the glossary as with YouTube captions. There are no speaker-change marks (>>).'],
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    await media.close();
  }
}

async function commandPlan(flags: Flags) {
  const project = resolve(required(flags, 'project'));
  const { words, edl } = await loadProject(project);
  const { shorts, issues } = resolveShorts(words, edl);
  const byId = new Map(shorts.map((short) => [short.spec.id, short]));
  for (const spec of edl.shorts) {
    const short = byId.get(spec.id);
    if (!short || short.cuts.length !== spec.cuts.length) continue;
    spec.cuts.forEach((cut, index) => {
      const resolved = short.cuts[index]!;
      cut.startMs = resolved.startMs;
      cut.endMs = resolved.endMs;
      cut.text = captionText(captionWords(words, { ...short, cuts: [resolved] }, edl.glossary));
    });
    spec.durationSec = Math.round(short.durationMs / 100) / 10;
  }
  await writeFile(join(project, 'edl.json'), `${JSON.stringify(edl, null, 2)}\n`);
  return {
    ok: errorsOf(issues).length === 0,
    edl: join(project, 'edl.json'),
    shorts: shorts.map((short) => ({
      id: short.spec.id,
      durationSec: Math.round(short.durationMs / 100) / 10,
      cuts: short.cuts.map((cut) => ({ start: formatTime(cut.startMs), end: formatTime(cut.endMs), startMs: cut.startMs, endMs: cut.endMs })),
    })),
    issues,
  };
}

async function commandShots(flags: Flags, environment: NodeJS.ProcessEnv) {
  const project = resolve(required(flags, 'project'));
  const { words, edl, video } = await loadProject(project);
  const threshold = typeof flags.scene === 'string' ? Number(flags.scene) : 0.3;
  if (!(threshold > 0 && threshold < 1)) throw new ShortsInputError('--scene must be between 0 and 1.');
  const { shorts, issues } = requireResolved(words, edl, onlySet(flags));
  const media = await prepareMedia(flags, environment, video);
  try {
    return await shotsFrom(project, shorts, media, threshold, issues);
  } finally {
    await media.close();
  }
}

async function shotsFrom(project: string, shorts: ResolvedShort[], media: PreparedMedia, threshold: number, issues: Issue[]) {
  const { master, ffmpeg, masterInfo, warnings } = media;
  const output = [];
  for (const short of shorts) {
    const directory = join(project, 'shots', short.spec.id);
    await rm(directory, { recursive: true, force: true });
    const shots: Array<{ n: number; atMs: number; at: string; durationSec: number; cut: number; thumb: string }> = [];
    for (const [cutIndex, cut] of short.cuts.entries()) {
      const all = await detectAllShotChanges(ffmpeg, master, cut.inMs, cut.outMs, threshold);
      const changes = mergeShotChanges(all, cut.inMs, cut.outMs);
      for (const hug of edgeHuggingChanges(all, cut.inMs, cut.outMs)) {
        const where = hug.edge === 'end' ? 'before this cut ends' : 'after this cut starts';
        issues.push({
          short: short.spec.id,
          level: 'warning',
          message: `cuts[${cutIndex}]: the source changes shot ${(hug.gapMs / 1_000).toFixed(2)}s ${where} (${formatTime(hug.atMs)}), which plays as a flash. ` +
            `${hug.edge === 'end' ? 'End the cut before it (pin endMs' : 'Start the cut after it (pin startMs'} if the phrase can't), or give that moment a layout entry that carries smoothly into the next shot.`,
        });
      }
      const starts = [cut.inMs, ...changes];
      for (const [index, startMs] of starts.entries()) {
        const endMs = starts[index + 1] ?? cut.outMs;
        const n = shots.length + 1;
        const thumb = join(directory, `${String(n).padStart(2, '0')}.jpg`);
        await extractThumbnail(ffmpeg, master, Math.round((startMs + endMs) / 2), thumb);
        shots.push({ n, atMs: startMs, at: formatTime(startMs), durationSec: Math.round((endMs - startMs) / 100) / 10, cut: cutIndex, thumb });
      }
    }
    const sheet = join(project, 'shots', `${short.spec.id}.jpg`);
    await tileImages(ffmpeg, shots.map((shot) => shot.thumb), sheet, 4);
    output.push({ id: short.spec.id, sheet, sheetOrder: 'left to right, top to bottom, matching n', shots });
  }
  return { master: { source: media.label, ...masterInfo }, shorts: output, warnings, issues };
}

async function commandRender(flags: Flags, environment: NodeJS.ProcessEnv) {
  const project = resolve(required(flags, 'project'));
  const { words, edl, video } = await loadProject(project);
  const { shorts, issues } = requireResolved(words, edl, onlySet(flags));
  const media = await prepareMedia(flags, environment, video);
  try {
    const silenceDb = typeof flags['silence-db'] === 'string' ? Number(flags['silence-db']) : -35;
    if (!(silenceDb < 0 && silenceDb > -90)) throw new ShortsInputError('--silence-db must be between -90 and 0.');
    return await renderFrom(project, words, edl, shorts, media, issues, silenceDb);
  } finally {
    await media.close();
  }
}

async function renderFrom(project: string, words: Word[], edl: Edl, shorts: ResolvedShort[], media: PreparedMedia, issues: Issue[], silenceDb: number) {
  const { master, ffmpeg, masterInfo, warnings } = media;
  const capabilities = await detectCapabilities(ffmpeg);
  if (!capabilities.canBurnCaptions) {
    warnings.push('This FFmpeg build has no subtitles filter (libass), so captions are written as .srt and .ass sidecars only.');
  }
  const directory = join(project, 'render');
  await mkdir(directory, { recursive: true });
  const output = [];
  for (let short of shorts) {
    const id = short.spec.id;
    const parts = join(directory, `${id}.parts`);
    await rm(parts, { recursive: true, force: true });
    await mkdir(parts, { recursive: true });
    const snapped: ResolvedCut[] = [];
    for (const [index, cut] of short.cuts.entries()) {
      // Strict threshold first; quieter-edged pauses only when the strict pass finds nothing.
      let result = snapCutToSilence(cut, [], `${id} cuts[${index}]`);
      if (masterInfo.hasAudio) {
        for (const [pass, db] of [silenceDb, silenceDb + 5, silenceDb + 9].entries()) {
          const silences = await detectSilences(ffmpeg, master, cut.startMs - 700, cut.endMs + 500, db, pass === 0 ? 50 : 40);
          result = snapCutToSilence(cut, silences, `${id} cuts[${index}]`);
          if (!result.notes.length) break;
        }
        warnings.push(...result.notes);
      }
      snapped.push(alignCutToFrames(result.cut, masterInfo.fps));
    }
    short = { ...short, cuts: snapped, durationMs: snapped.reduce((total, cut) => total + cut.outMs - cut.inMs, 0) };
    const segments = renderSegments(short, masterInfo.fps);
    const files: string[] = [];
    try {
      for (const [index, segment] of segments.entries()) {
        const file = join(parts, `${String(index).padStart(3, '0')}.mp4`);
        await renderSegment(ffmpeg, master, masterInfo, segment, capabilities, file);
        files.push(file);
      }
      const videoPath = join(directory, `${id}.mp4`);
      await assembleShort(ffmpeg, master, files, short.cuts, videoPath, masterInfo.hasAudio);
      const cues = buildCues(captionWords(words, short, edl.glossary));
      const srt = join(directory, `${id}.srt`);
      const ass = join(directory, `${id}.ass`);
      await writeFile(srt, toSrt(cues));
      await writeFile(join(directory, `${id}.cuts.json`), `${JSON.stringify({ id, cuts: short.cuts }, null, 2)}\n`);
      await writeFile(ass, toAss(cues, short.spec.hook));
      let captioned: string | undefined;
      if (capabilities.canBurnCaptions) {
        captioned = join(directory, `${id}-captioned.mp4`);
        await burnCaptions(ffmpeg, videoPath, ass, captioned, capabilities);
      }
      const rendered: MasterInfo = await probeMaster(ffmpeg, captioned ?? videoPath);
      if (Math.abs(rendered.durationSec * 1_000 - short.durationMs) > 300) {
        warnings.push(`${id} rendered at ${rendered.durationSec.toFixed(2)}s, expected ${(short.durationMs / 1_000).toFixed(2)}s.`);
      }
      const preview = join(directory, `${id}-preview.jpg`);
      await previewSheet(ffmpeg, captioned ?? videoPath, short.durationMs, preview);
      output.push({
        id,
        video: videoPath,
        captionedVideo: captioned,
        srt,
        ass,
        preview,
        durationSec: Math.round(rendered.durationSec * 10) / 10,
        size: `${rendered.width}x${rendered.height}`,
        segments: segments.map((segment) => ({ in: formatTime(segment.inMs), out: formatTime(segment.outMs), mode: segment.layout.mode })),
      });
    } finally {
      await rm(parts, { recursive: true, force: true });
    }
  }
  return { encoder: capabilities.encoder, captionsBurned: capabilities.canBurnCaptions, shorts: output, warnings, issues };
}

async function commandFetch(flags: Flags, environment: NodeJS.ProcessEnv) {
  const project = resolve(required(flags, 'project'));
  const video = await readJson(join(project, 'video.json'), 'video.json (run read first)') as Record<string, unknown>;
  const videoId = String(video.videoId);
  const maxHeight = typeof flags['max-height'] === 'string' ? Number(flags['max-height']) : 1080;
  if (!Number.isSafeInteger(maxHeight) || maxHeight < 144 || maxHeight > 4320) {
    throw new ShortsInputError('--max-height must be an integer from 144 to 4320.');
  }
  const ffmpeg = await resolveFfmpeg(flags, environment);
  const command = (typeof flags['yt-dlp-path'] === 'string' ? flags['yt-dlp-path'] : undefined) ?? environment.YT_DLP_PATH ?? 'yt-dlp';
  let ytDlp: string;
  try {
    ytDlp = await resolveFfmpegExecutable(command, environment);
  } catch {
    throw new DependencyError('yt-dlp is not installed. Install it yourself (https://github.com/yt-dlp/yt-dlp#installation), set YT_DLP_PATH, or pass --yt-dlp-path. Otherwise use the master file with --master.');
  }
  const directory = join(project, 'source');
  await mkdir(directory, { recursive: true });
  const proxy = (typeof flags.proxy === 'string' ? flags.proxy : undefined) ?? environment.OUTBOUND_PROXY_URL;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const result = await runCommand(ytDlp, ytDlpArgs({ videoId, directory, maxHeight, ffmpeg, nodeMajor, proxy }));
  const path = result.stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
  if (result.code !== 0 || !path) {
    const detail = result.stderr.trim().split('\n').filter((line) => /ERROR|WARNING/.test(line)).slice(-3).join(' ');
    throw new MediaError(`yt-dlp could not download ${videoId}. ${detail || 'See yt-dlp output for details.'} Check yt-dlp's own setup (a JavaScript runtime, and possibly a PO-token provider), or use the master file.`, result.stderr);
  }
  const info = await probeMaster(ffmpeg, path);
  const warnings: string[] = [];
  const expected = typeof video.durationSeconds === 'number' ? video.durationSeconds : undefined;
  if (expected !== undefined && Math.abs(info.durationSec - expected) > 2) {
    warnings.push(`Downloaded file runs ${info.durationSec.toFixed(1)}s but the upload runs ${expected}s.`);
  }
  if (info.height < maxHeight) warnings.push(`Best available was ${info.width}x${info.height}, below the requested ${maxHeight}p.`);
  if (!info.hasAudio) warnings.push('The downloaded file has no audio stream.');
  return { master: path, ...info, next: `Pass --master ${path} to shots and render.`, warnings };
}

async function downloadThumbnail(videoId: string): Promise<Uint8Array | undefined> {
  for (const name of ['maxresdefault', 'hqdefault']) {
    const response = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${name}.jpg`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (response?.ok) return new Uint8Array(await response.arrayBuffer());
  }
  return undefined;
}

/** HyperFrames' bundled sound effects, resolved offline (no account) into a per-project cache. */
function bundledSfx(environment: NodeJS.ProcessEnv) {
  return async (keys: string[], cache: string) => {
    await mkdir(cache, { recursive: true });
    const files: Record<string, string> = {};
    const missing: string[] = [];
    const npx = await resolveFfmpegExecutable('npx', environment).catch(() => undefined);
    for (const key of keys) {
      const target = join(cache, `${key}.mp3`);
      if ((await stat(target).catch(() => undefined))?.isFile()) {
        files[key] = target;
        continue;
      }
      const result = npx
        ? await runCommand(npx, ['-y', `hyperframes@${HYPERFRAMES_VERSION}`, 'media-use', 'resolve', '--type', 'sfx', '--intent', key, '--local-only', '--json', '-p', cache], 120_000).catch(() => undefined)
        : undefined;
      try {
        const found = JSON.parse(result?.stdout.trim().split('\n').at(-1) ?? '') as { ok?: boolean; path?: string; provenance?: { library_key?: string } };
        if (found.ok && found.path && found.provenance?.library_key === key) {
          await copyFile(resolve(cache, found.path), target);
          files[key] = target;
          continue;
        }
      } catch {
        // Not JSON: HyperFrames is missing or failed; reported below.
      }
      missing.push(key);
    }
    return { files, missing };
  };
}

/**
 * The short's final frame, sharp and blurred, for the end card to freeze on. Decodes the last
 * quarter second and keeps the last frame, since audio can run a frame past the video stream.
 */
async function extractEndFrames(ffmpeg: string, video: string, directory: string): Promise<{ freeze?: string; blur?: string }> {
  const output: { freeze?: string; blur?: string } = {};
  const variants = [
    ['freeze', 'freeze.jpg', 'scale=out_range=full', '2'],
    ['blur', 'freeze-blur.jpg', 'scale=1080:1920,gblur=sigma=38,hue=s=0.75,scale=out_range=full', '3'],
  ] as const;
  for (const [key, file, filter, quality] of variants) {
    const target = join(directory, file);
    await rm(target, { force: true });
    await runFfmpeg(ffmpeg, ['-loglevel', 'error', '-y', '-sseof', '-0.25', '-i', video, '-an', '-vf', filter, '-pix_fmt', 'yuvj420p', '-q:v', quality, '-update', '1', target]);
    if ((await stat(target).catch(() => undefined))?.isFile()) output[key] = `endcard/${file}`;
  }
  return output;
}

async function commandOverlay(flags: Flags, environment: NodeJS.ProcessEnv, dependencies: CliDependencies) {
  const project = resolve(required(flags, 'project'));
  const { words, edl } = await loadProject(project);
  const { shorts, issues } = requireResolved(words, edl, onlySet(flags));
  const ffmpeg = await resolveFfmpeg(flags, environment);
  const output = [];
  let thumbnail: Uint8Array | undefined | null = null;
  const resolveSfx = dependencies.resolveSfx ?? bundledSfx(environment);
  const sfxReported = new Set<string>();
  for (const short of shorts) {
    const id = short.spec.id;
    const video = join(project, 'render', `${id}.mp4`);
    if (!(await stat(video).catch(() => undefined))?.isFile()) {
      throw new ShortsInputError(`${video} not found. Run render for ${id} first.`);
    }
    const info = await probeMaster(ffmpeg, video);
    const manifest = await readJson(join(project, 'render', `${id}.cuts.json`), `${id}.cuts.json (rerun render for ${id})`) as { cuts?: ResolvedCut[] };
    if (!Array.isArray(manifest.cuts) || manifest.cuts.length !== short.cuts.length) {
      throw new ShortsInputError(`${id}.cuts.json does not match edl.json; rerun render for ${id}.`);
    }
    const rendered: ResolvedShort = { ...short, cuts: manifest.cuts };
    const directory = join(project, 'overlay', id);
    await mkdir(join(directory, 'assets'), { recursive: true });
    await copyFile(video, join(directory, 'assets', `${id}.mp4`));
    let hookImageFile: string | undefined;
    const hookImage = short.spec.overlay?.hookImage;
    if (hookImage) {
      const source = resolve(project, hookImage.src);
      if (!(await stat(source).catch(() => undefined))?.isFile()) throw new ShortsInputError(`${id} hookImage not found at ${source}.`);
      hookImageFile = `hook-image${extname(source).toLowerCase() || '.jpg'}`;
      await copyFile(source, join(directory, 'assets', hookImageFile));
    }
    const spec = short.spec.overlay ?? {};
    const durationSec = Math.floor(info.durationSec * 100) / 100;
    // Scenes: hand-made HyperFrames sub-compositions, copied in so a rerun keeps them.
    const sceneFiles: Array<{ compositionId: string; file: string } | undefined> = [];
    const sceneSfx = new Set<string>();
    for (const [index, scene] of (spec.scenes ?? []).entries()) {
      const source = resolve(project, scene.src);
      const text = await readFile(source, 'utf8').catch(() => undefined);
      if (text === undefined) throw new ShortsInputError(`${id} scene ${index + 1} not found at ${source}.`);
      const file = basename(source);
      if (sceneFiles.some((other) => other?.file === file)) throw new ShortsInputError(`${id} uses ${file} for two scenes; give each scene its own file.`);
      await mkdir(join(directory, 'compositions'), { recursive: true });
      if (scene.fit && !hasFitTarget(text)) issues.push({ short: id, level: 'warning', message: `${scene.src} has a fit but no [data-fit] element; it plays as written.` });
      await writeFile(join(directory, 'compositions', file), scene.fit && hasFitTarget(text) ? applyFit(text, scene.fit) : text);
      const compositionId = /data-composition-id="([^"]+)"/.exec(text)?.[1];
      sceneFiles.push(compositionId ? { compositionId, file } : undefined);
      for (const match of text.matchAll(/assets\/sfx\/([a-z0-9-]+)\.mp3/g)) sceneSfx.add(match[1]!);
    }
    let endCardFiles: { freeze?: string; blur?: string; thumbnail?: string } | undefined;
    if (edl.brand?.endCard) {
      await mkdir(join(directory, 'assets', 'endcard'), { recursive: true });
      endCardFiles = await extractEndFrames(ffmpeg, video, join(directory, 'assets', 'endcard'));
      if (!endCardFiles.freeze) issues.push({ short: id, level: 'warning', message: 'Could not extract the final frame; the end card plays on black.' });
      if (thumbnail === null) {
        thumbnail = await (dependencies.fetchThumbnail ?? downloadThumbnail)(edl.videoId).catch(() => undefined);
        if (!thumbnail) issues.push({ short: id, level: 'warning', message: `Could not fetch the thumbnail of ${edl.videoId}; the end card shows text only.` });
      }
      if (thumbnail) {
        await writeFile(join(directory, 'assets', 'endcard', 'thumbnail.jpg'), thumbnail);
        endCardFiles.thumbnail = 'endcard/thumbnail.jpg';
      }
    }
    const sfx: Partial<Record<SfxKey, string>> = {};
    if (edl.brand?.endCard || spec.zooms?.length || spec.scenes?.length) {
      const keys = [...new Set<string>([...OVERLAY_SFX, ...sceneSfx])];
      const found = await resolveSfx(keys, join(project, 'overlay', '.sfx'));
      await mkdir(join(directory, 'assets', 'sfx'), { recursive: true });
      for (const [key, path] of Object.entries(found.files)) {
        await copyFile(path, join(directory, 'assets', 'sfx', `${key}.mp3`));
        if ((OVERLAY_SFX as string[]).includes(key)) sfx[key as SfxKey] = `sfx/${key}.mp3`;
      }
      const missing = found.missing.filter((key) => !sfxReported.has(key));
      if (missing.length) {
        missing.forEach((key) => sfxReported.add(key));
        issues.push({ short: id, level: 'warning', message: `Sound effects not found (${missing.join(', ')}); those cues play silent. They come from \`npx hyperframes@${HYPERFRAMES_VERSION} media-use resolve --type sfx --local-only\`.` });
      }
    }
    const faces = await detectFaces(ffmpeg, video);
    if (faces) await writeFile(join(directory, 'faces.json'), `${JSON.stringify(faces)}\n`);
    else issues.push({ short: id, level: 'warning', message: 'Face detection needs macOS (Vision); placing overlays around typical face areas for each framing. Check snapshots closely.' });
    const plan = buildOverlay({
      id,
      faces,
      hookImageFile,
      endCardFiles,
      sfx,
      sceneFiles,
      short: rendered,
      words: captionWords(words, rendered, edl.glossary),
      segments: renderSegments(rendered),
      durationSec,
      videoFile: `${id}.mp4`,
      brand: edl.brand ?? {},
      speakers: edl.speakers ?? {},
      overlay: spec,
    });
    await Promise.all([
      writeFile(join(directory, 'index.html'), plan.html),
      writeFile(join(directory, 'hyperframes.json'), `${JSON.stringify({ paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' }, media: { autoProxy: true } }, null, 2)}\n`),
      writeFile(join(directory, 'meta.json'), `${JSON.stringify({ id: `${edl.videoId}-${id}`, name: short.spec.title ?? id }, null, 2)}\n`),
    ]);
    for (const message of plan.issues) issues.push({ short: id, level: 'warning', message });
    output.push({
      id,
      project: directory,
      durationSec: plan.durationSec,
      output: join(project, 'render', `${id}-overlay.mp4`),
      render: `npx hyperframes@${HYPERFRAMES_VERSION} render ${directory} -o ${join(project, 'render', `${id}-overlay.mp4`)}`,
    });
  }
  return { shorts: output, issues };
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function commandCheck(flags: Flags, environment: NodeJS.ProcessEnv) {
  const project = resolve(required(flags, 'project'));
  const { words, edl } = await loadProject(project);
  const { shorts, issues: planIssues } = requireResolved(words, edl, onlySet(flags));
  const ffmpeg = await resolveFfmpeg(flags, environment);
  const master = typeof flags.master === 'string' ? resolve(flags.master) : undefined;
  if (master && !(await stat(master).catch(() => undefined))?.isFile()) throw new ShortsInputError(`${master} not found.`);
  const variant = typeof flags.variant === 'string' ? flags.variant : 'overlay';
  const issues: Issue[] = planIssues.filter((issue) => / ends on "/.test(issue.message));
  const warnings: string[] = [];
  if (!master) warnings.push('Pass --master to check the audio at every cut edge.');
  const output = [];
  for (const short of shorts) {
    const id = short.spec.id;
    const cutVideo = join(project, 'render', `${id}.mp4`);
    const cutStat = await stat(cutVideo).catch(() => undefined);
    if (!cutStat?.isFile()) {
      issues.push({ short: id, level: 'warning', message: 'Not rendered yet; run render first.' });
      continue;
    }
    const cutInfo = await probeMaster(ffmpeg, cutVideo);

    const flashes = flashShots(await detectSceneChanges(ffmpeg, cutVideo), cutInfo.durationSec);
    for (const flash of flashes) {
      issues.push({
        short: id,
        level: 'error',
        message: `Flash shot: ${(flash.endSec - flash.startSec).toFixed(2)}s of a different framing at ${flash.startSec.toFixed(2)}-${flash.endSec.toFixed(2)}s. ` +
          'Move the cut edge before the source change, or put the layout entry on the first frame of the new shot.',
      });
    }

    const edges: Array<{ cut: number; startDb: number; endDb: number }> = [];
    if (master) {
      const manifest = await readJson(join(project, 'render', `${id}.cuts.json`), `${id}.cuts.json (rerun render for ${id})`) as { cuts?: ResolvedCut[] };
      for (const [index, cut] of (manifest.cuts ?? []).entries()) {
        const startDb = await audioLevelDb(ffmpeg, master, cut.inMs, EDGE_WINDOW_MS);
        const endDb = await audioLevelDb(ffmpeg, master, cut.outMs - EDGE_WINDOW_MS, EDGE_WINDOW_MS);
        edges.push({ cut: index, startDb: Math.round(startDb * 10) / 10, endDb: Math.round(endDb * 10) / 10 });
        if (edgeHasSpeech(startDb)) {
          issues.push({ short: id, level: 'warning', message: `cuts[${index}] starts on sound (${startDb.toFixed(0)} dB at ${formatTime(cut.inMs)}): the previous word may bleed in. Listen; start in the pause before the first word.` });
        }
        if (edgeHasSpeech(endDb)) {
          issues.push({ short: id, level: 'warning', message: `cuts[${index}] ends on sound (${endDb.toFixed(0)} dB at ${formatTime(cut.outMs)}): the last word may be clipped or the next one has begun. Listen; end in the pause after the last word, or pin endMs at the quietest moment between the two words.` });
        }
      }
    }

    const asset = join(project, 'overlay', id, 'assets', `${id}.mp4`);
    const assetStat = await stat(asset).catch(() => undefined);
    const staleProject = Boolean(assetStat?.isFile() && (assetStat.size !== cutStat.size || await fileDigest(asset) !== await fileDigest(cutVideo)));
    if (staleProject) {
      issues.push({ short: id, level: 'error', message: `overlay/${id} was built from an older cut; run overlay again before rendering it.` });
    }

    const overlayVideo = join(project, 'render', `${id}-${variant}.mp4`);
    const overlayStat = await stat(overlayVideo).catch(() => undefined);
    if (overlayStat?.isFile()) {
      const overlayInfo = await probeMaster(ffmpeg, overlayVideo);
      // `overlay` rewrites index.html on every run, so its time marks the project's latest revision.
      const projectStat = await stat(join(project, 'overlay', id, 'index.html')).catch(() => undefined);
      const problem = overlayVideoProblem(
        { durationSec: overlayInfo.durationSec, modifiedMs: overlayStat.mtimeMs },
        { durationSec: cutInfo.durationSec, modifiedMs: cutStat.mtimeMs },
        projectStat?.isFile() ? { modifiedMs: projectStat.mtimeMs } : undefined,
      );
      if (problem) issues.push({ short: id, level: 'error', message: `${basename(overlayVideo)} ${problem}.` });
    }

    output.push({
      id,
      durationSec: Math.round(cutInfo.durationSec * 100) / 100,
      flashShots: flashes,
      edges,
      overlayProject: assetStat?.isFile() ? (staleProject ? 'stale' : 'current') : 'none',
      overlayVideo: overlayStat?.isFile() ? overlayVideo : undefined,
    });
  }
  return { ok: !issues.some((issue) => issue.level === 'error'), shorts: output, issues, warnings };
}

/** Snapshot of a scene file rendered on its own: no footage, captions or wordmark to confuse the measurement. */
async function measureScene(ffmpeg: string, text: string, file: string, durationSec: number, mode: 'bottom' | 'full'): Promise<{ box?: { x1: number; y1: number; x2: number; y2: number }; error?: string }> {
  const compositionId = /data-composition-id="([^"]+)"/.exec(text)?.[1] ?? 'scene';
  const directory = await mkdtemp(join(tmpdir(), 'shorts-fit-'));
  try {
    await mkdir(join(directory, 'compositions'), { recursive: true });
    await writeFile(join(directory, 'compositions', file), forMeasuring(text));
    await writeFile(join(directory, 'hyperframes.json'), `${JSON.stringify({ paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' } }, null, 2)}\n`);
    await writeFile(join(directory, 'index.html'), [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="UTF-8" />',
      '<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>',
      '<style>* { margin: 0; padding: 0; box-sizing: border-box; } html, body { width: 1080px; height: 1920px; overflow: hidden; background: #000; } .scene { position: absolute; inset: 0; }</style>',
      '</head><body>',
      `<div id="root" data-composition-id="main" data-start="0" data-duration="${durationSec.toFixed(3)}" data-width="1080" data-height="1920">`,
      `<div id="${compositionId}" class="scene" data-composition-id="${compositionId}" data-composition-src="compositions/${file}" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="1" data-track-kind="graphics" data-width="1080" data-height="1920"></div>`,
      '</div>',
      '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["main"] = tl;</script>',
      '</body></html>',
    ].join('\n'));
    // The middle of the scene, and its final state just before it closes.
    const times = [0.35, 0.6, 0.85].map((share) => durationSec * share).concat(Math.max(0, durationSec - 0.3));
    const snaps = join(directory, 'snaps');
    const result = await runCommand('npx', ['-y', `hyperframes@${HYPERFRAMES_VERSION}`, 'snapshot', directory, '--at', times.map((at) => at.toFixed(2)).join(','), '--no-end', '-o', snaps], 180_000);
    if (result.code !== 0) return { error: `HyperFrames could not snapshot ${file}: ${result.stderr.trim().split('\n').slice(-2).join(' ')}` };
    const images = (await readdir(snaps).catch(() => [] as string[])).filter((name) => /^frame-.*\.png$/.test(name)).map((name) => join(snaps, name));
    if (!images.length) return { error: `HyperFrames wrote no snapshots for ${file}.` };
    // Quarter resolution is enough to place a drawing to within 4 px.
    const [width, height] = [270, 480];
    const rows: [number, number] = mode === 'bottom' ? [height / 2, height] : [0, height];
    const boxes = await Promise.all(images.map(async (image) => drawnBox(await grayFrame(ffmpeg, image, width, height), width, height, rows)));
    const box = unionBox(boxes);
    return box ? { box: { x1: box.x1 * 4, y1: box.y1 * 4, x2: box.x2 * 4, y2: box.y2 * 4 } } : { error: `Nothing drawn was found in ${file}; check it renders on its own.` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function commandFit(flags: Flags, environment: NodeJS.ProcessEnv) {
  const project = resolve(required(flags, 'project'));
  const { words, edl } = await loadProject(project);
  const { shorts, issues } = requireResolved(words, edl, onlySet(flags));
  const ffmpeg = await resolveFfmpeg(flags, environment);
  const edlPath = join(project, 'edl.json');
  const raw = JSON.parse(await readFile(edlPath, 'utf8')) as { shorts: Array<{ id: string; overlay?: { scenes?: Array<Record<string, unknown>> } }> };
  const fitted: Array<{ id: string; scene: string; mode: 'bottom' | 'full'; box: { x1: number; y1: number; x2: number; y2: number }; fit: SceneFit }> = [];
  let cleared = false;
  for (const short of shorts) {
    const id = short.spec.id;
    const scenes = short.spec.overlay?.scenes ?? [];
    if (!scenes.length) continue;
    const video = join(project, 'render', `${id}.mp4`);
    if (!(await stat(video).catch(() => undefined))?.isFile()) {
      issues.push({ short: id, level: 'warning', message: 'Not rendered yet; run render before fit.' });
      continue;
    }
    const info = await probeMaster(ffmpeg, video);
    const manifest = await readJson(join(project, 'render', `${id}.cuts.json`), `${id}.cuts.json (rerun render for ${id})`) as { cuts?: ResolvedCut[] };
    const rendered: ResolvedShort = { ...short, cuts: manifest.cuts ?? short.cuts };
    const texts = await Promise.all(scenes.map((scene) => readFile(resolve(project, scene.src), 'utf8').catch(() => undefined)));
    const windows = sceneWindows({
      id,
      short: rendered,
      words: captionWords(words, rendered, edl.glossary),
      segments: renderSegments(rendered),
      durationSec: Math.floor(info.durationSec * 100) / 100,
      videoFile: `${id}.mp4`,
      brand: edl.brand ?? {},
      speakers: edl.speakers ?? {},
      overlay: short.spec.overlay ?? {},
      sceneFiles: scenes.map((scene, index) => {
        const compositionId = texts[index] && /data-composition-id="([^"]+)"/.exec(texts[index]!)?.[1];
        return compositionId ? { compositionId, file: basename(scene.src) } : undefined;
      }),
    });
    const entry = raw.shorts.find((candidate) => candidate.id === id);
    for (const [index, scene] of scenes.entries()) {
      const text = texts[index];
      if (scene.fit === false) continue;
      if (text === undefined) {
        issues.push({ short: id, level: 'error', message: `scene ${index + 1} not found at ${scene.src}.` });
        continue;
      }
      if (!hasFitTarget(text)) {
        issues.push({ short: id, level: 'warning', message: `${scene.src} has no [data-fit] element; mark the drawing to fit (not the background) and run fit again.` });
        continue;
      }
      const window = windows.find((candidate) => candidate.file === basename(scene.src));
      if (!window) {
        issues.push({ short: id, level: 'warning', message: `${scene.src} isn't placed in the short (run overlay to see why); not fitted.` });
        continue;
      }
      if (window.expandSec !== undefined) {
        // fit measures one area. A scene that grows from the bottom half to the full frame has two,
        // and a scale chosen for the bottom half can push its full-frame artwork off screen.
        const rawScene = entry?.overlay?.scenes?.[index];
        const dropped = Boolean(rawScene && typeof rawScene.fit === 'object');
        if (dropped) {
          delete rawScene!.fit;
          cleared = true;
        }
        issues.push({ short: id, level: 'warning', message: `${scene.src} expands to the full frame at ${window.expandSec.toFixed(2)}s, so it isn't auto-fitted${dropped ? ' (its earlier fit was removed)' : ''}. Size its drawing to work in both the bottom half and the full frame, and check snapshots of both.` });
        continue;
      }
      const measured = await measureScene(ffmpeg, text, basename(scene.src), window.endSec - window.startSec, window.mode);
      if (!measured.box) {
        issues.push({ short: id, level: 'warning', message: measured.error ?? `${scene.src} could not be measured.` });
        continue;
      }
      const fit = fitFor(measured.box, window.mode);
      const area = FIT_AREAS[window.mode];
      if (fit.scale < 0.75) issues.push({ short: id, level: 'warning', message: `${scene.src} draws ${measured.box.x2 - measured.box.x1}x${measured.box.y2 - measured.box.y1} px and shrinks to ${fit.scale}x to fit ${area.maxWidth}x${area.maxHeight}; check its strokes and icons still read at phone size.` });
      const rawScene = entry?.overlay?.scenes?.[index];
      if (rawScene) rawScene.fit = fit;
      fitted.push({ id, scene: scene.src, mode: window.mode, box: measured.box, fit });
    }
  }
  if (fitted.length || cleared) await writeFile(edlPath, `${JSON.stringify(raw, null, 2)}\n`);
  return { edl: edlPath, scenes: fitted, next: fitted.length || cleared ? 'Run overlay to apply the fits, then snapshot each scene.' : undefined, issues };
}

async function commandReview(flags: Flags, io: CliIo, dependencies: CliDependencies): Promise<void> {
  const project = resolve(required(flags, 'project'));
  const port = typeof flags.port === 'string' ? Number(flags.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new ShortsInputError('--port must be an integer from 0 to 65535.');
  const idleMinutes = typeof flags['idle-minutes'] === 'string' ? Number(flags['idle-minutes']) : DEFAULT_IDLE_MS / 60_000;
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) throw new ShortsInputError('--idle-minutes must be a positive number.');
  const server = await startReviewServer({ project, port, idleMs: idleMinutes * 60_000 });
  const stop = () => void server.close();
  const signals = ['SIGINT', 'SIGTERM'] as const;
  if (dependencies.reviewSignal) dependencies.reviewSignal.addEventListener('abort', stop, { once: true });
  else for (const signal of signals) process.once(signal, stop);
  io.stdout(`${JSON.stringify({
    url: server.url,
    review: join(project, REVIEW_FILE),
    idleMinutes,
    next: 'Give the user the URL. The page records picks, hook choices, statuses, and timestamped comments in review.json; read it before the next step.',
  }, null, flags.pretty === true ? 2 : undefined)}\n`);
  await server.closed;
  if (!dependencies.reviewSignal) for (const signal of signals) process.off(signal, stop);
}

async function commandDecisions(flags: Flags): Promise<unknown> {
  const project = resolve(required(flags, 'project'));
  const info = await stat(project).catch(() => undefined);
  if (!info?.isDirectory()) throw new ShortsInputError(`Project directory not found: ${project}.`);
  const ids = typeof flags.resolve === 'string' ? flags.resolve.split(',').map((id) => id.trim()).filter(Boolean) : [];
  if (ids.length) await resolveComments(project, ids);
  const { review } = await projectState(project);
  return { review: join(project, REVIEW_FILE), ...(ids.length ? { resolved: ids } : {}), updatedAt: review.updatedAt, shorts: review.shorts };
}

function errorPayload(error: unknown): { error: Record<string, unknown> } {
  if (error instanceof YouTubeClientError) {
    return { error: { code: error.code, message: error.message, status: error.status, retryable: error.retryable } };
  }
  if (error instanceof ShortsInputError || error instanceof DependencyError || error instanceof MediaError) {
    return { error: { code: error.code, message: error.message, retryable: false } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unexpected failure.', retryable: false } };
}

export async function runShortsCli(
  argv: string[],
  io: CliIo,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  if (argv.includes('--help') || argv[0] === 'help' || !argv.length) {
    io.stdout(HELP);
    return 0;
  }
  try {
    const { command, flags } = parseArguments(argv);
    if (command === 'review') {
      await commandReview(flags, io, dependencies);
      return 0;
    }
    const result = command === 'read'
      ? await commandRead(flags, environment, dependencies)
      : command === 'plan'
        ? await commandPlan(flags)
        : command === 'shots'
          ? await commandShots(flags, environment)
          : command === 'render'
            ? await commandRender(flags, environment)
            : command === 'overlay'
              ? await commandOverlay(flags, environment, dependencies)
              : command === 'check'
                ? await commandCheck(flags, environment)
              : command === 'fit'
                ? await commandFit(flags, environment)
              : command === 'fetch'
                ? await commandFetch(flags, environment)
              : command === 'decisions'
                ? await commandDecisions(flags)
                : await commandTranscribe(flags, environment);
    io.stdout(`${JSON.stringify(result, null, flags.pretty === true ? 2 : undefined)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify(errorPayload(error))}\n`);
    return error instanceof ShortsInputError ? 2 : 1;
  }
}
