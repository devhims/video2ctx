import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { loadLandingInspection } from './landing-inspection';

export const LANDING_SAMPLE_IDS = ['bAX27XRHMH8', 'eC7xzavzEKY', 'Vyb-sTrY_Y8'] as const;
const PREFIX = 'landing-samples/v1';
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 256 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const inlineImage = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const thumbnail = z.object({ url: z.string().regex(inlineImage), width: z.number().optional(), height: z.number().optional() });
const thumbnails = z.array(thumbnail).max(1);
const sourceMeta = z.object({ source: z.string(), fetchedAt: z.string(), partial: z.literal(false), warnings: z.array(z.string()) }).passthrough();
const snapshotSchema = z.object({
  video: z.object({
    type: z.literal('video'), isLive: z.boolean(), keywords: z.array(z.string()),
    availability: z.object({ status: z.string(), playable: z.boolean() }).passthrough(), meta: sourceMeta,
    id: z.string(), title: z.string(), description: z.string().optional(), url: z.string(),
    channel: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    thumbnails: thumbnails.min(1), durationText: z.string().optional(),
    viewCountText: z.string().optional(), publishedTimeText: z.string().optional(),
  }).passthrough(),
  channel: z.object({ status: z.literal('ready'), channel: z.object({
    type: z.literal('channel'), meta: sourceMeta,
    id: z.string(), name: z.string(), handle: z.string().optional(), url: z.string(), thumbnails,
    about: z.object({
      description: z.string().optional(),
      links: z.array(z.object({ title: z.string(), displayUrl: z.string(), url: z.string() })),
      moreInfo: z.object({
        canonicalChannelUrl: z.string(),
        joinedDate: z.string().optional(), joinedDateText: z.string().optional(),
        subscriberCount: z.number().optional(), subscriberCountText: z.string().optional(),
        videoCount: z.number().optional(), videoCountText: z.string().optional(),
        viewCount: z.number().optional(), viewCountText: z.string().optional(),
        businessEmailAvailable: z.boolean(),
      }).passthrough(),
    }),
  }) }),
  transcript: z.object({
    status: z.literal('ready'), track: z.object({
      id: z.string(), name: z.string(), languageCode: z.string(),
      kind: z.enum(['manual', 'asr', 'unknown']), isTranslatable: z.boolean(), isDefault: z.boolean(),
    }).passthrough(),
    segmentCount: z.number(), segments: z.array(z.object({
      startMs: z.number(), durationMs: z.number(), endMs: z.number(), text: z.string(),
    }).passthrough()).min(1).max(16),
  }),
  comments: z.object({ status: z.literal('ready'), totalCount: z.number().optional(), comments: z.array(z.object({
    id: z.string(), author: z.object({ id: z.string().optional(), name: z.string(), thumbnails: thumbnails.optional() }),
    text: z.string(), publishedTimeText: z.string().optional(), likeCount: z.number().optional(),
    likeCountText: z.string().optional(), replyCount: z.number().optional(), isPinned: z.boolean(), isHearted: z.boolean(),
  })).max(12) }),
  partial: z.literal(false),
  samplePreview: z.literal(true),
});

type Snapshot = z.infer<typeof snapshotSchema>;
type Inspection = Awaited<ReturnType<typeof loadLandingInspection>>;

/** Sample storage is separate from the shared catalog, so refreshes elsewhere
 * never change these previews. Only complete, self-contained results are saved. */
export async function inspectLandingVideo(
  env: Env, id: string, requestUrl: string, waitUntil: (work: Promise<unknown>) => void,
): Promise<Inspection | Snapshot> {
  if (!LANDING_SAMPLE_IDS.some(sample => sample === id)) return loadLandingInspection(env, id);

  const key = `${PREFIX}/${id}.json`;
  const cacheKey = new Request(new URL(`/${key}`, requestUrl));
  let cache: Cache | undefined;
  try {
    if (typeof caches !== 'undefined') cache = await caches.open(PREFIX);
    const hit = await cache?.match(cacheKey);
    if (hit) return parseSnapshot(await hit.json(), id);
  } catch { report('cache_read', id); }

  const remember = (snapshot: Snapshot) => {
    if (cache) waitUntil(cache.put(cacheKey, Response.json(snapshot, {
      headers: { 'Cache-Control': 'public, max-age=86400' },
    })).catch(() => report('cache_write', id)));
    return snapshot;
  };

  let missing = false;
  try {
    const object = await env.VIDEO_ASSETS.get(key);
    if (object) {
      if (object.size > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot too large');
      return remember(parseSnapshot(await object.json(), id));
    }
    missing = true;
  } catch { report('snapshot_read', id); }

  // Storage outages use the existing provider path. Do not replace a snapshot
  // that we could not read, or save a degraded provider response permanently.
  const result = await loadLandingInspection(env, id, !missing);
  if (!missing || result.partial) return result;
  try {
    const snapshot = await captureSnapshot(result);
    const payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload) > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot too large');
    const written = await env.VIDEO_ASSETS.put(key, payload, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    });
    // A concurrent first visit may have saved a different snapshot. Always
    // return the winner and never overwrite it during normal inspection.
    if (written) return remember(snapshot);
    const winner = await env.VIDEO_ASSETS.get(key);
    if (winner && winner.size <= MAX_SNAPSHOT_BYTES) return remember(parseSnapshot(await winner.json(), id));
  } catch (error) { report('snapshot_create', id, error); }
  return result;
}

function parseSnapshot(value: unknown, id: string): Snapshot {
  const parsed = snapshotSchema.parse(value);
  if (parsed.video.id !== id) throw new Error('Snapshot video mismatch');
  return parsed;
}

async function captureSnapshot(result: Inspection): Promise<Snapshot> {
  const copy = structuredClone(result);
  const downloaded = new Map<string, Promise<string>>();
  const signal = AbortSignal.timeout(8000);
  const saveImages = async (items: { url: string; width?: number; height?: number }[]) => {
    const best = [...items].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    if (!best) return [];
    let url = downloaded.get(best.url);
    if (!url) {
      url = downloadImage(best.url, signal);
      downloaded.set(best.url, url);
    }
    return [{ ...best, url: await url }];
  };
  const tasks: Promise<void>[] = [saveImages(copy.video.thumbnails).then(images => { copy.video.thumbnails = images; })];
  if (copy.channel.status === 'ready') {
    const channel = copy.channel.channel;
    tasks.push(saveImages(channel.thumbnails).then(images => { channel.thumbnails = images; }));
  }
  if (copy.comments.status === 'ready') {
    for (const comment of copy.comments.comments) {
      if (comment.author.thumbnails) tasks.push(saveImages(comment.author.thumbnails).then(images => { comment.author.thumbnails = images; }));
    }
  }
  await Promise.all(tasks);
  return parseSnapshot({ ...copy, samplePreview: true }, result.video.id);
}

async function downloadImage(source: string, signal: AbortSignal): Promise<string> {
  const url = new URL(source);
  // Provider URLs are untrusted. Never follow a redirect to an arbitrary host.
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || !['ytimg.com', 'ggpht.com', 'googleusercontent.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('Unsupported sample image host');
  }
  const response = await fetch(url, { redirect: 'error', signal });
  const type = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (!response.ok || !type || !IMAGE_TYPES.includes(type) || !response.body) {
    await response.body?.cancel();
    throw new Error('Sample image unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error('Sample image too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  if (!size) throw new Error('Empty sample image');
  return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
}

function report(stage: string, videoId: string, error?: unknown) {
  console.warn({
    event: 'landing_sample_fallback', stage, videoId,
    errorName: error instanceof Error ? error.name : undefined,
    issues: error instanceof z.ZodError
      ? error.issues.slice(0, 10).map(issue => ({ path: issue.path.join('.'), code: issue.code }))
      : undefined,
  });
}
