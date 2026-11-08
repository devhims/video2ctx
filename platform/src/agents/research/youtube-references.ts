const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Consume the whole URL before checking its host. Embedded links and v= parameters belong to that URL.
export const urlCandidates = /(?:https?:\/\/|(?<![\w./@-])(?:[\w-]+\.)+[a-z]{2,}\/)[^\s<>"']+/gi;
export function* youTubeUrls(message: string): Generator<URL> {
  for (const candidate of message.match(urlCandidates) ?? []) {
    const normalized = candidate.replace(/[\])},.!?;:'"]+$/g, '');
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'm.youtu.be'].includes(host)) yield url;
  }
}

export function extractYouTubeVideoIds(message: string): string[] {
  const ids = new Set<string>();
  for (const url of youTubeUrls(message)) {
    if (url.hostname.endsWith('youtu.be')) {
      addVideoId(ids, url.pathname.split('/').filter(Boolean)[0]);
      continue;
    }
    addVideoId(ids, url.searchParams.get('v') ?? undefined);
    const [kind, pathId] = url.pathname.split('/').filter(Boolean);
    if (kind === 'shorts' || kind === 'live' || kind === 'embed') addVideoId(ids, pathId);
  }

  const labelledIdPattern = /(?:^|[\s(])(?:video(?:\s+id)?|v)\s*[:=]\s*([A-Za-z0-9_-]{11})(?=$|\s|[),.!?;])/gi;
  for (const match of message.replace(urlCandidates, ' ').matchAll(labelledIdPattern)) addVideoId(ids, match[1]);
  const trimmed = message.trim();
  if (VIDEO_ID_PATTERN.test(trimmed)) ids.add(trimmed);
  return [...ids];
}

function addVideoId(ids: Set<string>, candidate: string | undefined): void {
  if (candidate && VIDEO_ID_PATTERN.test(candidate)) ids.add(candidate);
}
