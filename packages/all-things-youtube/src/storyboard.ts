import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  YouTubeClientError,
  type SourceMetadata,
  type StoryboardContactSheet,
  type StoryboardIndex,
  type StoryboardOptions,
} from './youtube-types';

const DEFAULT_MAX_SHEETS = 12;
const MAX_SHEETS = 20;
const MAX_SHEET_BYTES = 4 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

interface StoryboardLevel {
  index: number;
  tileWidth: number;
  tileHeight: number;
  frameCount: number;
  columns: number;
  rows: number;
  intervalMs: number;
  namePattern: string;
  signature: string;
}

interface StoryboardSpec {
  template: string;
  levels: StoryboardLevel[];
}

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseStoryboardSpec(raw: JsonObject): StoryboardSpec | undefined {
  const renderer = object(object(raw.storyboards).playerStoryboardSpecRenderer);
  const spec = typeof renderer.spec === 'string' ? renderer.spec : undefined;
  if (!spec) return undefined;
  const [template, ...encodedLevels] = spec.split('|');
  if (!template || !template.startsWith('https://')) return undefined;
  const levels = encodedLevels.flatMap((encoded, index): StoryboardLevel[] => {
    const fields = encoded.split('#');
    const tileWidth = positiveInteger(fields[0]);
    const tileHeight = positiveInteger(fields[1]);
    const frameCount = positiveInteger(fields[2]);
    const columns = positiveInteger(fields[3]);
    const rows = positiveInteger(fields[4]);
    const intervalMs = positiveInteger(fields[5]);
    const namePattern = fields[6];
    const signature = fields[7];
    if (!tileWidth || !tileHeight || !frameCount || !columns || !rows || !intervalMs
      || !namePattern || !signature) return [];
    return [{
      index, tileWidth, tileHeight, frameCount, columns, rows, intervalMs,
      namePattern, signature,
    }];
  });
  return levels.length ? { template, levels } : undefined;
}

function sheetUrl(spec: StoryboardSpec, level: StoryboardLevel, sheet: number): string {
  const name = level.namePattern.replaceAll('$M', String(sheet));
  let value = spec.template.replaceAll('$L', String(level.index)).replaceAll('$N', name);
  if (value.includes('$S')) value = value.replaceAll('$S', level.signature);
  else {
    const url = new URL(value);
    url.searchParams.set('sigh', level.signature);
    value = url.toString();
  }
  return value;
}

export async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const oversized = () => new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned an oversized storyboard response.');
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw oversized();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw oversized();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

// Validate the RIFF envelope and chunk boundaries without decoding/re-encoding pixels.
// https://developers.google.com/speed/webp/docs/riff_container
function isWebP(bytes: Uint8Array): boolean {
  if (bytes.length < 20) return false;
  const fourCC = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WEBP' || view.getUint32(4, true) !== bytes.length - 8
    || !['VP8 ', 'VP8L', 'VP8X'].includes(fourCC(12))) return false;
  let hasImage = false;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const kind = fourCC(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + (size % 2);
    if (paddedEnd > bytes.length || (size % 2 && bytes[end] !== 0)) return false;
    if (kind === 'VP8 ') {
      if (size < 10 || (bytes[start]! & 1) !== 0 || bytes[start + 3] !== 0x9d
        || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) return false;
      hasImage = true;
    } else if (kind === 'VP8L') {
      if (size < 5 || bytes[start] !== 0x2f) return false;
      hasImage = true;
    } else if (kind === 'VP8X') {
      if (offset !== 12 || size !== 10 || (bytes[start]! & 0x02) !== 0) return false;
    } else if (kind === 'ANIM' || kind === 'ANMF') {
      return false; // A contact sheet must be a still image.
    }
    offset = paddedEnd;
  }
  return hasImage;
}

async function imageResponse(response: Response): Promise<{ bytes: Uint8Array; extension: 'jpg' | 'webp' }> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new YouTubeClientError('UPSTREAM_ERROR', `Storyboard request failed with status ${response.status}.`, {
      status: response.status, retryable: response.status === 429 || response.status >= 500,
    });
  }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!['image/jpeg', 'image/jpg', 'image/webp'].includes(type)) {
    await response.body?.cancel();
    throw new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned an unsupported storyboard image type.');
  }
  const bytes = await readBoundedBytes(response, MAX_SHEET_BYTES);
  // YouTube can serve WebP at a .jpg URL. Choose the filename from the bytes.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, extension: 'jpg' };
  if (isWebP(bytes)) return { bytes, extension: 'webp' };
  throw new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned an invalid storyboard JPEG or WebP.');
}

export function validateStoryboardOptions(options: StoryboardOptions): number {
  if (!/^[A-Za-z0-9_-]{11}$/.test(options.videoId)) {
    throw new YouTubeClientError('INVALID_INPUT', 'videoId must be 11 characters.');
  }
  if (typeof options.outputDir !== 'string' || !options.outputDir.trim()) {
    throw new YouTubeClientError('INVALID_INPUT', 'outputDir is required.');
  }
  const maxSheets = options.maxSheets ?? DEFAULT_MAX_SHEETS;
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 1 || maxSheets > MAX_SHEETS) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      `maxSheets must be an integer from 1 to ${MAX_SHEETS}.`,
    );
  }
  if (options.selection !== undefined && !['leading', 'spread'].includes(options.selection)) {
    throw new YouTubeClientError('INVALID_INPUT', 'Unknown storyboard selection.');
  }
  if (options.timestampsMs !== undefined && (!Array.isArray(options.timestampsMs)
    || options.timestampsMs.length === 0 || options.timestampsMs.length > MAX_SHEETS
    || options.timestampsMs.some(time => !Number.isSafeInteger(time) || time < 0))) {
    throw new YouTubeClientError('INVALID_INPUT', 'timestampsMs must contain 1 to 20 nonnegative integer timestamps.');
  }
  if (options.metadataOnly !== undefined && typeof options.metadataOnly !== 'boolean') {
    throw new YouTubeClientError('INVALID_INPUT', 'metadataOnly must be a boolean.');
  }
  if (options.sheetIndexes !== undefined && (!Array.isArray(options.sheetIndexes)
    || options.sheetIndexes.length === 0 || options.sheetIndexes.length > MAX_SHEETS
    || options.sheetIndexes.some(index => !Number.isSafeInteger(index) || index < 0))) {
    throw new YouTubeClientError('INVALID_INPUT', 'sheetIndexes must contain 1 to 20 nonnegative integers.');
  }
  if ((options.sheetIndexes && options.timestampsMs) || (options.metadataOnly && (options.sheetIndexes || options.timestampsMs))) {
    throw new YouTubeClientError('INVALID_INPUT', 'Choose metadata, sheet indexes, or timestamps separately.');
  }
  return maxSheets;
}

function selectSheets(level: StoryboardLevel, options: StoryboardOptions, maxSheets: number): number[] {
  const capacity = level.columns * level.rows;
  const count = Math.ceil(level.frameCount / capacity);
  if (options.metadataOnly) return [];
  if (options.sheetIndexes) {
    const sheets = [...new Set(options.sheetIndexes)].sort((a, b) => a - b);
    if (sheets.length > maxSheets || sheets.some(index => index >= count)) {
      throw new YouTubeClientError('INVALID_INPUT', 'Requested sheet indexes exceed the available sheets or sheet budget.');
    }
    return sheets;
  }
  if (options.timestampsMs) {
    if (options.timestampsMs.some(time => time >= level.frameCount * level.intervalMs)) {
      throw new YouTubeClientError('INVALID_INPUT', 'A requested timestamp is outside the storyboard sampling range.');
    }
    const sheets = [...new Set(options.timestampsMs.map(time => Math.floor(time / level.intervalMs / capacity)))].sort((a, b) => a - b);
    if (sheets.length > maxSheets) {
      throw new YouTubeClientError('INVALID_INPUT', 'Requested timestamps exceed the storyboard sheet budget.');
    }
    return sheets;
  }
  const take = Math.min(count, maxSheets);
  return Array.from({ length: take }, (_, i) => options.selection === 'spread'
    ? take === 1 ? Math.floor((count - 1) / 2) : Math.round(i * (count - 1) / (take - 1))
    : i);
}

function metadata(warnings: string[]): SourceMetadata {
  return {
    source: 'allthingsyoutube',
    fetchedAt: new Date().toISOString(),
    partial: warnings.length > 0,
    warnings,
  };
}

export async function downloadStoryboard(
  raw: JsonObject,
  options: StoryboardOptions,
  fetchImpl: typeof fetch,
): Promise<StoryboardIndex> {
  const maxSheets = validateStoryboardOptions(options);
  const spec = parseStoryboardSpec(raw);
  if (!spec) {
    throw new YouTubeClientError('NOT_FOUND', 'No storyboard is available for this video.');
  }
  const level = [...spec.levels].sort((a, b) =>
    (b.tileWidth * b.tileHeight) - (a.tileWidth * a.tileHeight)
  )[0];
  if (!level) {
    throw new YouTubeClientError('NOT_FOUND', 'No usable storyboard level is available for this video.');
  }
  const capacity = level.columns * level.rows;
  const availableSheets = Math.ceil(level.frameCount / capacity);
  const selectedSheets = selectSheets(level, options, maxSheets);
  const directory = resolve(options.outputDir, 'storyboards');
  if (!options.metadataOnly) await mkdir(directory, { recursive: true });
  const sheets: StoryboardContactSheet[] = [];
  for (const sheet of selectedSheets) {
    const response = await fetchImpl(sheetUrl(spec, level, sheet));
    const { bytes, extension } = await imageResponse(response);
    const path = join(directory, `${options.videoId}-level-${level.index}-sheet-${sheet}.${extension}`);
    await writeFile(path, bytes);
    const firstFrameIndex = sheet * capacity;
    sheets.push({
      path,
      tileWidth: level.tileWidth,
      tileHeight: level.tileHeight,
      columns: level.columns,
      rows: level.rows,
      firstFrameIndex,
      frameCount: Math.min(capacity, level.frameCount - firstFrameIndex),
      intervalMs: level.intervalMs,
    });
  }
  const warnings = !options.metadataOnly && selectedSheets.length < availableSheets
    ? [`Storyboard: limited to ${selectedSheets.length} sheets`]
    : [];
  return {
    videoId: options.videoId,
    level: level.index,
    frameCount: level.frameCount,
    intervalMs: level.intervalMs,
    manifest: { totalSheets: availableSheets, framesPerSheet: capacity, tileWidth: level.tileWidth, tileHeight: level.tileHeight,
      columns: level.columns, rows: level.rows, lastSampleMs: (level.frameCount - 1) * level.intervalMs },
    selection: { mode: options.metadataOnly ? 'metadata' : options.sheetIndexes ? 'indexes' : options.timestampsMs ? 'timestamps' : options.selection ?? 'leading',
      ...(options.sheetIndexes ? { requestedSheetIndexes: options.sheetIndexes } : {}),
      ...(options.timestampsMs ? { requestedTimestampsMs: options.timestampsMs } : {}) },
    sheets,
    meta: metadata(warnings),
  };
}
