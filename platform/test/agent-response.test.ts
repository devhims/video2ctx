import { compactAgentRun, compactAgentRunSchema, agentResponseOptionsSchema, legacyAgentRun } from '../src/agents/response';
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
  it('exposes the stored request for every run state without regenerating it', () => {
    for (const status of ['pending', 'running', 'completed', 'failed', 'cancelled'] as const) {
      const run = completedRun();
      run.status = status;
      Object.assign(run, { request: { message: 'Compare these models exactly as requested.' } });
      expect(compactAgentRun(run)).toHaveProperty('request.message', 'Compare these models exactly as requested.');
    }
  });

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

  it('reports internal research coverage without marking a fulfilled answer partial', () => {
    const run = completedRun();
    run.route = { route: 'topic_research', researchVideoCount: 4 };
    run.result!.artifacts.push({ type: 'research_coverage', data: { targetVideos: 4, reviewedVideos: 3 } });
    const result = compactAgentRun(run).result!;
    expect(result.outcome).toBe('answered');
    expect(result.coverage).toEqual({ targetVideos: 4, reviewedVideos: 3 });
    run.result!.warnings.push({ code: 'PARTIAL_EVIDENCE', message: 'User requested four source videos; three reviewed.' });
    expect(compactAgentRun(run).result?.outcome).toBe('partial');
  });
  it('preserves video identity on source caveats in compact responses', () => {
    const run = completedRun();
    run.result!.warnings = [{ code: 'TRANSCRIPT_ANALYST_WARNING', message: 'No cost figures in this video.', videoId: 'video000001' }];
    expect(compactAgentRun(run).result?.warnings[0]).toMatchObject({ videoId: 'video000001' });
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
    ['RESEARCH_COVERAGE_SHORTFALL', 'answered'], ['FINAL_SYNTHESIS_UNAVAILABLE', 'partial'], ['CHANNEL_INSPECTION_INCOMPLETE', 'partial'], ['ANSWER_SCOPE_SHORTFALL', 'partial'], ['TRANSCRIPT_ANALYST_WARNING', 'answered'],
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

it('exposes private rejection captures only when compact diagnostics are requested', () => {
  const run = completedRun();
  run.transcriptDiagnostics = [{ version: 1, stage: 'transcript_analysis', videoId: 'abcdefghijk',
    modelCallId: 'analyst:tool', attemptId: '47c2710a-83e1-4c41-889e-41f2699f2293', attempt: 1,
    recordedAt: 100, outcome: 'rejected', elapsedMs: 15000, code: 'GROUNDING_REJECTED',
    repairFeedback: 'Unsupported entity PrivateName', rejectedOutput: 'Private rejected model content',
    issues: [{ code: 'ENTITY_NOT_SUPPORTED', findingIndex: 0, message: 'Unsupported entity PrivateName' }] }];
  const original = JSON.stringify(run);
  expect(JSON.stringify(compactAgentRun(run))).not.toContain('Private');
  expect(JSON.stringify(compactAgentRun(run, ['evidence', 'artifacts']))).not.toContain('Private');
  expect(compactAgentRun(run, ['diagnostics']).diagnostics?.transcriptAnalysis).toEqual(run.transcriptDiagnostics);
  expect(JSON.stringify(run)).toBe(original);
});


it('returns sessionId in both response formats and nested legacy results without changing storage', () => {
  const run = completedRun();
  const before = structuredClone(run);
  for (const response of [compactAgentRun(run), legacyAgentRun(run)]) {
    expect(response.sessionId).toBe(run.conversationId);
    expect(response).not.toHaveProperty('conversationId');
    expect(response.result).not.toHaveProperty('conversationId');
  }
  expect(legacyAgentRun(run).result?.sessionId).toBe(run.conversationId);
  expect(run).toEqual(before);
});
