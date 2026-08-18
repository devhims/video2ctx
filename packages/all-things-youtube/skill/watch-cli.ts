import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { YouTubeClientError } from '../src';
import {
  extractFrames,
  getWatchIndex,
} from './watch/workflow';
import type {
  ExtractFramesRequest,
  WatchIndexRequest,
} from './watch/types';
import { createRequestFetch, type FetchResource } from './cli';

const HELP = `youtube-watch

Inspect a YouTube storyboard and transcript, then extract exact timestamped frames.

Usage:
  watch.mjs index --video-id <id> [options]
  watch.mjs frames --workspace <path> --timestamps <seconds,...> [options]
  watch.mjs cleanup --workspace <path> [--pretty]

Shared options:
  --proxy <url>                   HTTP(S) proxy; defaults to OUTBOUND_PROXY_URL
  --pretty                        Pretty-print JSON

Index options:
  --video-id <id>                Required 11-character YouTube video ID
  --lang <code>                  Desired transcript language
  --granularity segment|word     Transcript timing detail; default segment

Frame options:
  --workspace <path>             Workspace returned by index
  --timestamps <seconds,...>     One to 30 decimal timestamps
  --max-width <pixels>           Output width cap from 320 to 1920
  --ffmpeg-path <path>           FFmpeg executable; defaults to FFMPEG_PATH or ffmpeg
`;

const MARKER_FILE = '.youtube-watch-workspace.json';
const INDEX_FILE = 'index.json';
const WORKSPACE_PREFIX = 'youtube-watch-';

type Operation = 'index' | 'frames' | 'cleanup';
type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;

interface WorkspaceMarker {
  schema: 'youtube-watch-workspace';
  version: 1;
  videoId: string;
  createdAt: string;
}

export interface WatchCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface WatchCliDependencies {
  getWatchIndex?: (options: WatchIndexRequest) => Promise<unknown>;
  extractFrames?: (options: ExtractFramesRequest) => Promise<unknown>;
  createFetch?: (proxyUrl?: string) => FetchResource;
  createWorkspace?: () => Promise<string>;
}

class WatchCliInputError extends Error {
  readonly code = 'INVALID_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'WatchCliInputError';
  }
}

function parseArguments(argv: string[]): { operation: Operation; flags: Flags } {
  const operation = argv[0];
  if (!operation || !['index', 'frames', 'cleanup'].includes(operation)) {
    throw new WatchCliInputError(
      operation ? `Unknown operation: ${operation}. Run with --help.` : 'Missing operation. Run with --help.',
    );
  }
  const flags: Flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) throw new WatchCliInputError(`Unexpected argument: ${argument ?? ''}.`);
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (!name || Object.hasOwn(flags, name)) throw new WatchCliInputError(`Invalid repeated option: --${name}.`);
    if (name === 'pretty') {
      flags[name] = true;
      continue;
    }
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (!value || (equals === -1 && value.startsWith('--'))) {
      throw new WatchCliInputError(`--${name} requires a value.`);
    }
    flags[name] = value;
    if (equals === -1) index += 1;
  }
  const allowed: Record<Operation, string[]> = {
    index: ['video-id', 'lang', 'granularity', 'proxy', 'pretty'],
    frames: ['workspace', 'timestamps', 'max-width', 'ffmpeg-path', 'proxy', 'pretty'],
    cleanup: ['workspace', 'pretty'],
  };
  for (const name of Object.keys(flags)) {
    if (!allowed[operation as Operation].includes(name)) {
      throw new WatchCliInputError(`--${name} is not valid for ${operation}.`);
    }
  }
  return { operation: operation as Operation, flags };
}

function stringFlag(flags: Flags, name: string, required = false): string | undefined {
  const value = flags[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new WatchCliInputError(`--${name} is required.`);
  return value.trim();
}

function integerFlag(flags: Flags, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new WatchCliInputError(`--${name} must be an integer.`);
  return parsed;
}

function timestamps(flags: Flags): number[] {
  const value = stringFlag(flags, 'timestamps', true)!;
  const parts = value.split(',');
  if (parts.length < 1 || parts.length > 30) {
    throw new WatchCliInputError('--timestamps must contain between 1 and 30 values.');
  }
  const result = parts.map((part) => Number(part.trim()));
  if (result.some((seconds) => !Number.isFinite(seconds) || seconds < 0)) {
    throw new WatchCliInputError('--timestamps must contain non-negative seconds.');
  }
  return [...new Set(result.map((seconds) => Math.round(seconds * 1_000)))];
}

async function createWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
}

async function validateWorkspace(value: string): Promise<{ path: string; marker: WorkspaceMarker }> {
  const [temporaryRoot, workspace] = await Promise.all([realpath(tmpdir()), realpath(resolve(value))]);
  const pathFromTemporaryRoot = relative(temporaryRoot, workspace);
  if (!pathFromTemporaryRoot || pathFromTemporaryRoot.startsWith(`..${sep}`)
    || pathFromTemporaryRoot === '..' || isAbsolute(pathFromTemporaryRoot)
    || !basename(workspace).startsWith(WORKSPACE_PREFIX)) {
    throw new WatchCliInputError('The workspace is not a youtube-watch temporary directory.');
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(join(workspace, MARKER_FILE), 'utf8'));
  } catch {
    throw new WatchCliInputError('The workspace marker is missing or invalid.');
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new WatchCliInputError('The workspace marker is invalid.');
  }
  const record = marker as Record<string, unknown>;
  if (record.schema !== 'youtube-watch-workspace' || record.version !== 1
    || typeof record.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(record.videoId)) {
    throw new WatchCliInputError('The workspace marker is invalid.');
  }
  return { path: workspace, marker: record as unknown as WorkspaceMarker };
}

function errorPayload(error: unknown): { error: Record<string, unknown> } {
  if (error instanceof YouTubeClientError) {
    return { error: {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
    } };
  }
  if (error instanceof WatchCliInputError) {
    return { error: { code: error.code, message: error.message, retryable: false } };
  }
  return { error: {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unexpected youtube-watch failure.',
    retryable: false,
  } };
}

export async function runWatchCli(
  argv: string[],
  io: WatchCliIo,
  environment: Record<string, string | undefined> = process.env,
  dependencies: WatchCliDependencies = {},
): Promise<number> {
  if (argv.includes('--help') || (argv.length === 1 && argv[0] === 'help')) {
    io.stdout(HELP);
    return 0;
  }
  let fetchResource: FetchResource | undefined;
  let uncommittedWorkspace: string | undefined;
  try {
    const { operation, flags } = parseArguments(argv);
    if (operation === 'cleanup') {
      const workspace = await validateWorkspace(stringFlag(flags, 'workspace', true)!);
      await rm(workspace.path, { recursive: true, force: true });
      io.stdout(`${JSON.stringify({ workspace: workspace.path, cleaned: true }, null, flags.pretty ? 2 : undefined)}\n`);
      return 0;
    }

    const proxyUrl = stringFlag(flags, 'proxy') ?? environment.OUTBOUND_PROXY_URL;
    fetchResource = (dependencies.createFetch ?? createRequestFetch)(proxyUrl);
    if (operation === 'index') {
      const videoId = stringFlag(flags, 'video-id', true)!;
      const granularity = stringFlag(flags, 'granularity');
      if (granularity && !['segment', 'word'].includes(granularity)) {
        throw new WatchCliInputError('--granularity must be segment or word.');
      }
      const workspace = await (dependencies.createWorkspace ?? createWorkspace)();
      uncommittedWorkspace = workspace;
      const marker: WorkspaceMarker = {
        schema: 'youtube-watch-workspace', version: 1, videoId, createdAt: new Date().toISOString(),
      };
      await writeFile(join(workspace, MARKER_FILE), JSON.stringify(marker));
      const result = await (dependencies.getWatchIndex ?? getWatchIndex)({
        videoId,
        outputDir: workspace,
        lang: stringFlag(flags, 'lang'),
        granularity: granularity as 'segment' | 'word' | undefined,
        fetch: fetchResource.fetch,
      });
      await writeFile(join(workspace, INDEX_FILE), JSON.stringify(result));
      uncommittedWorkspace = undefined;
      io.stdout(`${JSON.stringify({ workspace, ...(result as object) }, null, flags.pretty ? 2 : undefined)}\n`);
      return 0;
    }

    const workspace = await validateWorkspace(stringFlag(flags, 'workspace', true)!);
    const result = await (dependencies.extractFrames ?? extractFrames)({
      videoId: workspace.marker.videoId,
      timestampsMs: timestamps(flags),
      outputDir: workspace.path,
      maxWidth: integerFlag(flags, 'max-width'),
      ffmpegPath: stringFlag(flags, 'ffmpeg-path'),
      fetch: fetchResource.fetch,
    });
    io.stdout(`${JSON.stringify({ workspace: workspace.path, ...(result as object) }, null, flags.pretty ? 2 : undefined)}\n`);
    return 0;
  } catch (error) {
    if (uncommittedWorkspace) await rm(uncommittedWorkspace, { recursive: true, force: true }).catch(() => undefined);
    io.stderr(`${JSON.stringify(errorPayload(error))}\n`);
    return error instanceof WatchCliInputError ? 2 : 1;
  } finally {
    await fetchResource?.close();
  }
}
