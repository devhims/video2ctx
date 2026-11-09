import { seekMilliseconds } from './timestamp-expression';

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Consume the whole URL before checking its host. Embedded links and v= parameters belong to that URL.
export const urlCandidates = /(?:https?:\/\/|(?<![\w./@-])(?:[\w-]+\.)+[a-z]{2,}\/)[^\s<>"']+/gi;
function youTubeUrl(candidate: string): URL | undefined {
  const normalized = candidate.replace(/[\])},.!?;:'"]+$/g, '');
  try {
    const url = new URL(/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'm.youtu.be'].includes(url.hostname)) return url;
  } catch { /* Non-URL text can match the candidate pattern. */ }
}

export function* youTubeUrls(message: string): Generator<URL> {
  for (const candidate of message.match(urlCandidates) ?? []) {
    const url = youTubeUrl(candidate);
    if (url) yield url;
  }
}

function videoIdsFromUrl(url: URL): string[] {
  const [kind, id] = url.pathname.split('/').filter(Boolean);
  const candidates = url.hostname.endsWith('youtu.be') ? [kind]
    : [url.searchParams.get('v'), ...(['shorts', 'live', 'embed'].includes(kind ?? '') ? [id] : [])];
  return candidates.filter((value): value is string => !!value && VIDEO_ID_PATTERN.test(value));
}

/** Seek parameters belong to their linked video. Numeric values are seconds. */
export function linkedSeek(candidate: string): { videoIds: string[]; time: number } | undefined {
  const url = youTubeUrl(candidate);
  if (!url) return;
  const videoIds = videoIdsFromUrl(url);
  const value = url.searchParams.get('t') ?? url.searchParams.get('start') ?? new URLSearchParams(url.hash.slice(1)).get('t');
  if (!videoIds.length || !value) return;
  const time = seekMilliseconds(value);
  if (time !== undefined) return { videoIds, time };
}

export function extractYouTubeVideoIds(message: string): string[] {
  const ids = new Set<string>();
  for (const url of youTubeUrls(message)) {
    for (const videoId of videoIdsFromUrl(url)) ids.add(videoId);
  }

  const labelledIdPattern = /(?:^|[\s(])(?:video(?:\s+id)?|v)\s*[:=]\s*([A-Za-z0-9_-]{11})(?=$|\s|[),.!?;])/gi;
  for (const match of message.replace(urlCandidates, ' ').matchAll(labelledIdPattern)) ids.add(match[1]!);
  const trimmed = message.trim();
  if (VIDEO_ID_PATTERN.test(trimmed)) ids.add(trimmed);
  return [...ids];
}
