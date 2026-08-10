import type { Thumbnail, VideoSummary } from 'all-things-youtube';
import { getVideo, getVideoSignals, searchYouTube } from './youtube';
import { generateTrendInsights, type TrendInsights } from './trend-insights';

export interface AnalyticsSnapshot {
  capturedAt: number;
  viewCount: number;
  likeCount?: number;
  commentCount?: number;
}

export interface SnapshotSignals {
  observationHours?: number;
  viewDelta?: number;
  likeDelta?: number;
  commentDelta?: number;
  observedViewsPerHour?: number;
  previousViewsPerHour?: number;
  accelerationPercent?: number;
}

export interface TrendVideo {
  id: string;
  title: string;
  channel: { id: string; name: string };
  thumbnails: Thumbnail[];
  description: string;
  durationSeconds?: number;
  publishedTimeText?: string;
  publishDate?: string;
  ageHours?: number;
  viewCount: number;
  viewsPerHour?: number;
  observedViewsPerHour?: number;
  previousViewsPerHour?: number;
  accelerationPercent?: number;
  observationHours?: number;
  viewDelta?: number;
  likeDelta?: number;
  commentDelta?: number;
  commentCount?: number;
  likeCount?: number;
  engagementRate?: number;
  channelBaselineViewsPerHour?: number;
  channelLift?: number;
  searchRank?: number;
  signalSource: 'observed' | 'estimated';
  confidenceScore: number;
  hashtags: string[];
  keywords: string[];
  trendScore: number;
  trendBand: 'Breakout' | 'Rising' | 'Steady';
  url: string;
}

export interface TrendReport {
  query: string;
  generatedAt: string;
  sampleSize: number;
  methodologyVersion: '2.0';
  methodology: string;
  sample: {
    candidateVideos: number;
    enrichedVideos: number;
    channels: number;
    observedVideos: number;
  };
  confidence: {
    score: number;
    level: 'low' | 'medium' | 'high';
    reasons: string[];
  };
  summary: {
    totalViews: number;
    medianViewsPerHour: number;
    publishedLast7Days: number;
    breakoutCount: number;
    acceleratingCount: number;
    medianObservedViewsPerHour?: number;
  };
  videos: TrendVideo[];
  hashtags: Array<{ tag: string; videos: number; averageViewsPerHour: number; lift: number }>;
  titlePatterns: Array<{ term: string; videos: number; averageViewsPerHour: number }>;
  durationMix: Array<{ label: string; videos: number; averageViewsPerHour: number }>;
  insights?: TrendInsights;
  plan: {
    angle: string;
    recommendedDurationSeconds?: number;
    titleIdeas: string[];
    observedHashtags: string[];
    evidence: string[];
  };
  warnings: string[];
}

type CollectedVideo = Omit<TrendVideo,
  'trendScore' | 'trendBand' | 'channelBaselineViewsPerHour' | 'channelLift' | 'confidenceScore'
>;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'agents', 'best', 'build', 'building', 'course', 'does', 'from', 'full',
  'have', 'into', 'just', 'more', 'most', 'that', 'their', 'this', 'using', 'video', 'what', 'when',
  'where', 'which', 'with', 'without', 'your', 'youtube', '2024', '2025', '2026',
]);

export async function researchTrendTopic(
  env: Env,
  query: string,
  requestedLimit = 20,
  includeAiInsights = true
): Promise<TrendReport> {
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 8), 30);
  const candidates: VideoSummary[] = [];
  let continuation: string | undefined;
  for (let page = 0; page < 3 && candidates.length < limit * 2; page += 1) {
    const response = await searchYouTube(env, query, {
      type: 'video',
      ...(continuation ? { continuation } : {}),
    });
    candidates.push(...response.videos);
    continuation = response.continuation;
    if (!continuation) break;
  }
  const uniqueCandidates = [...new Map(candidates.map((video) => [video.id, video])).values()];
  const selected = diverseSample(uniqueCandidates, limit);
  const history = await loadSnapshotHistory(env, selected.map((video) => video.id));
  const capturedAt = Date.now();
  const settled = await settleInBatches(selected, 6, async (candidate, searchRank): Promise<CollectedVideo> => {
    const [video, signals] = await Promise.all([
      getVideo(env, candidate.id),
      getVideoSignals(env, candidate.id).catch(() => undefined),
    ]);
    const publishedTimeText = candidate.publishedTimeText ?? signals?.publishedTimeText;
    const ageHours = parsePublishedAgeHours(publishedTimeText, signals?.publishDate);
    const viewCount = video.viewCount ?? signals?.viewCount ?? candidate.viewCount ?? 0;
    const viewsPerHour = ageHours && ageHours > 0 ? Math.round(viewCount / ageHours) : undefined;
    const description = video.description ?? candidate.description ?? '';
    const snapshot = deriveSnapshotSignals({
      capturedAt, viewCount, likeCount: signals?.likeCount, commentCount: signals?.commentCount,
    }, history.get(candidate.id) ?? []);
    const engagementRate = viewCount > 0
      ? round((((signals?.likeCount ?? 0) + (signals?.commentCount ?? 0)) / viewCount) * 100, 3)
      : undefined;
    return {
      id: video.id,
      title: video.title,
      channel: { id: video.channel.id, name: video.channel.name },
      thumbnails: video.thumbnails,
      description,
      durationSeconds: video.durationSeconds ?? candidate.durationSeconds,
      publishedTimeText,
      publishDate: signals?.publishDate,
      ageHours,
      viewCount,
      viewsPerHour,
      ...snapshot,
      commentCount: signals?.commentCount,
      likeCount: signals?.likeCount,
      engagementRate,
      searchRank: searchRank + 1,
      signalSource: snapshot.observedViewsPerHour === undefined ? 'estimated' : 'observed',
      hashtags: extractHashtags(`${video.title}\n${description}`),
      keywords: video.keywords,
      url: video.url,
    };
  });
  const collected = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const warnings = settled.flatMap((result) => result.status === 'rejected'
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
  if (!collected.length) throw new Error('No videos could be enriched for this topic.');
  await persistSnapshots(env, capturedAt, collected).catch((error) => {
    warnings.push(`Snapshot persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const report = buildTrendReport(query, collected, warnings, uniqueCandidates.length);
  if (includeAiInsights) {
    try {
      report.insights = await generateTrendInsights(env, query, report.videos.slice(0, 20).map((video) => ({
        id: video.id,
        title: video.title,
        channel: video.channel.name,
        description: video.description.slice(0, 1200),
        trendScore: video.trendScore,
        viewsPerHour: video.viewsPerHour,
        observedViewsPerHour: video.observedViewsPerHour,
        accelerationPercent: video.accelerationPercent,
        channelLift: video.channelLift,
      })));
    } catch (error) {
      report.warnings.push(`AI insights unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

export function buildTrendReport(
  query: string,
  collected: CollectedVideo[],
  warnings: string[] = [],
  candidateCount = collected.length
): TrendReport {
  const effectiveVelocity = (video: CollectedVideo) => video.observedViewsPerHour ?? video.viewsPerHour ?? 0;
  const medianVelocity = median(collected.map(effectiveVelocity).filter((value) => value > 0));
  const channelVelocities = new Map<string, number[]>();
  for (const video of collected) {
    if (!video.channel.id || !effectiveVelocity(video)) continue;
    const values = channelVelocities.get(video.channel.id) ?? [];
    values.push(effectiveVelocity(video));
    channelVelocities.set(video.channel.id, values);
  }
  const videos = collected.map((video): TrendVideo => {
    const velocity = effectiveVelocity(video);
    const relativeVelocity = velocity && medianVelocity
      ? clamp(50 + 22 * Math.log2(velocity / medianVelocity), 0, 100) : 25;
    const freshness = video.ageHours === undefined
      ? 30 : clamp(100 * Math.exp(-video.ageHours / (24 * 21)), 0, 100);
    const channelValues = channelVelocities.get(video.channel.id) ?? [];
    const channelBaselineViewsPerHour = channelValues.length >= 2 ? median(channelValues) : undefined;
    const channelLift = channelBaselineViewsPerHour && velocity
      ? round(velocity / channelBaselineViewsPerHour, 2) : undefined;
    const channelPerformance = channelLift === undefined
      ? 50 : clamp(50 + 25 * Math.log2(channelLift), 0, 100);
    const acceleration = video.accelerationPercent === undefined
      ? 50 : clamp(50 + video.accelerationPercent / 4, 0, 100);
    const engagement = video.engagementRate === undefined
      ? 40 : clamp(video.engagementRate * 12, 0, 100);
    const observed = video.signalSource === 'observed';
    const trendScore = Math.round(
      relativeVelocity * (observed ? 0.4 : 0.55) +
      freshness * 0.15 + channelPerformance * 0.15 + engagement * 0.1 +
      acceleration * (observed ? 0.2 : 0.05)
    );
    const confidenceScore = Math.round(clamp(
      25 + (observed ? 35 : 0) + (video.previousViewsPerHour !== undefined ? 15 : 0) +
      (channelBaselineViewsPerHour !== undefined ? 10 : 0) +
      (video.likeCount !== undefined && video.commentCount !== undefined ? 10 : 0) +
      (collected.length >= 16 ? 5 : 0), 0, 100
    ));
    return {
      ...video,
      channelBaselineViewsPerHour,
      channelLift,
      confidenceScore,
      trendScore,
      trendBand: trendScore >= 75 ? 'Breakout' : trendScore >= 55 ? 'Rising' : 'Steady',
    };
  }).sort((a, b) => b.trendScore - a.trendScore || effectiveVelocity(b) - effectiveVelocity(a));

  const hashtags = aggregateLabels(videos, (video) => video.hashtags)
    .map((item) => ({
      tag: item.label,
      videos: item.videos,
      averageViewsPerHour: item.averageViewsPerHour,
      lift: medianVelocity ? round(item.averageViewsPerHour / medianVelocity, 1) : 0,
    }))
    .slice(0, 8);
  const queryWords = new Set(tokenize(query));
  const titlePatterns = aggregateLabels(videos, (video) =>
    tokenize(video.title).filter((term) => !STOP_WORDS.has(term) && !queryWords.has(term)))
    .map((item) => ({ term: item.label, videos: item.videos, averageViewsPerHour: item.averageViewsPerHour }))
    .slice(0, 8);
  const durationMix = durationBuckets(videos);
  const topVideos = videos.slice(0, 3);
  const topTerms = titlePatterns.filter((pattern) => pattern.videos > 1).slice(0, 2).map((pattern) => pattern.term);
  const duration = median(topVideos.map((video) => video.durationSeconds ?? 0).filter(Boolean));
  const velocityLeader = [...videos].sort((a, b) => effectiveVelocity(b) - effectiveVelocity(a))[0];
  const topicTitle = titleCase(query);
  const observedHashtags = hashtags.filter((item) => item.videos > 1).slice(0, 5).map((item) => item.tag);

  const observedVideos = videos.filter((video) => video.signalSource === 'observed').length;
  const reportConfidence = Math.round(clamp(
    20 + Math.min(videos.length / 30, 1) * 25 + (observedVideos / Math.max(videos.length, 1)) * 45 +
    (new Set(videos.map((video) => video.channel.id)).size >= 8 ? 10 : 0), 0, 100
  ));
  return {
    query,
    generatedAt: new Date().toISOString(),
    sampleSize: videos.length,
    methodologyVersion: '2.0',
    methodology: 'Momentum combines observed snapshot velocity and acceleration when history exists, otherwise lifetime average views per hour; it also considers freshness, engagement, and performance relative to other sampled videos from the same channel. This is topic-sample research, not YouTube CTR, retention, recommendation traffic, or proof of demand.',
    sample: {
      candidateVideos: candidateCount,
      enrichedVideos: videos.length,
      channels: new Set(videos.map((video) => video.channel.id || video.channel.name)).size,
      observedVideos,
    },
    confidence: {
      score: reportConfidence,
      level: reportConfidence >= 75 ? 'high' : reportConfidence >= 50 ? 'medium' : 'low',
      reasons: [
        `${videos.length} videos across ${new Set(videos.map((video) => video.channel.id || video.channel.name)).size} channels were enriched.`,
        observedVideos
          ? `${observedVideos} videos have repeated snapshots with observed growth.`
          : 'No repeated snapshots exist yet; velocity is estimated from lifetime views and publication age.',
        'Search ranking biases the sample toward relevance and established performance.',
      ],
    },
    summary: {
      totalViews: videos.reduce((sum, video) => sum + video.viewCount, 0),
      medianViewsPerHour: Math.round(medianVelocity),
      publishedLast7Days: videos.filter((video) => video.ageHours !== undefined && video.ageHours <= 24 * 7).length,
      breakoutCount: videos.filter((video) => video.trendBand === 'Breakout').length,
      acceleratingCount: videos.filter((video) => (video.accelerationPercent ?? 0) > 10).length,
      medianObservedViewsPerHour: observedVideos
        ? Math.round(median(videos.map((video) => video.observedViewsPerHour ?? 0).filter(Boolean)))
        : undefined,
    },
    videos,
    hashtags,
    titlePatterns,
    durationMix,
    plan: {
      angle: planningAngle(query, topTerms, duration),
      recommendedDurationSeconds: duration || undefined,
      titleIdeas: [
        `${topicTitle}: The Practical Playbook That Actually Works`,
        `I Tested ${topicTitle} — Here’s What Changed`,
        `How to Use ${topicTitle} Without the Usual Mistakes`,
      ],
      observedHashtags,
      evidence: [
        `${videos.filter((video) => video.ageHours !== undefined && video.ageHours <= 24 * 7).length} of ${videos.length} sampled videos were published in the last 7 days.`,
        `The median publish-age-normalized reach is ${formatCompact(Math.round(medianVelocity))} average views/hour.`,
        velocityLeader ? `${velocityLeader.title} leads this sample at ${formatCompact(effectiveVelocity(velocityLeader))} ${velocityLeader.signalSource === 'observed' ? 'observed' : 'estimated'} views/hour.` : '',
      ].filter(Boolean),
    },
    warnings,
  };
}

export function deriveSnapshotSignals(
  current: AnalyticsSnapshot,
  history: AnalyticsSnapshot[]
): SnapshotSignals {
  const ordered = [...history].filter((item) => item.capturedAt < current.capturedAt)
    .sort((a, b) => b.capturedAt - a.capturedAt);
  const latest = ordered[0];
  if (!latest) return {};
  const observationHours = (current.capturedAt - latest.capturedAt) / 3_600_000;
  if (observationHours < 0.25) return {};
  const viewDelta = Math.max(current.viewCount - latest.viewCount, 0);
  const observedViewsPerHour = round(viewDelta / observationHours, 1);
  const previous = ordered[1];
  let previousViewsPerHour: number | undefined;
  let accelerationPercent: number | undefined;
  if (previous) {
    const previousHours = (latest.capturedAt - previous.capturedAt) / 3_600_000;
    if (previousHours >= 0.25) {
      previousViewsPerHour = round(Math.max(latest.viewCount - previous.viewCount, 0) / previousHours, 1);
      accelerationPercent = previousViewsPerHour > 0
        ? round(((observedViewsPerHour - previousViewsPerHour) / previousViewsPerHour) * 100, 1)
        : observedViewsPerHour > 0 ? 100 : 0;
    }
  }
  return {
    observationHours: round(observationHours, 2),
    viewDelta,
    likeDelta: delta(current.likeCount, latest.likeCount),
    commentDelta: delta(current.commentCount, latest.commentCount),
    observedViewsPerHour,
    previousViewsPerHour,
    accelerationPercent,
  };
}

function delta(current?: number, previous?: number): number | undefined {
  return current === undefined || previous === undefined ? undefined : Math.max(current - previous, 0);
}

function diverseSample(candidates: VideoSummary[], limit: number): VideoSummary[] {
  const selected: VideoSummary[] = [];
  const deferred: VideoSummary[] = [];
  const perChannel = new Map<string, number>();
  for (const video of candidates) {
    const channel = video.channel.id || video.channel.name;
    const count = perChannel.get(channel) ?? 0;
    if (count < 3) {
      selected.push(video);
      perChannel.set(channel, count + 1);
    } else deferred.push(video);
    if (selected.length === limit) return selected;
  }
  return [...selected, ...deferred].slice(0, limit);
}

async function settleInBatches<T, R>(
  values: T[],
  size: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    results.push(...await Promise.allSettled(
      values.slice(offset, offset + size).map((value, index) => mapper(value, offset + index))
    ));
  }
  return results;
}

async function loadSnapshotHistory(env: Env, ids: string[]): Promise<Map<string, AnalyticsSnapshot[]>> {
  const history = new Map<string, AnalyticsSnapshot[]>();
  if (!ids.length) return history;
  const placeholders = ids.map(() => '?').join(',');
  const cutoff = Date.now() - 30 * 24 * 3_600_000;
  const result = await env.DB.prepare(
    `SELECT entity_id,captured_at,view_count,like_count,comment_count
     FROM analytics_snapshots
     WHERE provider='youtube' AND entity_type='video' AND entity_id IN (${placeholders}) AND captured_at >= ?
     ORDER BY entity_id,captured_at DESC`
  ).bind(...ids, cutoff).all<{
    entity_id: string; captured_at: number; view_count: number | null;
    like_count: number | null; comment_count: number | null;
  }>();
  for (const row of result.results) {
    const items = history.get(row.entity_id) ?? [];
    if (items.length >= 2 || row.view_count === null) continue;
    items.push({
      capturedAt: row.captured_at,
      viewCount: row.view_count,
      likeCount: row.like_count ?? undefined,
      commentCount: row.comment_count ?? undefined,
    });
    history.set(row.entity_id, items);
  }
  return history;
}

async function persistSnapshots(env: Env, capturedAt: number, videos: CollectedVideo[]): Promise<void> {
  if (!videos.length) return;
  await env.DB.batch(videos.map((video) => env.DB.prepare(
    `INSERT OR REPLACE INTO analytics_snapshots
     (provider,entity_type,entity_id,captured_at,view_count,like_count,comment_count,velocity)
     VALUES ('youtube','video',?,?,?,?,?,?)`
  ).bind(
    video.id, capturedAt, video.viewCount, video.likeCount ?? null, video.commentCount ?? null,
    video.observedViewsPerHour ?? null
  )));
}

export function parsePublishedAgeHours(relative?: string, exactDate?: string): number | undefined {
  const normalized = relative?.toLowerCase().replace(/^streamed\s+|^premiered\s+/, '').trim();
  if (normalized) {
    if (normalized.includes('just now')) return 0.5;
    const match = normalized.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
    if (match) {
      const amount = Number(match[1]);
      const multiplier = { minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720, year: 8760 }[match[2] as 'minute'];
      return Math.max(amount * multiplier, 0.5);
    }
  }
  if (exactDate) {
    const timestamp = Date.parse(exactDate);
    if (Number.isFinite(timestamp)) return Math.max((Date.now() - timestamp) / 3_600_000, 0.5);
  }
  return undefined;
}

export function extractHashtags(value: string): string[] {
  return [...new Set((value.match(/#[\p{L}\p{N}_-]+/gu) ?? []).map((tag) => tag.toLowerCase()))];
}

function aggregateLabels(videos: TrendVideo[], labels: (video: TrendVideo) => string[]) {
  const groups = new Map<string, { videos: Set<string>; velocities: number[] }>();
  for (const video of videos) {
    for (const label of new Set(labels(video))) {
      const group = groups.get(label) ?? { videos: new Set<string>(), velocities: [] };
      group.videos.add(video.id);
      const velocity = video.observedViewsPerHour ?? video.viewsPerHour;
      if (velocity !== undefined) group.velocities.push(velocity);
      groups.set(label, group);
    }
  }
  return [...groups.entries()].map(([label, group]) => ({
    label,
    videos: group.videos.size,
    averageViewsPerHour: Math.round(average(group.velocities)),
  })).sort((a, b) => b.videos - a.videos || b.averageViewsPerHour - a.averageViewsPerHour);
}

function durationBuckets(videos: TrendVideo[]) {
  const buckets = [
    { label: 'Under 4 min', min: 0, max: 240 },
    { label: '4–12 min', min: 240, max: 720 },
    { label: '12–20 min', min: 720, max: 1200 },
    { label: '20+ min', min: 1200, max: Number.POSITIVE_INFINITY },
  ];
  return buckets.map((bucket) => {
    const matches = videos.filter((video) => video.durationSeconds !== undefined && video.durationSeconds >= bucket.min && video.durationSeconds < bucket.max);
    return { label: bucket.label, videos: matches.length, averageViewsPerHour: Math.round(average(matches.map((video) => video.observedViewsPerHour ?? video.viewsPerHour ?? 0))) };
  });
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((term) => term.length > 3) ?? [];
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function titleCase(value: string): string {
  return value.trim().replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function planningAngle(query: string, repeatedTerms: string[], durationSeconds: number): string {
  if (repeatedTerms.includes('hours') || durationSeconds >= 3_600) {
    return `Long-form course framing is common for ${query}. Differentiate with one complete project, a visible result in the opening, and a tighter promise.`;
  }
  if (repeatedTerms.includes('shot')) {
    return `One-shot demonstrations are recurring for ${query}. Show the finished outcome first, then make the workflow reproducible.`;
  }
  if (repeatedTerms.length) {
    return `The repeated “${repeatedTerms.join(' / ')}” language is attracting attention. Keep the familiar intent, but promise one concrete outcome the leaders do not show in their titles.`;
  }
  return `Lead with one concrete ${query} outcome and show the result before explaining the process.`;
}
