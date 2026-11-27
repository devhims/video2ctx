import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';

import { reviewPage } from './review-page';
import { ShortsInputError, parseTime } from './transcript';

/** Extensions the review page may load from the project, and the type each is served as. */
const SERVED_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export const REVIEW_FILE = 'review.json';
export const REVIEW_STATUSES = ['pending', 'approved', 'changes', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
const MAX_COMMENT_CHARS = 2_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface ReviewComment {
  id: string;
  /** Seconds into `file` (or into the short when no file is given). */
  atSec: number;
  /** Project-relative video the comment was made on, such as render/S1-overlay.mp4. */
  file?: string;
  text: string;
  createdAt: string;
  /** Set by the agent once it has acted on the comment. */
  resolved?: boolean;
}

export interface ShortReview {
  /** Moments view: keep this candidate. */
  selected?: boolean;
  status?: ReviewStatus;
  /** Hooks view, on the base short: the chosen short id (the base itself or one of its -b/-c variants). */
  variant?: string;
  comments: ReviewComment[];
  [key: string]: unknown;
}

export interface Review {
  version: 1;
  updatedAt?: string;
  shorts: Record<string, ShortReview>;
}

export type ReviewAction =
  | { type: 'select'; short: string; selected: boolean }
  | { type: 'status'; short: string; status: ReviewStatus }
  | { type: 'variant'; short: string; choice: string }
  | { type: 'comment'; short: string; atSec: number; text: string; file?: string }
  | { type: 'uncomment'; short: string; id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads review.json leniently: anything unreadable becomes an empty review, and unknown fields are kept. */
export function parseReview(value: unknown): Review {
  const shorts: Record<string, ShortReview> = {};
  if (isRecord(value) && isRecord(value.shorts)) {
    for (const [id, entry] of Object.entries(value.shorts)) {
      if (!isRecord(entry)) continue;
      const comments = Array.isArray(entry.comments)
        ? entry.comments.filter((comment): comment is ReviewComment => isRecord(comment)
          && typeof comment.id === 'string' && typeof comment.text === 'string' && typeof comment.atSec === 'number')
        : [];
      shorts[id] = { ...entry, comments };
    }
  }
  return { version: 1, updatedAt: isRecord(value) && typeof value.updatedAt === 'string' ? value.updatedAt : undefined, shorts };
}

/** Reads review.json; a missing file is an empty review. With strict, an unparseable file throws instead of being treated as empty. */
export async function readReview(project: string, strict = false): Promise<Review> {
  let text: string;
  try {
    text = await readFile(join(project, REVIEW_FILE), 'utf8');
  } catch {
    return parseReview(undefined);
  }
  try {
    return parseReview(JSON.parse(text));
  } catch {
    if (strict) throw new ShortsInputError(`${REVIEW_FILE} is not valid JSON; fix or delete it before recording more decisions.`);
    return parseReview(undefined);
  }
}

/** The ids a review may refer to, from edl.json: every short, and each base short's -b/-c variants. */
export interface ReviewScope {
  shorts: Set<string>;
  variants: Map<string, string[]>;
}

export function applyReviewAction(review: Review, action: unknown, scope: ReviewScope, now = new Date()): Review {
  if (!isRecord(action) || typeof action.type !== 'string') throw new ShortsInputError('A review action needs a type.');
  const short = action.short;
  if (typeof short !== 'string' || !scope.shorts.has(short)) throw new ShortsInputError(`Unknown short: ${String(short)}.`);
  const next: Review = { ...review, shorts: { ...review.shorts } };
  const entry: ShortReview = { ...(next.shorts[short] ?? {}), comments: [...(next.shorts[short]?.comments ?? [])] };
  switch (action.type) {
    case 'select':
      if (typeof action.selected !== 'boolean') throw new ShortsInputError('select needs selected: true or false.');
      entry.selected = action.selected;
      break;
    case 'status':
      if (!REVIEW_STATUSES.includes(action.status as ReviewStatus)) {
        throw new ShortsInputError(`status must be one of ${REVIEW_STATUSES.join(', ')}.`);
      }
      entry.status = action.status as ReviewStatus;
      break;
    case 'variant': {
      const options = [short, ...(scope.variants.get(short) ?? [])];
      if (options.length < 2 || typeof action.choice !== 'string' || !options.includes(action.choice)) {
        throw new ShortsInputError(`choice must be one of ${options.join(', ')}.`);
      }
      entry.variant = action.choice;
      break;
    }
    case 'comment': {
      const text = typeof action.text === 'string' ? action.text.trim() : '';
      if (!text || text.length > MAX_COMMENT_CHARS) throw new ShortsInputError(`A comment needs 1 to ${MAX_COMMENT_CHARS} characters.`);
      if (typeof action.atSec !== 'number' || !Number.isFinite(action.atSec) || action.atSec < 0) {
        throw new ShortsInputError('A comment needs atSec, a time in seconds.');
      }
      if (action.file !== undefined && (typeof action.file !== 'string' || !/^render\/[A-Za-z0-9_-]+\.mp4$/.test(action.file))) {
        throw new ShortsInputError('A comment file must be a video under render/.');
      }
      entry.comments.push({
        id: randomBytes(4).toString('hex'),
        atSec: Math.round(action.atSec * 10) / 10,
        ...(action.file ? { file: action.file } : {}),
        text,
        createdAt: now.toISOString(),
      });
      entry.comments.sort((a, b) => a.atSec - b.atSec);
      break;
    }
    case 'uncomment':
      entry.comments = entry.comments.filter((comment) => comment.id !== action.id);
      break;
    default:
      throw new ShortsInputError(`Unknown review action: ${action.type}.`);
  }
  next.shorts[short] = entry;
  next.updatedAt = now.toISOString();
  return next;
}

/** Writes review.json whole and atomically, so an agent reading it never sees half a file. */
export async function writeReview(project: string, review: Review): Promise<void> {
  const path = join(project, REVIEW_FILE);
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`);
  await rename(temporary, path);
}

/**
 * Maps a URL path to a regular file inside the project, or undefined. Rejects traversal, dotfiles,
 * types the page has no use for, and symlinks that lead outside the project.
 */
export async function resolveProjectFile(project: string, urlPath: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const parts = decoded.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part.startsWith('.'))) return undefined;
  let root: string;
  let real: string;
  try {
    root = await realpath(project);
    real = await realpath(join(root, ...parts));
  } catch {
    return undefined;
  }
  if (!real.startsWith(root + sep)) return undefined;
  if (!SERVED_TYPES[extname(real).toLowerCase()] || !SERVED_TYPES[extname(parts.at(-1)!).toLowerCase()]) return undefined;
  const info = await stat(real).catch(() => undefined);
  return info?.isFile() ? real : undefined;
}

export interface StateCut {
  atMs?: number;
  durationMs?: number;
  /** What the cut says: plan's caption text, else the transcript paragraph, else the quoted phrases. */
  excerpt: string;
}

export interface StateVideo {
  label: string;
  path: string;
  src: string;
}

export interface StateShort {
  id: string;
  rank: number;
  title?: string;
  hook?: string;
  notes?: string;
  durationSec?: number;
  variantOf?: string;
  variants: string[];
  cuts: StateCut[];
  sheet?: string;
  preview?: string;
  videos: StateVideo[];
  snapshots: string[];
}

export interface ProjectState {
  version: string;
  title?: string;
  videoId?: string;
  edlError?: string;
  shorts: StateShort[];
  review: Review;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function listDirectory(path: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const names = await readdir(path).catch(() => [] as string[]);
  await Promise.all(names.map(async (name) => {
    if (name.startsWith('.')) return;
    const info = await stat(join(path, name)).catch(() => undefined);
    if (info?.isFile()) files.set(name, Math.round(info.mtimeMs));
  }));
  return files;
}

function fileUrl(path: string, mtimeMs: number): string {
  return `/files/${path.split('/').map(encodeURIComponent).join('/')}?v=${mtimeMs}`;
}

function parseParagraphs(markdown: string): { atMs: number; text: string }[] {
  const paragraphs: { atMs: number; text: string }[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\[(\d+:\d{2}(?::\d{2})?)\] (.+)$/.exec(line);
    if (match) paragraphs.push({ atMs: parseTime(match[1]!), text: match[2]! });
  }
  return paragraphs;
}

const VIDEO_ORDER = ['overlay', 'captioned', 'cut'];

/** Everything the page shows, read from files the other commands already write. */
export async function projectState(project: string): Promise<ProjectState> {
  const [edlRaw, video, transcript, review, render, shotFiles] = await Promise.all([
    readJsonFile(join(project, 'edl.json')).catch((error: unknown) => error instanceof SyntaxError ? new Error('edl.json is not valid JSON.') : new Error('No edl.json yet.')),
    readJsonFile(join(project, 'video.json')).catch(() => undefined),
    readFile(join(project, 'transcript.md'), 'utf8').catch(() => ''),
    readReview(project),
    listDirectory(join(project, 'render')),
    listDirectory(join(project, 'shots')),
  ]);
  const paragraphs = parseParagraphs(transcript);
  const rawShorts = isRecord(edlRaw) && Array.isArray(edlRaw.shorts)
    ? edlRaw.shorts.filter((short): short is Record<string, unknown> => isRecord(short) && typeof short.id === 'string' && /^[A-Za-z0-9_-]+$/.test(short.id))
    : [];
  const ids = rawShorts.map((short) => short.id as string);
  const idSet = new Set(ids);
  const baseOf = (id: string) => {
    const match = /^(.+)-([b-z])$/.exec(id);
    return match && idSet.has(match[1]!) ? match[1]! : undefined;
  };
  // A render file belongs to the longest short id it starts with, so S1-b.mp4 is S1-b's cut, not an S1 variant.
  const ownerOf = (stem: string) => ids
    .filter((id) => stem === id || stem.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0];

  let rank = 0;
  const shorts = await Promise.all(rawShorts.map(async (short): Promise<StateShort> => {
    const id = short.id as string;
    const variantOf = baseOf(id);
    const ownRank = variantOf ? 0 : (rank += 1);
    const cuts = (Array.isArray(short.cuts) ? short.cuts : []).filter(isRecord).map((cut): StateCut => {
      const atMs = typeof cut.startMs === 'number' ? cut.startMs : undefined;
      const durationMs = atMs !== undefined && typeof cut.endMs === 'number' ? cut.endMs - atMs : undefined;
      const paragraph = atMs === undefined ? undefined : paragraphs.filter((entry) => entry.atMs <= atMs).at(-1);
      const quoted = [cut.from, cut.to].filter((phrase) => typeof phrase === 'string').map((phrase) => `“${String(phrase)}”`).join(' … ');
      const excerpt = typeof cut.text === 'string' && cut.text ? cut.text : paragraph?.text ?? quoted;
      return { atMs, durationMs, excerpt };
    });
    const videos: StateVideo[] = [];
    for (const [name, mtime] of render) {
      if (extname(name) !== '.mp4') continue;
      const stem = name.slice(0, -4);
      if (ownerOf(stem) !== id) continue;
      const suffix = stem.slice(id.length + 1);
      const label = suffix || 'cut';
      videos.push({ label, path: `render/${name}`, src: fileUrl(`render/${name}`, mtime) });
    }
    const order = (label: string) => (VIDEO_ORDER.includes(label) ? VIDEO_ORDER.indexOf(label) : VIDEO_ORDER.length);
    videos.sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label));
    const snapshots: string[] = [];
    for (const folder of ['snapshots', 'snaps']) {
      const images = await listDirectory(join(project, 'overlay', id, folder));
      for (const [name, mtime] of [...images].sort(([a], [b]) => a.localeCompare(b))) {
        if (/\.(png|jpe?g|webp)$/i.test(name)) snapshots.push(fileUrl(`overlay/${id}/${folder}/${name}`, mtime));
      }
    }
    const sheet = shotFiles.get(`${id}.jpg`);
    const preview = render.get(`${id}-preview.jpg`);
    return {
      id,
      rank: ownRank,
      title: typeof short.title === 'string' ? short.title : undefined,
      hook: typeof short.hook === 'string' ? short.hook : undefined,
      notes: typeof short.notes === 'string' ? short.notes : undefined,
      durationSec: typeof short.durationSec === 'number' ? short.durationSec : undefined,
      variantOf,
      variants: ids.filter((other) => baseOf(other) === id),
      cuts,
      sheet: sheet === undefined ? undefined : fileUrl(`shots/${id}.jpg`, sheet),
      preview: preview === undefined ? undefined : fileUrl(`render/${id}-preview.jpg`, preview),
      videos,
      snapshots,
    };
  }));
  for (const short of shorts) if (short.variantOf) short.rank = shorts.find((base) => base.id === short.variantOf)!.rank;
  const body = {
    title: isRecord(video) && typeof video.title === 'string' ? video.title : undefined,
    videoId: isRecord(edlRaw) && typeof edlRaw.videoId === 'string' ? edlRaw.videoId : undefined,
    edlError: edlRaw instanceof Error ? edlRaw.message : !rawShorts.length ? 'edl.json has no shorts yet.' : undefined,
    shorts,
    review,
  };
  return { version: createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12), ...body };
}

export function scopeOf(state: ProjectState): ReviewScope {
  return {
    shorts: new Set(state.shorts.map((short) => short.id)),
    variants: new Map(state.shorts.filter((short) => short.variants.length).map((short) => [short.id, short.variants])),
  };
}

export interface ReviewServerOptions {
  project: string;
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Stop after this long without a request; the open page polls, so this counts from when it closes. */
  idleMs?: number;
}

export interface ReviewServer {
  url: string;
  /** Resolves with why the server stopped. */
  closed: Promise<'idle' | 'stopped'>;
  close(): Promise<void>;
}

export const DEFAULT_IDLE_MS = 30 * 60_000;

function send(response: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

async function sendFile(request: IncomingMessage, response: ServerResponse, file: string): Promise<void> {
  const { size } = await stat(file);
  const headers: Record<string, string | number> = {
    'Content-Type': SERVED_TYPES[extname(file).toLowerCase()]!,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(match[2]));
      }
    }
    if (!match || (!match[1] && !match[2]) || start > end || start >= size) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size ? end - start + 1 : 0;
  response.writeHead(status, headers);
  if (request.method === 'HEAD' || !size) {
    response.end();
    return;
  }
  createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    if (length > MAX_BODY_BYTES) throw new ShortsInputError('Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startReviewServer(options: ReviewServerOptions): Promise<ReviewServer> {
  const project = options.project;
  const info = await stat(project).catch(() => undefined);
  if (!info?.isDirectory()) throw new ShortsInputError(`Project directory not found: ${project}.`);
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const nonce = randomBytes(16).toString('base64');
  let origins = new Set<string>();
  let lastRequest = Date.now();
  let writes: Promise<unknown> = Promise.resolve();

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    lastRequest = Date.now();
    // Only answer requests addressed to this loopback server, which keeps DNS-rebinding pages out.
    if (!origins.has(`http://${request.headers.host ?? ''}`)) {
      send(response, 403, 'Forbidden host.');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/') {
      send(response, 200, reviewPage(nonce), 'text/html; charset=utf-8', {
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'Referrer-Policy': 'no-referrer',
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const state = await projectState(project);
      if (url.searchParams.get('since') === state.version) {
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      sendJson(response, 200, state);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/review') {
      // A JSON content type forces a CORS preflight from other sites, which this server never approves.
      const origin = request.headers.origin;
      if ((origin !== undefined && !origins.has(origin)) || !String(request.headers['content-type']).startsWith('application/json')) {
        send(response, 403, 'Forbidden.');
        return;
      }
      const body = await readBody(request);
      let action: unknown;
      try {
        action = JSON.parse(body) as unknown;
      } catch {
        throw new ShortsInputError('The request body is not valid JSON.');
      }
      const write = writes.then(async () => {
        const state = await projectState(project);
        await writeReview(project, applyReviewAction(await readReview(project, true), action, scopeOf(state)));
      });
      writes = write.catch(() => undefined);
      await write;
      sendJson(response, 200, await projectState(project));
      return;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/files/')) {
      const file = await resolveProjectFile(project, url.pathname.slice('/files/'.length));
      if (!file) {
        send(response, 404, 'Not found.');
        return;
      }
      await sendFile(request, response, file);
      return;
    }
    send(response, 404, 'Not found.');
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ShortsInputError) sendJson(response, 400, { error: { code: error.code, message: error.message } });
      else sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unexpected failure.' } });
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const { port } = server.address() as AddressInfo;
  origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  let resolveClosed!: (reason: 'idle' | 'stopped') => void;
  const closed = new Promise<'idle' | 'stopped'>((resolve) => {
    resolveClosed = resolve;
  });
  let stopping: Promise<void> | undefined;
  const stop = (reason: 'idle' | 'stopped') => {
    stopping ??= new Promise<void>((resolveStop) => {
      clearInterval(timer);
      server.close(() => resolveStop());
      server.closeAllConnections();
    }).then(() => resolveClosed(reason));
    return stopping;
  };
  const timer = setInterval(() => {
    if (Date.now() - lastRequest >= idleMs) void stop('idle');
  }, Math.min(idleMs, 30_000));
  timer.unref();

  return { url: `http://127.0.0.1:${port}/`, closed, close: () => stop('stopped') };
}
