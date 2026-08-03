import { generateTrendInsights, TREND_INSIGHTS_MODEL } from '../src/lib/trend-insights';

describe('AI trend insights', () => {
  test('uses GLM Flash and rejects evidence ids outside the sample', async () => {
    const run = vi.fn().mockResolvedValue({ response: JSON.stringify({
      themes: [{ label: 'Practical builds', summary: 'Creators demonstrate finished projects.', videoIds: ['video000001'] }],
      audienceIntents: [{ intent: 'Learn by building', evidence: 'Tutorial framing repeats.', videoIds: ['video000001', 'invented'] }],
      contentGaps: [{ opportunity: 'Show failed attempts', rationale: 'The sample omits failure analysis.', videoIds: ['video000002'], confidence: 0.8 }],
      saturation: { level: 'medium', explanation: 'Many tutorials repeat similar promises.', videoIds: ['video000001'] },
    }) });
    const env = { AI: { run }, AI_GATEWAY_ID: 'test-gateway' } as unknown as Env;

    const result = await generateTrendInsights(env, 'AI agents', [
      { id: 'video000001', title: 'Build an AI agent', channel: 'One', description: 'A tutorial', trendScore: 80, viewsPerHour: 1000 },
      { id: 'video000002', title: 'Agent mistakes', channel: 'Two', description: 'Avoid errors', trendScore: 60, viewsPerHour: 500 },
    ]);

    expect(run.mock.calls[0]?.[0]).toBe(TREND_INSIGHTS_MODEL);
    expect(result.audienceIntents[0]?.videoIds).toEqual(['video000001']);
    expect(result.contentGaps[0]).toMatchObject({ opportunity: 'Show failed attempts', confidence: 0.8 });
  });
});
