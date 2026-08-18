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

async function jpegResponse(response: Response): Promise<Uint8Array> {
  if (!response.ok) {
    throw new YouTubeClientError('UPSTREAM_ERROR', `Storyboard request failed with status ${response.status}.`, {
      status: response.status, retryable: response.status === 429 || response.status >= 500,
    });
  }
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!type.startsWith('image/jpeg') && !type.startsWith('image/jpg')) {
    throw new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned a non-JPEG storyboard.');
  }
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_SHEET_BYTES) {
    throw new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned an oversized storyboard.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_SHEET_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned an invalid storyboard JPEG.');
  }
  return bytes;
}

function validateOptions(options: StoryboardOptions): number {
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
  return maxSheets;
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
  const maxSheets = validateOptions(options);
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
  const requestedSheets = Math.min(availableSheets, maxSheets);
  const directory = resolve(options.outputDir, 'storyboards');
  await mkdir(directory, { recursive: true });
  const sheets: StoryboardContactSheet[] = [];
  for (let sheet = 0; sheet < requestedSheets; sheet += 1) {
    const response = await fetchImpl(sheetUrl(spec, level, sheet));
    const bytes = await jpegResponse(response);
    const path = join(directory, `${options.videoId}-level-${level.index}-sheet-${sheet}.jpg`);
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
  const warnings = requestedSheets < availableSheets
    ? [`Storyboard: limited to ${requestedSheets} sheets`]
    : [];
  return {
    videoId: options.videoId,
    level: level.index,
    frameCount: level.frameCount,
    intervalMs: level.intervalMs,
    sheets,
    meta: metadata(warnings),
  };
}
