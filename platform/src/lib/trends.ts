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

export interface TrendPercentiles {
  velocity: number;
  freshness: number;
  channelPerformance: number;
  engagement: number;
  acceleration: number;
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
  effectiveViewsPerHour: number;
  velocityRank: number;
  percentiles: TrendPercentiles;
  trendScore: number;
  trendBand: 'Breakout' | 'Rising' | 'Steady';
  url: string;
}

export interface TrendReport {
  query: string;
  generatedAt: string;
  sampleSize: number;
  methodologyVersion: '3.0';
  methodology: string;
  sample: {
    candidateVideos: number;
    enrichedVideos: number;
    channels: number;
    observedVideos: number;
    recentCandidates: number;
    recentVideos: number;
  };
  window: {
    days: number;
    recentCandidatesSampled: number;
    recentVideosEnriched: number;
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
    medianRecentViewsPerHour?: number;
    recentVelocityLift?: number;
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
  | 'effectiveViewsPerHour' | 'velocityRank' | 'percentiles'
>;

/** Videos published inside this window are what the report treats as "recent supply". */
const RECENCY_WINDOW_DAYS = 14;
/** Share of the enrichment budget held back for recent candidates so evergreen winners cannot crowd them out. */
const RECENT_SAMPLE_SHARE = 0.5;
/** Videos per channel allowed in one sample, so a single creator cannot define the reference frame. */
const CHANNEL_SAMPLE_CAP = 3;
/** Below this many enriched videos the sample is too thin to call anything a breakout. */
const MIN_BREAKOUT_SAMPLE = 5;
/** Percentile handed to a video whose metric is missing, so an absent signal neither helps nor hurts. */
const NEUTRAL_PERCENTILE = 50;

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
  // Relevance ranking favours videos that already won, so read deeper than the sample needs:
  // recent uploads sit further down the list and would otherwise never be seen.
  for (let page = 0; page < 4 && candidates.length < limit * 4; page += 1) {
    const response = await searchYouTube(env, query, {
      type: 'video',
      ...(continuation ? { continuation } : {}),
    });
    candidates.push(...response.videos);
    continuation = response.continuation;
    if (!continuation) break;
  }
  const uniqueCandidates = [...new Map(candidates.map((video) => [video.id, video])).values()];
  const relevanceRank = new Map(uniqueCandidates.map((video, index) => [video.id, index + 1]));
  const windowHours = RECENCY_WINDOW_DAYS * 24;
  const recentCandidates = uniqueCandidates.filter((video) => {
    const age = parsePublishedAgeHours(video.publishedTimeText);
    return age !== undefined && age <= windowHours;
  });
  const selected = composeSample(uniqueCandidates, recentCandidates, limit);
  const history = await loadSnapshotHistory(env, selected.map((video) => video.id));
  const capturedAt = Date.now();
  const settled = await settleInBatches(selected, 6, async (candidate): Promise<CollectedVideo> => {
    const [video, signals] = await Promise.all([
      getVideo(env, candidate.id),
      getVideoSignals(env, candidate.id, true),
    ]);
    const publishedTimeText = candidate.publishedTimeText ?? signals?.publishedTimeText;
    const ageHours = parsePublishedAgeHours(publishedTimeText, signals?.publishDate);
    if (signals.viewCount === undefined) throw new Error(`Current view count unavailable for ${candidate.id}.`);
    const viewCount = signals.viewCount;
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
      searchRank: relevanceRank.get(candidate.id),
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
  const report = buildTrendReport(query, collected, warnings, uniqueCandidates.length, {
    days: RECENCY_WINDOW_DAYS,
    recentCandidatesSampled: recentCandidates.length,
  });
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
  candidateCount = collected.length,
  window: { days: number; recentCandidatesSampled: number } =
    { days: RECENCY_WINDOW_DAYS, recentCandidatesSampled: 0 }
): TrendReport {
  const effectiveVelocity = (video: CollectedVideo) => video.observedViewsPerHour ?? video.viewsPerHour ?? 0;
  const medianVelocity = median(collected.map(effectiveVelocity).filter((value) => value > 0));
  const windowHours = window.days * 24;
  const channelVelocities = new Map<string, number[]>();
  for (const video of collected) {
    if (!video.channel.id || !effectiveVelocity(video)) continue;
    const values = channelVelocities.get(video.channel.id) ?? [];
    values.push(effectiveVelocity(video));
    channelVelocities.set(video.channel.id, values);
  }
  // A channel baseline only means something when the sample holds more than one of its videos.
  const channelBaselines = new Map<string, number>();
  for (const [channel, values] of channelVelocities) {
    if (values.length >= 2) channelBaselines.set(channel, median(values));
  }
  const liftFor = (video: CollectedVideo) => {
    const baseline = channelBaselines.get(video.channel.id);
    const velocity = effectiveVelocity(video);
    return baseline && velocity ? round(velocity / baseline, 2) : undefined;
  };

  // Every component is a rank inside this sample rather than a fitted curve, so a score reads as
  // "where in this sample" and stays comparable when the sample's absolute numbers move.
  const velocityPercentile = percentileScale(collected.map(effectiveVelocity));
  const freshnessPercentile = percentileScale(
    collected.map((video) => video.ageHours === undefined ? undefined : -video.ageHours));
  const channelPercentile = percentileScale(collected.map(liftFor));
  const engagementPercentile = percentileScale(collected.map((video) => video.engagementRate));
  const accelerationPercentile = percentileScale(collected.map((video) => video.accelerationPercent));

  const velocityOrder = [...collected].sort((a, b) => effectiveVelocity(b) - effectiveVelocity(a))
    .map((video) => video.id);
  const bandable = collected.length >= MIN_BREAKOUT_SAMPLE;

  const videos = collected.map((video): TrendVideo => {
    const velocity = effectiveVelocity(video);
    const channelLift = liftFor(video);
    const observed = video.signalSource === 'observed';
    const percentiles: TrendPercentiles = {
      velocity: velocityPercentile(velocity),
      freshness: freshnessPercentile(video.ageHours === undefined ? undefined : -video.ageHours),
      channelPerformance: channelPercentile(channelLift),
      engagement: engagementPercentile(video.engagementRate),
      acceleration: accelerationPercentile(video.accelerationPercent),
    };
    const trendScore = Math.round(
      percentiles.velocity * (observed ? 0.4 : 0.55) +
      percentiles.freshness * 0.15 + percentiles.channelPerformance * 0.15 +
      percentiles.engagement * 0.1 +
      percentiles.acceleration * (observed ? 0.2 : 0.05)
    );
    const confidenceScore = Math.round(clamp(
      25 + (observed ? 35 : 0) + (video.previousViewsPerHour !== undefined ? 15 : 0) +
      (channelBaselines.has(video.channel.id) ? 10 : 0) +
      (video.likeCount !== undefined && video.commentCount !== undefined ? 10 : 0) +
      (collected.length >= 16 ? 5 : 0), 0, 100
    ));
    return {
      ...video,
      channelBaselineViewsPerHour: channelBaselines.get(video.channel.id),
      channelLift,
      confidenceScore,
      effectiveViewsPerHour: velocity,
      velocityRank: velocityOrder.indexOf(video.id) + 1,
      percentiles,
      trendScore,
      // A lifetime average cannot evidence a breakout, and neither can a sample this thin.
      trendBand: trendScore >= 75 && observed && bandable ? 'Breakout'
        : trendScore >= 55 ? 'Rising' : 'Steady',
    };
  }).sort((a, b) => b.trendScore - a.trendScore || b.effectiveViewsPerHour - a.effectiveViewsPerHour);

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
  const recentVideos = videos.filter((video) => video.ageHours !== undefined && video.ageHours <= windowHours);
  const topTerms = titlePatterns.filter((pattern) => pattern.videos > 1).slice(0, 2).map((pattern) => pattern.term);
  // Relevance search is dominated by long evergreen courses, so length advice comes from recent
  // uploads when the window holds enough of them.
  const durationPool = recentVideos.length >= 2 ? recentVideos : topVideos;
  const duration = median(durationPool.map((video) => video.durationSeconds ?? 0).filter(Boolean));
  const velocityLeader = [...videos].sort((a, b) => effectiveVelocity(b) - effectiveVelocity(a))[0];
  const topicTitle = titleCase(query);
  const observedHashtags = hashtags.filter((item) => item.videos > 1).slice(0, 5).map((item) => item.tag);

  const observedVideos = videos.filter((video) => video.signalSource === 'observed').length;
  const estimatedVideos = videos.length - observedVideos;
  const medianRecentVelocity = median(recentVideos.map(effectiveVelocity).filter((value) => value > 0));
  const reportConfidence = Math.round(clamp(
    20 + Math.min(videos.length / 30, 1) * 25 + (observedVideos / Math.max(videos.length, 1)) * 45 +
    (new Set(videos.map((video) => video.channel.id)).size >= 8 ? 10 : 0), 0, 100
  ));
  return {
    query,
    generatedAt: new Date().toISOString(),
    sampleSize: videos.length,
    methodologyVersion: '3.0',
    methodology: `Each video is ranked against the others in this sample on five signals: momentum, freshness, engagement, acceleration, and performance against the same channel's other sampled videos. Momentum is measured growth between repeated snapshots when history exists, otherwise lifetime average views per hour, and only measured videos can be called a breakout. Up to half the sample is reserved for videos published in the last ${window.days} days. This is topic-sample research, not YouTube CTR, retention, recommendation traffic, or proof of demand.`,
    sample: {
      candidateVideos: candidateCount,
      enrichedVideos: videos.length,
      channels: new Set(videos.map((video) => video.channel.id || video.channel.name)).size,
      observedVideos,
      recentCandidates: window.recentCandidatesSampled,
      recentVideos: recentVideos.length,
    },
    window: {
      days: window.days,
      recentCandidatesSampled: window.recentCandidatesSampled,
      recentVideosEnriched: recentVideos.length,
    },
    confidence: {
      score: reportConfidence,
      level: reportConfidence >= 75 ? 'high' : reportConfidence >= 50 ? 'medium' : 'low',
      reasons: [
        `${videos.length} videos across ${new Set(videos.map((video) => video.channel.id || video.channel.name)).size} channels were enriched.`,
        observedVideos
          ? `${observedVideos} videos have repeated snapshots with measured growth.`
          : 'No repeated snapshots exist yet, so momentum is estimated from lifetime views and publication age.',
        estimatedVideos
          ? `${estimatedVideos} videos have no snapshot history, so their momentum is a lifetime average and they cannot be banded Breakout.`
          : 'Every sampled video has measured growth.',
        videos.length < MIN_BREAKOUT_SAMPLE
          ? `Breakout is withheld below ${MIN_BREAKOUT_SAMPLE} enriched videos because the sample is its own reference frame.`
          : `Scores are percentile ranks inside this ${videos.length} video sample, not absolute ratings.`,
        recentVideos.length
          ? `${recentVideos.length} of ${videos.length} sampled videos were published in the last ${window.days} days.`
          : `No sampled video was published in the last ${window.days} days, so this reads as an established topic rather than an active one.`,
        'Search ranking biases the sample toward relevance and established performance, so recent uploads that rank poorly are invisible here.',
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
      medianRecentViewsPerHour: medianRecentVelocity ? Math.round(medianRecentVelocity) : undefined,
      // Above 1 means recent uploads are outpacing the topic's established videos.
      recentVelocityLift: medianRecentVelocity && medianVelocity
        ? round(medianRecentVelocity / medianVelocity, 2) : undefined,
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
        medianRecentVelocity && medianVelocity
          ? `Videos from the last ${window.days} days run at ${formatCompact(Math.round(medianRecentVelocity))} views/hour against ${formatCompact(Math.round(medianVelocity))} for the whole sample, so recent uploads are ${medianRecentVelocity >= medianVelocity ? 'outpacing' : 'trailing'} the established ones.`
          : `No video from the last ${window.days} days made this sample, so there is no recent-supply signal to compare against.`,
        velocityLeader ? `${velocityLeader.title} leads this sample at ${formatCompact(effectiveVelocity(velocityLeader))} ${velocityLeader.signalSource === 'observed' ? 'measured' : 'estimated'} views/hour.` : '',
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

/**
 * Builds the enrichment set. The first pass spends up to half the budget on videos published inside
 * the recency window, so a topic's evergreen winners cannot take every slot. The second pass fills
 * the rest in relevance order, and the last pass relaxes the per-channel cap rather than returning a
 * short sample, because the sample size is what every score is measured against.
 */
export function composeSample(
  relevance: VideoSummary[],
  recent: VideoSummary[],
  limit: number
): VideoSummary[] {
  const chosen = new Map<string, VideoSummary>();
  const perChannel = new Map<string, number>();
  const take = (video: VideoSummary, cap: number) => {
    if (chosen.has(video.id)) return false;
    const channel = video.channel.id || video.channel.name;
    const used = perChannel.get(channel) ?? 0;
    if (used >= cap) return false;
    chosen.set(video.id, video);
    perChannel.set(channel, used + 1);
    return true;
  };

  const recentQuota = Math.floor(limit * RECENT_SAMPLE_SHARE);
  let fromRecent = 0;
  for (const video of recent) {
    if (fromRecent >= recentQuota || chosen.size >= limit) break;
    if (take(video, CHANNEL_SAMPLE_CAP)) fromRecent += 1;
  }
  for (const video of relevance) {
    if (chosen.size >= limit) break;
    take(video, CHANNEL_SAMPLE_CAP);
  }
  for (const video of [...recent, ...relevance]) {
    if (chosen.size >= limit) break;
    take(video, Number.POSITIVE_INFINITY);
  }
  return [...chosen.values()];
}

/**
 * Returns a function placing a value inside the sample's own distribution, 0 to 100, with ties
 * sharing the midpoint. Missing values are neither rewarded nor punished.
 */
export function percentileScale(values: Array<number | undefined>): (value: number | undefined) => number {
  const known = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (!known.length) return () => NEUTRAL_PERCENTILE;
  return (value) => {
    if (value === undefined || !Number.isFinite(value)) return NEUTRAL_PERCENTILE;
    let below = 0;
    let equal = 0;
    for (const item of known) {
      if (item < value) below += 1;
      else if (item === value) equal += 1;
    }
    return round(((below + equal / 2) / known.length) * 100, 1);
  };
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
