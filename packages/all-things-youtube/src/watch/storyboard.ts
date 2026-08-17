import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { YouTubeClientError, type YouTubeClientOptions } from '../youtube-types';
import type { StoryboardContactSheet, StoryboardIndex } from './types';
import type { JsonObject } from './innertube';

const MAX_SHEET_BYTES = 4 * 1024 * 1024;

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
  const storyboards = object(raw.storyboards);
  const renderer = object(storyboards.playerStoryboardSpecRenderer);
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

export async function downloadStoryboard(
  raw: JsonObject,
  videoId: string,
  outputDir: string,
  maxSheets: number,
  options: YouTubeClientOptions,
): Promise<StoryboardIndex | undefined> {
  const spec = parseStoryboardSpec(raw);
  if (!spec) return undefined;
  const level = [...spec.levels].sort((a, b) =>
    (b.tileWidth * b.tileHeight) - (a.tileWidth * a.tileHeight)
  )[0];
  if (!level) return undefined;
  const capacity = level.columns * level.rows;
  const availableSheets = Math.ceil(level.frameCount / capacity);
  const requestedSheets = Math.min(availableSheets, maxSheets);
  const directory = resolve(outputDir, 'storyboards');
  await mkdir(directory, { recursive: true });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sheets: StoryboardContactSheet[] = [];
  for (let sheet = 0; sheet < requestedSheets; sheet += 1) {
    const response = await fetchImpl(sheetUrl(spec, level, sheet));
    const bytes = await jpegResponse(response);
    const path = join(directory, `${videoId}-level-${level.index}-sheet-${sheet}.jpg`);
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
  return {
    level: level.index,
    frameCount: level.frameCount,
    intervalMs: level.intervalMs,
    sheets,
  };
}
