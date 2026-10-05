import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { classifyCapabilityWithModel, type ClassificationDiagnostic } from '../src/agents/research/capability-router';
import type { TraceToolCall } from '../src/agents/runtime/tool-call-trace';
import type { CapabilityRouteDecision } from '../src/agents/contracts';

// Each call returns the next raw argument object exactly as given, without test defaults,
// so these cases see what the provider actually sent.
function rawClassifier(...payloads: Record<string, unknown>[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({ doGenerate: async () => {
    const payload = payloads[Math.min(call++, payloads.length - 1)]!;
    return { content: [{ type: 'tool-call', toolCallId: `classify-${call}`, toolName: 'classify_request', input: JSON.stringify(payload) }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
  } });
}

async function classify(message: string, model: MockLanguageModelV4) {
  const diagnostics: ClassificationDiagnostic[] = [];
  const traced: unknown[] = [];
  const traceToolCall: TraceToolCall = async execution => {
    traced.push(execution.input);
    return execution.execute();
  };
  const outcome: { decision?: CapabilityRouteDecision; error?: { code?: string; message: string } } = await classifyCapabilityWithModel({
    message, model, signal: new AbortController().signal, onDiagnostic: event => diagnostics.push(event), traceToolCall })
    .then(decision => ({ decision }), (error: { code?: string; message: string }) => ({ error }));
  return { ...outcome, diagnostics, traced, calls: model.doGenerateCalls.length };
}

const repairPrompt = (model: MockLanguageModelV4) => JSON.stringify(model.doGenerateCalls[1]?.prompt);

// Captured production arguments, trimmed only of user-specific reason text.
const production = {
  // Run be55b423, attempt 1.
  topicResearch: { answerDetail: 'standard', researchBreadth: 'comparative',
    searchQuery: 'MrBeast latest projects and news 2026', visualEvidence: 'none' },
  // Runs 5d3f5302 and 794f5142, attempt 1.
  inspectVideo: (videoId: string) => ({ answerDetail: 'standard',
    reason: 'User requests visual inspection of a single supplied YouTube video; route to inspect_video with required visual evidence.',
    videoId, visualEvidence: 'required', visualRequirements: ['exact frames at the requested timestamps'] }),
  // The same runs' repairs, whose keys carried leaked tool-call markup.
  corruptedRepair: (videoId: string, key: string) => ({ answerDetail: 'standard', [key]: videoId,
    visualEvidence: 'required', visualRequirements: ['exact frames at the requested timestamps'] }),
};
const validTopic = { route: 'topic_research', answerDetail: 'standard', researchBreadth: 'focused',
  searchQuery: 'event sourcing explained', visualEvidence: 'none' };

describe('classifier route recovery', () => {
  it('recovers the production topic research decision without a repair and traces the original arguments', async () => {
    const result = await classify('What is Mr beast upto these days', rawClassifier(production.topicResearch));
    expect(result.decision).toMatchObject({ route: 'topic_research', researchBreadth: 'comparative',
      searchQuery: 'MrBeast latest projects and news 2026' });
    expect(result.calls).toBe(1);
    expect(result.diagnostics).toEqual([expect.objectContaining({ attempt: 1, outcome: 'valid', defaultedFields: ['route'] })]);
    // The trace keeps what the provider sent, without the recovered route.
    expect(result.traced).toEqual([production.topicResearch]);
  });

  it.each([
    ['5d3f5302', 'dQw4w9WgXcQ'],
    ['794f5142', 'tXcT3OE7G1g'],
  ])('recovers the production inspection decision from run %s', async (_run, videoId) => {
    const result = await classify(`Extract exact frames from https://www.youtube.com/watch?v=${videoId} at six timestamps`,
      rawClassifier(production.inspectVideo(videoId)));
    expect(result.decision).toMatchObject({ route: 'inspect_video', videoId, visualEvidence: 'required' });
    expect(result.calls).toBe(1);
    expect(result.diagnostics[0]).toMatchObject({ outcome: 'valid', defaultedFields: ['route'] });
  });

  it.each([
    'inspect_video</arg_value><arg_key>videoId',
    'inspect_video<arg_key>videoId',
  ])('keeps corrupted keys invalid on both attempts: %s', async key => {
    const corrupted = production.corruptedRepair('dQw4w9WgXcQ', key);
    const result = await classify('Extract exact frames from https://www.youtube.com/watch?v=dQw4w9WgXcQ', rawClassifier(corrupted, corrupted));
    expect(result.error).toMatchObject({ code: 'AGENT_CLASSIFICATION_INVALID' });
    expect(result.calls).toBe(2);
    expect(result.diagnostics.every(event => !event.defaultedFields.includes('route'))).toBe(true);
  });

  it('does not let unknown keys pass beside otherwise recoverable discovery fields', async () => {
    const model = rawClassifier({ ...production.topicResearch, 'route</arg_value>': 'topic_research' }, validTopic);
    const result = await classify('What is Mr beast upto these days', model);
    expect(result.calls).toBe(2);
    expect(result.diagnostics[0]).toMatchObject({ outcome: 'invalid', defaultedFields: [] });
  });

  it.each([
    ['an explicit invalid route', { ...production.topicResearch, route: 'research' }],
    ['a null route', { ...production.topicResearch, route: null }],
    ['discovery fields beside a supplied video', { ...production.topicResearch, videoId: 'dQw4w9WgXcQ' }],
    ['discovery fields beside finalization fields', { ...production.topicResearch, responseIntent: 'rejected', reason: 'Unsupported.' }],
    ['a search query without breadth', { answerDetail: 'standard', searchQuery: 'event sourcing explained', visualEvidence: 'none' }],
    ['breadth without a search query', { answerDetail: 'standard', researchBreadth: 'focused', visualEvidence: 'none' }],
    ['comparison subjects alone', { answerDetail: 'standard', comparisonVideoIds: ['dQw4w9WgXcQ', 'tXcT3OE7G1g'], visualEvidence: 'none' }],
    ['a video ID that was never supplied', production.inspectVideo('aaaaaaaaaaa')],
    ['finalization without a reason', { answerDetail: 'standard', responseIntent: 'rejected' }],
    ['a context answer without its scope', { answerDetail: 'standard', responseIntent: 'context_answer', reason: 'Saved context suffices.' }],
    ['finalization that asks for fresh data', { answerDetail: 'standard', responseIntent: 'context_answer', contextScope: 'video',
      reason: 'Saved context suffices.', refreshDynamicData: true }],
  ])('sends %s to the repair instead of recovering a route', async (_case, payload) => {
    const model = rawClassifier(payload, validTopic);
    const message = 'Explain event sourcing, compare https://www.youtube.com/watch?v=dQw4w9WgXcQ with https://www.youtube.com/watch?v=tXcT3OE7G1g';
    const result = await classify(message, model);
    expect(result.calls).toBe(2);
    expect(result.diagnostics[0]).toMatchObject({ attempt: 1, outcome: 'invalid' });
    expect(result.diagnostics[0]!.defaultedFields).not.toContain('route');
    expect(repairPrompt(model)).toContain('classificationRepair');
  });

  it('recovers a finalization decision only when its required fields are present', async () => {
    const result = await classify('Write a sorting function in Python',
      rawClassifier({ answerDetail: 'standard', responseIntent: 'rejected', reason: 'Standalone coding is not supported.' }));
    expect(result.decision).toMatchObject({ route: 'finalize', responseIntent: 'rejected' });
    expect(result.calls).toBe(1);
    expect(result.diagnostics[0]).toMatchObject({ outcome: 'valid', defaultedFields: ['route'] });
  });

  it('still applies every semantic check to a recovered route', async () => {
    // Recovery selects topic_research, then the dotted-number check rejects the changed version.
    const changedVersion = rawClassifier({ answerDetail: 'standard', researchBreadth: 'focused',
      searchQuery: 'Opus 4.5 tips and prompting guide', visualEvidence: 'none' }, { ...validTopic, searchQuery: 'Opus 5.5 tips and prompting guide' });
    const numeric = await classify('How do I get the most out of Opus 5.5?', changedVersion);
    expect(numeric.calls).toBe(2);
    expect(numeric.diagnostics[0]).toMatchObject({ outcome: 'invalid', defaultedFields: ['route'],
      issues: [{ path: 'searchQuery', code: 'changed_numeric_constraint' }] });
    expect(numeric.decision).toMatchObject({ searchQuery: 'Opus 5.5 tips and prompting guide' });

    // Recovery selects topic_research, then the conditional requirement for visual facts applies.
    const missingRequirements = rawClassifier({ answerDetail: 'standard', researchBreadth: 'focused',
      searchQuery: 'presenter outfits keynote', visualEvidence: 'required' }, validTopic);
    const visual = await classify('What did the keynote presenters wear?', missingRequirements);
    expect(visual.calls).toBe(2);
    expect(visual.diagnostics[0]).toMatchObject({ outcome: 'invalid', defaultedFields: ['route'],
      issues: [expect.objectContaining({ path: 'visualRequirements' })] });
  });

  it('records the recovered route alongside other defaults', async () => {
    const result = await classify('What is Mr beast upto these days',
      rawClassifier({ ...production.topicResearch, answerDetail: 'unknown' }));
    expect(result.decision).toMatchObject({ route: 'topic_research', answerDetail: 'standard' });
    expect(result.diagnostics[0]).toMatchObject({ outcome: 'valid', defaultedFields: ['answerDetail', 'route'] });
    expect(result.traced).toEqual([{ ...production.topicResearch, answerDetail: 'unknown' }]);
  });
});
