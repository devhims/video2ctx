import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveFfmpegExecutable } from '../watch/ffmpeg';
import { MediaError, extractThumbnail, probeMaster } from '../shorts/media';
import {
  checkShort,
  composeDescription,
  momentUrl,
  parsePublishPlan,
  publishSheet,
  type KitIssue,
} from './kit';
import { AuthError, getAccessToken, parseClientSecret, tokenPath } from './auth';
import { UploadError, uploadVideo, type Privacy } from './upload';

const HELP = `youtube-shorts-publish

Check publishing copy for rendered Shorts against YouTube's limits and write a
copy-paste sheet and cover frame per short. Prints one JSON value.

Usage:
  publish.mjs kit    --project <dir> [--ffmpeg-path <path>] [--pretty]
  publish.mjs upload --project <dir> --client-secret <file> [--only <id,...>]
                     [--privacy unlisted|private] [--variant <name>] [--dry-run] [--force]

Reads <project>/video.json, <project>/edl.json, <project>/publish.json, and
<project>/render/<id>-overlay.mp4 (or <id>.mp4). Writes <project>/publish/:
<id>.md (title, description, tags, related video, pinned comment, schedule),
<id>-cover.jpg (the frame at coverSec), and README.md (the schedule).

upload sends each short to YouTube with the Data API (videos.insert, resumable),
unlisted by default, using publish.json's title, description, hashtags, and tags.
It needs a "Desktop app" OAuth client JSON (--client-secret, or the
YOUTUBE_OAUTH_CLIENT environment variable) and asks for consent in the browser
once; the refresh token is saved under ~/.config/youtube-shorts-publish (mode
600). publish.json must declare "madeForKids". --variant uploads
render/<id>-<variant>.mp4 instead of <id>-overlay.mp4. Finished uploads are
recorded in publish/uploads.json and skipped on later runs unless --force.
Public posting stays in YouTube Studio.
`;

export interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

class InputError extends Error {
  readonly code = 'INVALID_INPUT';
}

class DependencyError extends Error {
  readonly code = 'DEPENDENCY_MISSING';
}

const COMMANDS: Record<string, string[]> = {
  kit: ['project', 'ffmpeg-path'],
  upload: ['project', 'client-secret', 'only', 'privacy', 'variant', 'ffmpeg-path'],
};
const BOOLEANS = new Set(['pretty', 'dry-run', 'force']);

function parse(argv: string[]): { command: 'kit' | 'upload'; flags: Record<string, string | true> } {
  const command = argv[0];
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    throw new InputError(command ? `Unknown command: ${command}. Run with --help.` : 'Missing command. Run with --help.');
  }
  const allowed = new Set([...COMMANDS[command]!, 'pretty', ...(command === 'upload' ? ['dry-run', 'force'] : [])]);
  const flags: Record<string, string | true> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index]!.replace(/^--/, '');
    if (!argv[index]!.startsWith('--') || !allowed.has(name)) {
      throw new InputError(`Unexpected argument: ${argv[index]}. Run with --help.`);
    }
    if (BOOLEANS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new InputError(`--${name} requires a value.`);
    flags[name] = value;
    index += 1;
  }
  if (typeof flags.project !== 'string') throw new InputError('--project is required.');
  return { command: command as 'kit' | 'upload', flags };
}

async function readJson(path: string, what: string): Promise<unknown> {
  const text = await readFile(path, 'utf8').catch(() => {
    throw new InputError(`${what} not found at ${path}.`);
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError(`${what} at ${path} is not valid JSON.`);
  }
}

const exists = async (path: string) => (await stat(path).catch(() => undefined))?.isFile() ?? false;

async function kit(flags: Record<string, string | true>, environment: NodeJS.ProcessEnv) {
  const project = resolve(flags.project as string);
  const video = await readJson(join(project, 'video.json'), 'video.json') as { videoId: string };
  const edl = await readJson(join(project, 'edl.json'), 'edl.json') as { shorts?: Array<{ id: string; cuts?: Array<{ startMs?: number }> }> };
  let plan;
  try {
    plan = parsePublishPlan(await readJson(join(project, 'publish.json'), 'publish.json'));
  } catch (error) {
    throw error instanceof InputError ? error : new InputError((error as Error).message);
  }
  const command = (typeof flags['ffmpeg-path'] === 'string' ? flags['ffmpeg-path'] : undefined) ?? environment.FFMPEG_PATH ?? 'ffmpeg';
  const ffmpeg = await resolveFfmpegExecutable(command, environment).catch(() => {
    throw new DependencyError('FFmpeg is required for cover frames. Install FFmpeg, set FFMPEG_PATH, or pass --ffmpeg-path.');
  });
  const episodeUrl = plan.episodeUrl ?? `https://youtu.be/${video.videoId}`;
  const directory = join(project, 'publish');
  await mkdir(directory, { recursive: true });
  const issues: KitIssue[] = [];
  const output = [];
  for (const short of plan.shorts) {
    const overlay = join(project, 'render', `${short.id}-overlay.mp4`);
    const plain = join(project, 'render', `${short.id}.mp4`);
    const file = (await exists(overlay)) ? overlay : (await exists(plain)) ? plain : undefined;
    if (!file) {
      issues.push({ short: short.id, level: 'error', message: `No rendered video at ${overlay} or ${plain}.` });
      continue;
    }
    const facts = await probeMaster(ffmpeg, file);
    const firstCut = edl.shorts?.find((item) => item.id === short.id)?.cuts?.[0]?.startMs;
    const moment = firstCut === undefined ? episodeUrl : momentUrl(video.videoId, firstCut);
    const description = composeDescription(short, episodeUrl, moment);
    issues.push(...checkShort(short, description, video.videoId, facts));
    const coverSec = Math.min(Math.max(short.coverSec ?? 1, 0), Math.max(facts.durationSec - 0.1, 0));
    const cover = join(directory, `${short.id}-cover.jpg`);
    await extractThumbnail(ffmpeg, file, Math.round(coverSec * 1_000), cover, facts.width);
    const related = short.relatedVideo ?? episodeUrl;
    const sheet = join(directory, `${short.id}.md`);
    await writeFile(sheet, publishSheet(short, description, related, cover, file));
    output.push({ id: short.id, title: short.title, video: file, cover, sheet, publishAt: short.publishAt, durationSec: Number(facts.durationSec.toFixed(1)) });
  }
  const schedule = [...output].sort((a, b) => (a.publishAt ?? '~').localeCompare(b.publishAt ?? '~'));
  await writeFile(join(directory, 'README.md'), [
    '# Publishing schedule',
    '',
    '| When | Short | Title | Length |',
    '|---|---|---|---|',
    ...schedule.map((item) => `| ${item.publishAt ?? 'unscheduled'} | ${item.id} | ${item.title.replaceAll('|', '\\|')} | ${item.durationSec}s |`),
    '',
    'Each short has a sheet (`<id>.md`) to paste into YouTube Studio and a cover frame (`<id>-cover.jpg`).',
    '',
  ].join('\n'));
  return { ok: !issues.some((issue) => issue.level === 'error'), directory, shorts: output, issues };
}

interface UploadRecord {
  videoId: string;
  url: string;
  privacy: Privacy;
  file: string;
  uploadedAt: string;
}

export interface UploadDependencies {
  fetch?: typeof fetch;
  openUrl?: (url: string) => void;
}

async function upload(flags: Record<string, string | true>, environment: NodeJS.ProcessEnv, io: CliIo, dependencies: UploadDependencies) {
  const project = resolve(flags.project as string);
  const video = await readJson(join(project, 'video.json'), 'video.json') as { videoId: string };
  const edl = await readJson(join(project, 'edl.json'), 'edl.json') as { shorts?: Array<{ id: string; cuts?: Array<{ startMs?: number }> }> };
  let plan;
  try {
    plan = parsePublishPlan(await readJson(join(project, 'publish.json'), 'publish.json'));
  } catch (error) {
    throw error instanceof InputError ? error : new InputError((error as Error).message);
  }
  if (typeof plan.madeForKids !== 'boolean') {
    throw new InputError('publish.json must set "madeForKids" to true or false before uploading; it is a legal declaration YouTube requires, so ask the user.');
  }
  const privacy = (flags.privacy ?? 'unlisted') as Privacy;
  if (privacy !== 'unlisted' && privacy !== 'private') throw new InputError('--privacy must be unlisted or private. Publish publicly from YouTube Studio.');
  const only = typeof flags.only === 'string' ? new Set(flags.only.split(',').map((id) => id.trim())) : undefined;
  const variant = typeof flags.variant === 'string' ? flags.variant : undefined;
  if (variant !== undefined && !/^[A-Za-z0-9_-]+$/.test(variant)) throw new InputError('--variant may use only letters, digits, - and _.');
  const shorts = plan.shorts.filter((short) => !only || only.has(short.id));
  if (only) for (const id of only) if (!plan.shorts.some((short) => short.id === id)) throw new InputError(`publish.json has no short ${id}.`);

  const command = (typeof flags['ffmpeg-path'] === 'string' ? flags['ffmpeg-path'] : undefined) ?? environment.FFMPEG_PATH ?? 'ffmpeg';
  const ffmpeg = await resolveFfmpegExecutable(command, environment).catch(() => {
    throw new DependencyError('FFmpeg is required to check each video before upload. Install FFmpeg, set FFMPEG_PATH, or pass --ffmpeg-path.');
  });
  const episodeUrl = plan.episodeUrl ?? `https://youtu.be/${video.videoId}`;
  const recordsPath = join(project, 'publish', 'uploads.json');
  const records = await readFile(recordsPath, 'utf8').then((text) => JSON.parse(text) as Record<string, UploadRecord>).catch(() => ({} as Record<string, UploadRecord>));

  // Check everything before uploading anything.
  const queue = [];
  const issues: KitIssue[] = [];
  for (const short of shorts) {
    const candidates = variant ? [join(project, 'render', `${short.id}-${variant}.mp4`)] : [join(project, 'render', `${short.id}-overlay.mp4`), join(project, 'render', `${short.id}.mp4`)];
    let file: string | undefined;
    for (const candidate of candidates) if (await exists(candidate)) { file = candidate; break; }
    if (!file) {
      issues.push({ short: short.id, level: 'error', message: `No video at ${candidates.join(' or ')}.` });
      continue;
    }
    const facts = await probeMaster(ffmpeg, file);
    const firstCut = edl.shorts?.find((item) => item.id === short.id)?.cuts?.[0]?.startMs;
    const description = composeDescription(short, episodeUrl, firstCut === undefined ? episodeUrl : momentUrl(video.videoId, firstCut));
    issues.push(...checkShort(short, description, video.videoId, facts).filter((issue) => issue.level === 'error'));
    const skipped = records[short.id] && flags.force !== true;
    queue.push({ short, file, description, skipped });
  }
  if (issues.length) return { ok: false, uploaded: [], issues };
  const planned = queue.map((item) => ({ id: item.short.id, title: item.short.title, file: item.file, privacy, skip: item.skipped ? `already uploaded: ${records[item.short.id]!.url}` : undefined }));
  if (flags['dry-run'] === true) return { ok: true, dryRun: true, planned, issues };
  if (queue.every((item) => item.skipped)) {
    return { ok: true, uploaded: [], skipped: planned.filter((item) => item.skip), issues };
  }

  const secretPath = (typeof flags['client-secret'] === 'string' ? flags['client-secret'] : undefined) ?? environment.YOUTUBE_OAUTH_CLIENT;
  if (!secretPath) throw new InputError('--client-secret (or YOUTUBE_OAUTH_CLIENT) must point to the Desktop app OAuth client JSON.');
  let client;
  try {
    client = parseClientSecret(await readJson(resolve(secretPath), 'OAuth client file'));
  } catch (error) {
    throw error instanceof AuthError || error instanceof InputError ? error : new InputError((error as Error).message);
  }
  const fetchImpl = dependencies.fetch ?? fetch;
  const accessToken = await getAccessToken(client, tokenPath(client, environment), { fetch: fetchImpl, openUrl: dependencies.openUrl, notify: io.stderr });

  const uploaded = [];
  for (const item of queue) {
    if (item.skipped) continue;
    const { videoId } = await uploadVideo(fetchImpl, accessToken, item.file, {
      title: item.short.title.trim(),
      description: item.description,
      tags: item.short.tags ?? [],
      categoryId: plan.categoryId ?? '22',
      privacy,
      madeForKids: plan.madeForKids,
    });
    const record: UploadRecord = { videoId, url: `https://youtube.com/shorts/${videoId}`, privacy, file: item.file, uploadedAt: new Date().toISOString() };
    records[item.short.id] = record;
    await mkdir(join(project, 'publish'), { recursive: true });
    await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`);
    uploaded.push({ id: item.short.id, ...record });
  }
  return {
    ok: true,
    uploaded,
    skipped: planned.filter((item) => item.skip),
    next: 'In YouTube Studio: pick each cover frame, set the related video, and post and pin the pinned comment.',
    issues,
  };
}

function errorPayload(error: unknown) {
  if (error instanceof UploadError || error instanceof AuthError) {
    return { error: { code: error.code, message: error.message, retryable: error instanceof UploadError ? error.retryable : false } };
  }
  if (error instanceof InputError || error instanceof DependencyError || error instanceof MediaError) {
    return { error: { code: error.code, message: error.message, retryable: false } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unexpected failure.', retryable: false } };
}

export async function runPublishCli(argv: string[], io: CliIo, environment: NodeJS.ProcessEnv = process.env, dependencies: UploadDependencies = {}): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') {
    io.stdout(HELP);
    return 0;
  }
  try {
    const { command, flags } = parse(argv);
    const result = command === 'kit' ? await kit(flags, environment) : await upload(flags, environment, io, dependencies);
    io.stdout(`${JSON.stringify(result, null, flags.pretty === true ? 2 : undefined)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify(errorPayload(error))}\n`);
    return error instanceof InputError ? 2 : 1;
  }
}
