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

const HELP = `youtube-shorts-publish

Check publishing copy for rendered Shorts against YouTube's limits and write a
copy-paste sheet and cover frame per short. Prints one JSON value.

Usage:
  publish.mjs kit --project <dir> [--ffmpeg-path <path>] [--pretty]

Reads <project>/video.json, <project>/edl.json, <project>/publish.json, and
<project>/render/<id>-overlay.mp4 (or <id>.mp4). Writes <project>/publish/:
<id>.md (title, description, tags, related video, pinned comment, schedule),
<id>-cover.jpg (the frame at coverSec), and README.md (the schedule).
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

function parse(argv: string[]): Record<string, string | true> {
  if (argv[0] !== 'kit') throw new InputError(argv[0] ? `Unknown command: ${argv[0]}. Run with --help.` : 'Missing command. Run with --help.');
  const flags: Record<string, string | true> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index]!.replace(/^--/, '');
    if (!argv[index]!.startsWith('--') || !['project', 'ffmpeg-path', 'pretty'].includes(name)) {
      throw new InputError(`Unexpected argument: ${argv[index]}. Run with --help.`);
    }
    if (name === 'pretty') {
      flags.pretty = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new InputError(`--${name} requires a value.`);
    flags[name] = value;
    index += 1;
  }
  if (typeof flags.project !== 'string') throw new InputError('--project is required.');
  return flags;
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

function errorPayload(error: unknown) {
  if (error instanceof InputError || error instanceof DependencyError || error instanceof MediaError) {
    return { error: { code: error.code, message: error.message, retryable: false } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unexpected failure.', retryable: false } };
}

export async function runPublishCli(argv: string[], io: CliIo, environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') {
    io.stdout(HELP);
    return 0;
  }
  try {
    const flags = parse(argv);
    const result = await kit(flags, environment);
    io.stdout(`${JSON.stringify(result, null, flags.pretty === true ? 2 : undefined)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify(errorPayload(error))}\n`);
    return error instanceof InputError ? 2 : 1;
  }
}
