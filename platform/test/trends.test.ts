import {
  buildTrendReport, composeSample, deriveSnapshotSignals, extractHashtags, parsePublishedAgeHours,
  percentileScale, type TrendVideo,
} from '../src/lib/trends';

function source(overrides: Partial<Omit<TrendVideo, 'trendScore' | 'trendBand'>> = {}) {
  return {
    id: 'abcdefghijk', title: 'How to build useful AI agents', channel: { id: 'UC1', name: 'Lab' },
    thumbnails: [], description: '#AIAgents #Automation', durationSeconds: 600,
    publishedTimeText: '2 hours ago', ageHours: 2, viewCount: 20_000, viewsPerHour: 10_000,
    signalSource: 'estimated' as const,
    hashtags: ['#aiagents', '#automation'], keywords: ['agents'], url: 'https://youtube.com/watch?v=abcdefghijk',
    ...overrides,
  };
}

function candidate(id: string, channelId: string, publishedTimeText: string) {
  return {
    type: 'video' as const, id, title: `Video ${id}`, channel: { id: channelId, name: channelId, url: '' },
    thumbnails: [], publishedTimeText, isLive: false, url: `https://youtube.com/watch?v=${id}`,
  };
}

describe('topic trend research', () => {
  test('parses relative publication ages used for transparent velocity calculations', () => {
    expect(parsePublishedAgeHours('2 hours ago')).toBe(2);
    expect(parsePublishedAgeHours('Streamed 3 days ago')).toBe(72);
    expect(parsePublishedAgeHours('15 minutes ago')).toBe(0.5);
  });

  test('extracts visible hashtags separately from creator keywords', () => {
    expect(extractHashtags('Try #AIAgents and #AI_Agents — #AIAgents')).toEqual(['#aiagents', '#ai_agents']);
  });

  test('ranks videos relative to the sample and produces a planning brief', () => {
    const report = buildTrendReport('AI agents', [
      source(),
      source({ id: 'bcdefghijkl', title: 'AI agents explained', viewCount: 1_000, viewsPerHour: 100, ageHours: 10 }),
      source({ id: 'cdefghijklm', title: 'Practical automation agents', viewCount: 5_000, viewsPerHour: 500, ageHours: 8 }),
    ]);
    expect(report.videos[0]?.id).toBe('abcdefghijk');
    expect(report.videos[0]?.velocityRank).toBe(1);
    expect(report.hashtags[0]).toMatchObject({ tag: '#aiagents', videos: 3 });
    expect(report.plan.titleIdeas).toHaveLength(3);
    expect(report.methodology).toContain('views per hour');
    expect(report.confidence.level).toBe('low');
    expect(report.sample.enrichedVideos).toBe(3);
    expect(report.methodologyVersion).toBe('3.0');
  });

  test('scores the middle of the sample at the middle of the scale', () => {
    const report = buildTrendReport('AI agents', [
      source({ id: 'aaaaaaaaaaa', viewsPerHour: 100, ageHours: 30, engagementRate: 1 }),
      source({ id: 'bbbbbbbbbbb', viewsPerHour: 200, ageHours: 20, engagementRate: 2 }),
      source({ id: 'ccccccccccc', viewsPerHour: 300, ageHours: 10, engagementRate: 3 }),
    ]);
    const middle = report.videos.find((video) => video.id === 'bbbbbbbbbbb');
    expect(middle?.percentiles.velocity).toBe(50);
    expect(middle?.percentiles.freshness).toBe(50);
    expect(middle?.trendScore).toBe(50);
    // An absolute outlier cannot inflate the scale beyond the sample's own top rank.
    const top = report.videos.find((video) => video.id === 'ccccccccccc');
    expect(top?.percentiles.velocity).toBeCloseTo(83.3, 1);
  });

  test('withholds Breakout from a video whose momentum is only a lifetime average', () => {
    const fast = { viewsPerHour: 10_000, ageHours: 1, engagementRate: 9 };
    const slow = (id: string) => source({ id, viewsPerHour: 10, ageHours: 900, engagementRate: 0.1 });
    const estimated = buildTrendReport('AI agents', [
      source({ id: 'aaaaaaaaaaa', ...fast }),
      slow('bbbbbbbbbbb'), slow('ccccccccccc'), slow('ddddddddddd'), slow('eeeeeeeeeee'),
    ]);
    const leader = estimated.videos[0];
    expect(leader?.id).toBe('aaaaaaaaaaa');
    expect(leader?.trendScore).toBeGreaterThanOrEqual(75);
    expect(leader?.trendBand).toBe('Rising');
    expect(estimated.summary.breakoutCount).toBe(0);
    expect(estimated.confidence.reasons.join(' ')).toContain('cannot be banded Breakout');

    const observed = buildTrendReport('AI agents', [
      source({
        id: 'aaaaaaaaaaa', ...fast, signalSource: 'observed',
        observedViewsPerHour: 10_000, accelerationPercent: 80, previousViewsPerHour: 5_000,
      }),
      slow('bbbbbbbbbbb'), slow('ccccccccccc'), slow('ddddddddddd'), slow('eeeeeeeeeee'),
    ]);
    expect(observed.videos[0]?.trendBand).toBe('Breakout');
  });

  test('withholds Breakout while the sample is too thin to be a reference frame', () => {
    const report = buildTrendReport('AI agents', [
      source({
        id: 'aaaaaaaaaaa', signalSource: 'observed', observedViewsPerHour: 9_000,
        accelerationPercent: 80, engagementRate: 9, ageHours: 1,
      }),
      source({ id: 'bbbbbbbbbbb', viewsPerHour: 5, ageHours: 900 }),
    ]);
    expect(report.videos[0]?.trendBand).not.toBe('Breakout');
    expect(report.confidence.reasons.join(' ')).toContain('Breakout is withheld below 5');
  });

  test('reports how recent uploads compare with the established sample', () => {
    const report = buildTrendReport('AI agents', [
      source({ id: 'aaaaaaaaaaa', ageHours: 48, viewsPerHour: 900 }),
      source({ id: 'bbbbbbbbbbb', ageHours: 72, viewsPerHour: 700 }),
      source({ id: 'ccccccccccc', ageHours: 4_000, viewsPerHour: 100 }),
      source({ id: 'ddddddddddd', ageHours: 5_000, viewsPerHour: 80 }),
    ], [], 40, { days: 14, recentCandidatesSampled: 6 });
    expect(report.window).toEqual({ days: 14, recentCandidatesSampled: 6, recentVideosEnriched: 2 });
    expect(report.summary.medianRecentViewsPerHour).toBe(800);
    expect(report.summary.recentVelocityLift).toBeGreaterThan(1);
    expect(report.plan.evidence.join(' ')).toContain('outpacing');
  });

  test('reserves half the sample for recent uploads without breaking the channel cap', () => {
    const relevance = [
      candidate('old1', 'UCbig', '2 years ago'), candidate('old2', 'UCbig', '2 years ago'),
      candidate('old3', 'UCbig', '2 years ago'), candidate('old4', 'UCbig', '1 year ago'),
      candidate('old5', 'UCb', '1 year ago'), candidate('old6', 'UCc', '1 year ago'),
      candidate('new1', 'UCd', '2 days ago'), candidate('new2', 'UCe', '5 days ago'),
      candidate('new3', 'UCf', '9 days ago'),
    ];
    const recent = relevance.filter((video) => video.id.startsWith('new'));
    const sample = composeSample(relevance, recent, 8);
    expect(sample).toHaveLength(8);
    expect(sample.filter((video) => video.id.startsWith('new'))).toHaveLength(3);
    // The cap is only relaxed to avoid returning a short sample, never while other channels remain.
    expect(sample.filter((video) => video.channel.id === 'UCbig')).toHaveLength(3);
  });

  test('gives a missing signal the neutral rank so it neither helps nor hurts', () => {
    const scale = percentileScale([10, undefined, 30]);
    expect(scale(undefined)).toBe(50);
    expect(scale(10)).toBe(25);
    expect(scale(30)).toBe(75);
    expect(percentileScale([undefined])(5)).toBe(50);
  });

  test('derives observed velocity and acceleration from repeated snapshots', () => {
    const hour = 3_600_000;
    const current = { capturedAt: 10 * hour, viewCount: 10_000, likeCount: 500, commentCount: 100 };
    const history = [
      { capturedAt: 8 * hour, viewCount: 7_000, likeCount: 420, commentCount: 80 },
      { capturedAt: 6 * hour, viewCount: 5_000, likeCount: 350, commentCount: 60 },
    ];

    expect(deriveSnapshotSignals(current, history)).toMatchObject({
      observationHours: 2,
      viewDelta: 3000,
      observedViewsPerHour: 1500,
      previousViewsPerHour: 1000,
      accelerationPercent: 50,
      likeDelta: 80,
      commentDelta: 20,
    });
  });
});
