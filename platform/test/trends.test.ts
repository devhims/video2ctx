import {
  buildTrendReport, deriveSnapshotSignals, extractHashtags, parsePublishedAgeHours, type TrendVideo,
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
    expect(report.videos[0]?.trendBand).toBe('Breakout');
    expect(report.hashtags[0]).toMatchObject({ tag: '#aiagents', videos: 3 });
    expect(report.plan.titleIdeas).toHaveLength(3);
    expect(report.methodology).toContain('views per hour');
    expect(report.confidence.level).toBe('low');
    expect(report.sample.enrichedVideos).toBe(3);
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
