import type { YouTubeClientOptions } from 'all-things-youtube';
import { callWatchPlayer, type JsonObject, WATCH_MEDIA_PROFILES } from './innertube';

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export interface MediaCandidate {
  url: string;
  width?: number;
  height?: number;
  contentLength?: number;
  mimeType: string;
  progressive: boolean;
}

export interface MediaCandidateGroup {
  profile: (typeof WATCH_MEDIA_PROFILES)[number]['name'];
  candidates: MediaCandidate[];
}

function formats(value: unknown, progressive: boolean): MediaCandidate[] {
  return values(value).flatMap((item): MediaCandidate[] => {
    const format = object(item);
    const url = typeof format.url === 'string' ? format.url : undefined;
    const mimeType = typeof format.mimeType === 'string' ? format.mimeType : '';
    if (!url || !mimeType.startsWith('video/')) return [];
    return [{
      url,
      width: finiteNumber(format.width),
      height: finiteNumber(format.height),
      contentLength: finiteNumber(format.contentLength),
      mimeType,
      progressive: progressive || typeof format.audioQuality === 'string',
    }];
  });
}

function codecPreference(candidate: MediaCandidate): number {
  if (candidate.mimeType.includes('avc1')) return 0;
  if (candidate.mimeType.includes('vp9')) return 1;
  if (candidate.mimeType.includes('av01')) return 2;
  return 3;
}

export function selectCandidates(raw: JsonObject, maxWidth: number, preferResolution = false): MediaCandidate[] {
  const streaming = object(raw.streamingData);
  const all = [
    ...formats(streaming.formats, true),
    ...formats(streaming.adaptiveFormats, false),
  ];
  const bounded = all.filter((candidate) => candidate.width === undefined || candidate.width <= maxWidth);
  const pool = bounded.length
    ? bounded
    : [...all].sort((a, b) => (a.width ?? Number.MAX_SAFE_INTEGER) - (b.width ?? Number.MAX_SAFE_INTEGER));
  const ranked = pool
    .sort((a, b) => {
      const width = (b.width ?? 0) - (a.width ?? 0);
      if (preferResolution && width) return width;
      if (a.progressive !== b.progressive) return a.progressive ? -1 : 1;
      return width || codecPreference(a) - codecPreference(b);
    })
    .filter((candidate, index, candidates) =>
      candidates.findIndex((other) => other.url === candidate.url) === index
    );
  const selected = ranked.slice(0, 4);
  // Keep a progressive fallback even when four higher-resolution adaptive
  // streams rank ahead of it. Some YouTube clients deny adaptive range reads.
  if (preferResolution && !selected.some(candidate => candidate.progressive)) {
    const fallback = ranked.find(candidate => candidate.progressive);
    if (fallback) selected[selected.length - 1] = fallback;
  }
  return selected;
}

export async function loadMediaCandidateGroup(
  profileIndex: number,
  videoId: string,
  maxWidth: number,
  options: YouTubeClientOptions,
  preferResolution = false,
): Promise<MediaCandidateGroup | undefined> {
  const profile = WATCH_MEDIA_PROFILES[profileIndex];
  if (!profile) return undefined;
  try {
    const response = await callWatchPlayer(videoId, profile, options);
    const candidates = selectCandidates(response.raw, maxWidth, preferResolution);
    return candidates.length ? { profile: response.profile, candidates } : undefined;
  } catch {
    return undefined;
  }
}
