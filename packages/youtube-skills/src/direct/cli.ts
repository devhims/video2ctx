import { ProxyAgent, fetch as undiciFetch } from 'undici';
import {
  YouTubeClientError,
  getChannelInfo,
  getChannelPlaylists,
  getChannelVideos,
  getComments,
  getDetails,
  getEndscreen,
  getPlaylist,
  getTracks,
  getTranscript,
  search,
} from 'all-things-youtube';

const HELP = `youtube-direct

Call YouTube's internal HTTP endpoints from this machine and print JSON.

Usage:
  youtube.mjs <operation> [options]

Operations:
  search             Search videos, channels, and playlists
  tracks             List caption tracks and translation languages
  transcript         Get a timed transcript
  comments           Get one page or a bounded collection of comments
  details            Get video metadata
  endscreen          Get video end-screen elements
  channel-info       Get channel identity and About information
  channel-videos     Get one page from a channel's Videos tab
  channel-playlists  Get one page from a channel's Playlists tab
  playlist           Get playlist metadata and one page of videos

Shared options:
  --language <code>  YouTube interface language
  --region <code>    YouTube region
  --proxy <url>      HTTP(S) proxy; defaults to OUTBOUND_PROXY_URL
  --pretty           Pretty-print JSON
  --help             Show this help

Operation options:
  search:             --query <text> [--type video|channel|playlist|all]
                      [--channel-id <id>] [--duration short|medium|long]
                      [--captions-only] [--live live|completed]
                      [--min-views <count>] [--sort relevance|views]
                      [--continuation <token>]
  tracks:             --video-id <id>
  transcript:         --video-id <id> [--lang <code>]
                      [--format text|segments|words]
                      [--granularity segment|word]
  comments:           --video-id <id> [--continuation <token>]
                      [--all --max-pages <count>]
  details:            --video-id <id>
  endscreen:          --video-id <id>
  channel-info:       --channel-id <id-or-handle>
  channel-videos:     --channel-id <id-or-handle>
                      [--sort latest|popular|oldest] [--continuation <token>]
  channel-playlists:  --channel-id <id-or-handle>
                      [--sort newest|last-video-added] [--continuation <token>]
  playlist:           --playlist-id <id> [--continuation <token>]
`;

const operationFlags = {
  search: [
    'query', 'type', 'channel-id', 'duration', 'captions-only', 'live',
    'min-views', 'sort', 'continuation',
  ],
  tracks: ['video-id'],
  transcript: ['video-id', 'lang', 'format', 'granularity'],
  comments: ['video-id', 'continuation', 'all', 'max-pages'],
  details: ['video-id'],
  endscreen: ['video-id'],
  'channel-info': ['channel-id'],
  'channel-videos': ['channel-id', 'continuation', 'sort'],
  'channel-playlists': ['channel-id', 'continuation', 'sort'],
  playlist: ['playlist-id', 'continuation'],
} as const;

type OperationName = keyof typeof operationFlags;
type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;
type SkillOperation = (options: Record<string, unknown>) => Promise<unknown>;

export type SkillOperations = Record<OperationName, SkillOperation>;

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface FetchResource {
  fetch: typeof fetch;
  close(): Promise<void>;
}

export interface CliDependencies {
  operations?: Partial<SkillOperations>;
  createFetch?: (proxyUrl?: string) => FetchResource;
}

class CliInputError extends Error {
  readonly code = 'INVALID_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

const defaultOperations: SkillOperations = {
  search: search as unknown as SkillOperation,
  tracks: getTracks as unknown as SkillOperation,
  transcript: getTranscript as unknown as SkillOperation,
  comments: getComments as unknown as SkillOperation,
  details: getDetails as unknown as SkillOperation,
  endscreen: getEndscreen as unknown as SkillOperation,
  'channel-info': getChannelInfo as unknown as SkillOperation,
  'channel-videos': getChannelVideos as unknown as SkillOperation,
  'channel-playlists': getChannelPlaylists as unknown as SkillOperation,
  playlist: getPlaylist as unknown as SkillOperation,
};

const sharedFlags = ['language', 'region', 'proxy', 'pretty'] as const;
const booleanFlags = new Set(['all', 'captions-only', 'pretty']);

function isOperationName(value: string): value is OperationName {
  return Object.hasOwn(operationFlags, value);
}

function parseBoolean(value: string, flag: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CliInputError(`--${flag} must be true or false.`);
}

function parseArguments(argv: string[]): { operation: OperationName; flags: Flags } {
  const operation = argv[0];
  if (!operation || !isOperationName(operation)) {
    throw new CliInputError(
      operation ? `Unknown operation: ${operation}. Run with --help.` : 'Missing operation. Run with --help.',
    );
  }

  const flags: Flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) {
      throw new CliInputError(`Unexpected positional argument: ${argument ?? ''}.`);
    }

    const equalsIndex = argument.indexOf('=');
    const name = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!name) throw new CliInputError('Option names cannot be empty.');
    if (Object.hasOwn(flags, name)) throw new CliInputError(`--${name} was provided more than once.`);

    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    if (booleanFlags.has(name)) {
      if (inlineValue !== undefined) {
        flags[name] = parseBoolean(inlineValue, name);
      } else if (argv[index + 1] === 'true' || argv[index + 1] === 'false') {
        flags[name] = parseBoolean(argv[index + 1]!, name);
        index += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw new CliInputError(`--${name} requires a value.`);
    }
    flags[name] = value;
    if (inlineValue === undefined) index += 1;
  }

  const allowed = new Set<string>([...sharedFlags, ...operationFlags[operation]]);
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) {
      throw new CliInputError(`--${name} is not valid for ${operation}. Run with --help.`);
    }
  }

  return { operation, flags };
}

function optionalString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliInputError(`--${name} requires a non-empty value.`);
  }
  return value;
}

function requiredString(flags: Flags, name: string): string {
  const value = optionalString(flags, name);
  if (!value) throw new CliInputError(`--${name} is required.`);
  return value;
}

function optionalInteger(flags: Flags, name: string, minimum: number): number | undefined {
  const value = optionalString(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CliInputError(`--${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return parsed;
}

function optionalEnum<T extends string>(
  flags: Flags,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = optionalString(flags, name);
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) {
    throw new CliInputError(`--${name} must be one of: ${values.join(', ')}.`);
  }
  return value as T;
}

function compact(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function operationOptions(operation: OperationName, flags: Flags, requestFetch: typeof fetch) {
  const shared = {
    fetch: requestFetch,
    language: optionalString(flags, 'language'),
    region: optionalString(flags, 'region'),
  };

  switch (operation) {
    case 'search':
      return compact({
        ...shared,
        query: requiredString(flags, 'query'),
        type: optionalEnum(flags, 'type', ['video', 'channel', 'playlist', 'all']),
        channelId: optionalString(flags, 'channel-id'),
        duration: optionalEnum(flags, 'duration', ['short', 'medium', 'long']),
        captionsOnly: flags['captions-only'],
        live: optionalEnum(flags, 'live', ['live', 'completed']),
        minViews: optionalInteger(flags, 'min-views', 0),
        sort: optionalEnum(flags, 'sort', ['relevance', 'views']),
        continuation: optionalString(flags, 'continuation'),
      });
    case 'tracks':
      return compact({ ...shared, videoId: requiredString(flags, 'video-id') });
    case 'transcript':
      if (flags.format !== undefined && flags.granularity !== undefined) {
        throw new CliInputError('--format cannot be combined with --granularity.');
      }
      return compact({
        ...shared,
        videoId: requiredString(flags, 'video-id'),
        lang: optionalString(flags, 'lang'),
        granularity: transcriptGranularity(flags),
      });
    case 'comments': {
      const all = flags.all === true;
      const maxPages = optionalInteger(flags, 'max-pages', 1);
      if (all && flags.continuation !== undefined) {
        throw new CliInputError('--continuation cannot be combined with --all.');
      }
      if (!all && maxPages !== undefined) {
        throw new CliInputError('--max-pages requires --all.');
      }
      if (all && maxPages === undefined) {
        throw new CliInputError('--all requires an explicit --max-pages budget.');
      }
      return compact({
        ...shared,
        videoId: requiredString(flags, 'video-id'),
        continuation: optionalString(flags, 'continuation'),
        all: all || undefined,
        maxPages,
      });
    }
    case 'details':
    case 'endscreen':
      return compact({ ...shared, videoId: requiredString(flags, 'video-id') });
    case 'channel-info':
      return compact({ ...shared, channelId: requiredString(flags, 'channel-id') });
    case 'channel-videos':
      return compact({
        ...shared,
        channelId: requiredString(flags, 'channel-id'),
        continuation: optionalString(flags, 'continuation'),
        sort: optionalEnum(flags, 'sort', ['latest', 'popular', 'oldest']),
      });
    case 'channel-playlists':
      return compact({
        ...shared,
        channelId: requiredString(flags, 'channel-id'),
        continuation: optionalString(flags, 'continuation'),
        sort: optionalEnum(flags, 'sort', ['newest', 'last-video-added']),
      });
    case 'playlist':
      return compact({
        ...shared,
        playlistId: requiredString(flags, 'playlist-id'),
        continuation: optionalString(flags, 'continuation'),
      });
  }
}

function transcriptGranularity(flags: Flags): 'segment' | 'word' | undefined {
  const legacy = optionalEnum(flags, 'granularity', ['segment', 'word']);
  if (legacy) return legacy;
  const format = optionalEnum(flags, 'format', ['text', 'segments', 'words']);
  if (format === 'words') return 'word';
  if (format === 'text' || format === 'segments') return 'segment';
  return undefined;
}

function formatResult(operation: OperationName, flags: Flags, result: unknown): unknown {
  if (operation !== 'transcript' || !isRecord(result)) return result;
  const format = optionalEnum(flags, 'format', ['text', 'segments', 'words']);
  if (!format || format === 'words') return result;
  if (format === 'text') {
    return compact({
      videoId: result.videoId,
      track: result.track,
      translatedTo: result.translatedTo,
      text: result.text,
      meta: result.meta,
    });
  }
  const segments = Array.isArray(result.segments)
    ? result.segments.map((segment) => isRecord(segment)
      ? Object.fromEntries(Object.entries(segment).filter(([key]) => key !== 'words'))
      : segment)
    : result.segments;
  return { ...result, segments, granularity: 'segment' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createRequestFetch(proxyUrl?: string): FetchResource {
  if (!proxyUrl) {
    if (typeof globalThis.fetch !== 'function') {
      throw new CliInputError('This skill requires Node.js 18.17 or newer.');
    }
    return { fetch: globalThis.fetch, close: async () => {} };
  }

  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new CliInputError('The proxy URL is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new CliInputError('The proxy URL must use http:// or https://.');
  }

  const dispatcher = new ProxyAgent(proxyUrl);
  const proxiedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Response;
  }) as typeof fetch;

  return {
    fetch: proxiedFetch,
    close: async () => { await dispatcher.close(); },
  };
}

function errorPayload(error: unknown): { error: Record<string, unknown> } {
  if (error instanceof YouTubeClientError) {
    return {
      error: compact({
        code: error.code,
        message: error.message,
        status: error.status,
        retryable: error.retryable,
      }),
    };
  }
  if (error instanceof CliInputError) {
    return { error: { code: error.code, message: error.message, retryable: false } };
  }
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unexpected skill failure.',
      retryable: false,
    },
  };
}

export async function runSkillCli(
  argv: string[],
  io: CliIo,
  environment: Record<string, string | undefined> = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  if (argv.includes('--help') || (argv.length === 1 && argv[0] === 'help')) {
    io.stdout(HELP);
    return 0;
  }

  let fetchResource: FetchResource | undefined;
  try {
    const { operation, flags } = parseArguments(argv);
    const proxyUrl = optionalString(flags, 'proxy') ?? environment.OUTBOUND_PROXY_URL;
    fetchResource = (dependencies.createFetch ?? createRequestFetch)(proxyUrl);
    const operations = { ...defaultOperations, ...dependencies.operations };
    const result = await operations[operation](operationOptions(operation, flags, fetchResource.fetch));
    const spacing = flags.pretty === true ? 2 : undefined;
    io.stdout(`${JSON.stringify(formatResult(operation, flags, result), null, spacing)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify(errorPayload(error))}\n`);
    return error instanceof CliInputError ? 2 : 1;
  } finally {
    await fetchResource?.close();
  }
}
