import { compactAgentRun, compactAgentRunSchema, agentResponseOptionsSchema } from '../src/agents/response';
import type { AgentRunView } from '../src/agents/agent-runtime-do';

function completedRun(): AgentRunView {
  const identity = { runId: '102992fd-7e50-47be-bc96-3508a2a5c9e0', conversationId: '5a04cf06-ea91-4b07-b892-ce87f63954de',
    userMessageId: 'f1611a8b-cb84-4305-a365-328bd06bedac', assistantMessageId: 'cd056140-7d4c-4516-bb9e-c97914439553' };
  return { ...identity, status: 'completed', conversationTurn: 1, modelStepCount: 2, toolCallCount: 5,
    route: { route: 'topic_research', researchBreadth: 'comparative' },
    result: { ...identity, answer: 'First [cite:b] [cite:a][cite:c]. Again [cite:b].', intent: 'topic_research', confidence: 'high',
      citations: [
        { id: 'a', sourceId: 'transcript:A', provider: 'youtube', videoId: 'video000001', title: 'First video', excerpt: 'A', startMs: 100 },
        { id: 'b', sourceId: 'storyboard:A', provider: 'youtube', videoId: 'video000001', title: 'First video', excerpt: 'B', startMs: 200 },
        { id: 'c', sourceId: 'transcript:B', provider: 'youtube', videoId: 'video000002', title: 'Second video', excerpt: 'C' },
      ], artifacts: [{ type: 'analysis', data: { findings: ['A', 'B'] } }], warnings: [], billing: { creditsCharged: 6, creditsRemaining: 100 } },
  };
}

describe('compact agent response', () => {
  it('deduplicates videos across tools and numbers sources by first use without mutating storage', () => {
    const run = completedRun();
    const before = structuredClone(run);
    const response = compactAgentRun(run);
    expect(response.result?.answer).toBe('First [1][2]. Again [1].');
    expect(response.result?.sources.map(s => s.videoId)).toEqual(['video000001', 'video000002']);
    expect(response.result?.sources[0]?.url).toBe('https://www.youtube.com/watch?v=video000001');
    expect(response.billing).toEqual(run.result?.billing);
    expect(response.result).not.toHaveProperty('billing');
    expect(response.result).not.toHaveProperty('artifacts');
    expect(response.result).not.toHaveProperty('citations');
    expect(response.result).not.toHaveProperty('confidence');
    expect(response).not.toHaveProperty('userMessageId');
    expect(response).not.toHaveProperty('diagnostics');
    expect(run).toEqual(before);
  });

  it.each(['topic_research', 'inspect_video'] as const)('supports the same result contract for %s', intent => {
    const run = completedRun(); run.result!.intent = intent;
    expect(compactAgentRunSchema.safeParse(compactAgentRun(run)).success).toBe(true);
    expect(compactAgentRun(run).result?.outcome).toBe('answered');
  });

  it('uses stored video titles without exposing uncited discovery candidates', () => {
    const run = completedRun();
    for (const citation of run.result!.citations) delete citation.title;
    run.result!.artifacts = [{ type: 'youtube_search_candidates', data: { candidates: [
      { type: 'video', id: 'video000001', title: 'Design tutorial' },
      { type: 'video', id: 'video000099', title: 'Unreviewed result' },
      { type: 'channel', id: 'video000002', title: 'Wrong entity' },
      { type: 'video', title: 12 },
    ] } }];
    const sources = compactAgentRun(run).result!.sources;
    expect(sources[0]?.title).toBe('Design tutorial');
    expect(sources[1]?.title).toBe('YouTube video video000002');
    expect(sources).toHaveLength(2);
  });

  it('includes requested details with evidence pointing to compact source ids', () => {
    const run = completedRun();
    const response = compactAgentRun(run, ['artifacts', 'evidence', 'diagnostics']);
    expect(response.result?.artifacts).toEqual(run.result?.artifacts);
    expect(response.result?.evidence?.map(c => c.sourceId)).toEqual(['1', '1', '2']);
    expect(response.result?.evidence?.[0]).toMatchObject({ id: 'a', excerpt: 'A', startMs: 100 });
    expect(response.diagnostics).toMatchObject({ modelStepCount: 2, toolCallCount: 5, route: run.route });
  });

  it.each([
    ['NO_CONTENT_EVIDENCE', 'insufficient_evidence'], ['PARTIAL_EVIDENCE', 'partial'],
    ['RESEARCH_COVERAGE_SHORTFALL', 'partial'], ['TRANSCRIPT_ANALYST_WARNING', 'answered'],
  ])('maps %s to %s', (code, outcome) => {
    const run = completedRun(); run.result!.warnings = [{ code, message: 'Limitation' }];
    expect(compactAgentRun(run).result?.outcome).toBe(outcome);
  });

  it('prioritizes insufficient evidence over partial and handles clarification without sources', () => {
    const run = completedRun();
    run.result!.warnings = ['PARTIAL_EVIDENCE', 'NO_CONTENT_EVIDENCE'].map(code => ({ code, message: 'Unavailable' }));
    expect(compactAgentRun(run).result?.outcome).toBe('insufficient_evidence');
    run.result!.intent = 'clarification'; run.result!.answer = 'Which video?'; run.result!.citations = [];
    expect(compactAgentRun(run).result).toMatchObject({ outcome: 'needs_clarification', sources: [] });
  });

  it('reports scope rejection separately from an answer or a clarification', () => {
    const run = completedRun();
    run.result!.intent = 'rejected';
    run.result!.answer = 'I can research YouTube videos, but cannot make bookings.';
    run.result!.citations = [];
    run.route = { route: 'rejected', reason: 'Bookings are outside the supported scope.' };
    expect(compactAgentRun(run, ['diagnostics'])).toMatchObject({ status: 'completed',
      result: { outcome: 'rejected', sources: [] }, diagnostics: { route: run.route } });
  });

  it.each(['pending', 'running', 'failed', 'cancelled'] as const)('keeps %s state without inventing a result or billing', status => {
    const run = completedRun(); delete run.result; run.status = status;
    if (status === 'failed') run.error = 'Provider unavailable';
    const response = compactAgentRun(run);
    expect(response.status).toBe(status);
    expect(response).not.toHaveProperty('result'); expect(response).not.toHaveProperty('billing');
    if (status === 'failed') expect(response.error).toBe('Provider unavailable');
  });

  it('preserves non-video sources and rejects missing citation references', () => {
    const run = completedRun();
    run.result!.citations[0] = { id: 'a', sourceId: 'channel:A', provider: 'youtube', channelId: 'UC123', url: 'https://www.youtube.com/channel/UC123', excerpt: 'Channel information' };
    expect(compactAgentRun(run).result?.sources[1]).toMatchObject({ channelId: 'UC123', url: 'https://www.youtube.com/channel/UC123' });
    run.result!.answer = 'Unsupported [cite:missing]';
    expect(() => compactAgentRun(run)).toThrow('missing evidence');
  });

  it('defaults to compact and rejects invalid options', () => {
    expect(agentResponseOptionsSchema.parse({})).toEqual({ responseFormat: 'compact', include: [] });
    expect(agentResponseOptionsSchema.parse({ include: 'artifacts' })).toEqual({ responseFormat: 'compact', include: ['artifacts'] });
    expect(agentResponseOptionsSchema.parse({ responseFormat: 'legacy' })).toEqual({ responseFormat: 'legacy', include: [] });
    for (const input of [{ responseFormat: 'other' }, { responseFormat: 'legacy', include: 'artifacts' }, { responseFormat: 'compact', include: 'unknown' }]) {
      expect(agentResponseOptionsSchema.safeParse(input).success).toBe(false);
    }
  });
});
